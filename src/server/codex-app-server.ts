import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import type { RelayUsage } from "../shared/types.js";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface ThreadResult {
  thread: { id: string };
}

interface TurnStartResult {
  turn: { id: string };
}

interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string; error?: { message?: string } | null };
}

interface ItemCompletedParams {
  threadId: string;
  turnId: string;
  item: { type: string; text?: string };
}

interface TokenUsageParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    last: {
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      outputTokens: number;
    };
  };
}

export interface CodexAppTurnResult {
  threadId: string;
  finalResponse: string;
  usage: RelayUsage;
}

export class CodexAppServer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #notifications: JsonRpcMessage[] = [];
  readonly #waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #nextId = 1;
  #stderr = "";

  constructor() {
    this.#child = spawn(resolveCodexPath(), [
      "app-server",
      "--stdio",
      "-c",
      "mcp_servers.sol_flash_relay.enabled=false",
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-16_000);
    });
    this.#child.on("error", (error) => this.#failAll(error));
    this.#child.on("close", (code) => {
      if (code !== 0) this.#failAll(new Error(`Codex app-server exited with code ${code}: ${this.#stderr.trim()}`));
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "sol-flash-relay", title: "SolFlash Relay", version: "0.6.4" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  async startThread(options: { cwd: string; model: string; effort: string; title: string }) {
    const response = await this.request<ThreadResult>("thread/start", {
      cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd],
      model: options.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      historyMode: "paginated",
      threadSource: "sol-flash-relay",
      config: { mcp_servers: { sol_flash_relay: { enabled: false } } },
    });
    await this.request("thread/name/set", { threadId: response.thread.id, name: options.title });
    return response.thread.id;
  }

  async resumeThread(threadId: string, options: { cwd: string; model: string }) {
    await this.request("thread/resume", {
      threadId,
      cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd],
      model: options.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { mcp_servers: { sol_flash_relay: { enabled: false } } },
      excludeTurns: true,
    });
  }

  async runTurn(options: {
    threadId: string;
    prompt: string;
    model: string;
    effort: string;
    outputSchema: unknown;
    onProgress?: (message: string) => Promise<void>;
  }) {
    let finalResponse = "";
    let progressQueue = Promise.resolve();
    let usage: RelayUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      model: options.model,
    };
    const response = await this.request<TurnStartResult>("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      model: options.model,
      effort: options.effort === "max" ? "xhigh" : options.effort,
      approvalPolicy: "never",
      outputSchema: options.outputSchema,
    });
    const turnId = response.turn.id;
    const completed = await this.waitFor((message) => {
      if (message.method === "item/completed") {
        const params = message.params as unknown as ItemCompletedParams;
        if (params.threadId === options.threadId && params.turnId === turnId && params.item.type === "agentMessage") {
          finalResponse = params.item.text ?? finalResponse;
          if (params.item.text?.trim() && options.onProgress) {
            const progress = params.item.text;
            progressQueue = progressQueue
              .then(() => options.onProgress?.(progress))
              .catch((error) => {
                this.#stderr = `${this.#stderr}\nPlanner progress callback failed: ${String(error)}`.slice(-16_000);
              });
          }
        }
      }
      if (message.method === "thread/tokenUsage/updated") {
        const params = message.params as unknown as TokenUsageParams;
        if (params.threadId === options.threadId && params.turnId === turnId) {
          usage = {
            inputTokens: params.tokenUsage.last.inputTokens,
            outputTokens: params.tokenUsage.last.outputTokens,
            cacheReadTokens: params.tokenUsage.last.cachedInputTokens,
            cacheCreationTokens: params.tokenUsage.last.cacheWriteInputTokens,
            costUsd: 0,
            model: options.model,
          };
        }
      }
      if (message.method !== "turn/completed") return false;
      const params = message.params as unknown as TurnCompletedParams;
      return params.threadId === options.threadId && params.turn.id === turnId;
    }, 30 * 60_000);
    const params = completed.params as unknown as TurnCompletedParams;
    if (params.turn.status !== "completed") {
      throw new Error(params.turn.error?.message ?? `Codex turn ended with ${params.turn.status}.`);
    }
    await progressQueue;
    if (!finalResponse.trim()) throw new Error("Codex app-server completed without a final response.");
    return { threadId: options.threadId, finalResponse, usage };
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>) {
    this.#write(params ? { method, params } : { method });
  }

  waitFor(predicate: (message: JsonRpcMessage) => boolean, timeoutMs: number) {
    const existing = this.#notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonRpcMessage) => {
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          resolve(message);
        },
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out waiting for Codex app-server notification. ${this.#stderr.trim()}`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  close() {
    if (!this.#child.killed) this.#child.kill();
  }

  #handleLine(line: string) {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.#stderr = `${this.#stderr}\n${line}`.slice(-16_000);
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#write({ id: message.id, error: { code: -32601, message: `Relay does not handle server request ${message.method}.` } });
      return;
    }
    this.#notifications.push(message);
    if (this.#notifications.length > 500) this.#notifications.shift();
    for (const waiter of [...this.#waiters]) {
      if (waiter.predicate(message)) waiter.resolve(message);
    }
  }

  #write(message: JsonRpcMessage) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #failAll(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

const resolveCodexPath = () => {
  const packageRelative = path.join(
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  const candidates = process.versions.electron
    ? [path.join(process.resourcesPath, "app.asar.unpacked", packageRelative)]
    : [path.resolve(packageRelative)];
  const resolved = candidates.find(existsSync);
  if (!resolved) throw new Error("Bundled Codex app-server binary was not found.");
  return resolved;
};
