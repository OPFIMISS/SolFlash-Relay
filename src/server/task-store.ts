import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConversationMessage, RelayEvent, RelayTask } from "../shared/types.js";

interface PersistedState {
  version: 1;
  tasks: RelayTask[];
}

export class TaskStore extends EventEmitter {
  readonly #filePath: string;
  readonly #tasks = new Map<string, RelayTask>();
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    super();
    this.#filePath = path.join(dataDir, "tasks.json");
  }

  async load() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const state = JSON.parse(raw) as PersistedState;
      for (const task of state.tasks ?? []) {
        task.projectName ??= path.basename(task.request.workdir);
        task.request.plannerAgent ??= "codex";
        task.request.plannerModel ??= "gpt-5.6-sol";
        task.request.executorAgent ??= "claude-haha";
        task.requestedModel ??= task.request.model ?? "deepseek-v4-flash";
        task.effectiveModel ??= task.usage.model;
        task.modelWarning ??= null;
        task.unread ??= false;
        task.messages ??= migrateMessages(task);
        task.origin ??= "relay";
        task.workflowMode ??= "direct";
        task.workflowPhase ??= task.status === "completed" ? "completed" : "executor-run";
        task.plannerThreadId ??= null;
        task.plannerRounds ??= 0;
        task.plannerUsage ??= {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          model: task.request.plannerModel ?? null,
        };
        if (task.status === "running" || task.status === "waiting") {
          task.status = "failed";
          task.error = "Relay restarted while this task was active.";
          task.finishedAt = new Date().toISOString();
        }
        this.#tasks.set(task.id, task);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list() {
    return [...this.#tasks.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string) {
    return this.#tasks.get(id) ?? null;
  }

  async set(task: RelayTask) {
    task.updatedAt = new Date().toISOString();
    this.#tasks.set(task.id, task);
    await this.#persist();
    this.emit("task", task);
    return task;
  }

  async delete(id: string) {
    if (!this.#tasks.delete(id)) return false;
    await this.#persist();
    this.emit("task-deleted", id);
    return true;
  }

  async appendEvent(taskId: string, event: RelayEvent) {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    task.events = [...task.events, event].slice(-500);
    task.updatedAt = event.timestamp;
    await this.#persist();
    this.emit("event", event);
    this.emit("task", task);
    return task;
  }

  async appendMessage(taskId: string, message: AgentConversationMessage) {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    task.messages = [...task.messages, message].slice(-200);
    task.updatedAt = message.timestamp;
    await this.#persist();
    this.emit("task", task);
    return task;
  }

  waitForUpdate(taskId: string, afterUpdatedAt: string, timeoutMs: number) {
    const current = this.get(taskId);
    if (!current) return Promise.resolve(null);
    if (current.updatedAt !== afterUpdatedAt || isTerminal(current.status)) {
      return Promise.resolve(current);
    }

    return new Promise<RelayTask | null>((resolve) => {
      const onTask = (task: RelayTask) => {
        if (task.id !== taskId || task.updatedAt === afterUpdatedAt) return;
        cleanup();
        resolve(task);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.get(taskId));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("task", onTask);
      };
      this.on("task", onTask);
    });
  }

  async #persist() {
    this.#persistQueue = this.#persistQueue
      .catch(() => undefined)
      .then(async () => {
        const state: PersistedState = { version: 1, tasks: this.list() };
        const temporary = `${this.#filePath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
        await rm(this.#filePath, { force: true });
        await rename(temporary, this.#filePath);
      });
    await this.#persistQueue;
  }
}

export const isTerminal = (status: RelayTask["status"]) =>
  status === "completed" || status === "failed" || status === "cancelled";

const migrateMessages = (task: RelayTask): AgentConversationMessage[] => {
  const messages: AgentConversationMessage[] = [{
    id: `migrated-planner-${task.id}`,
    role: "planner",
    agent: task.request.plannerAgent ?? "codex",
    model: task.request.plannerModel ?? "gpt-5.6-sol",
    timestamp: task.createdAt,
    content: task.request.objective,
    kind: "instruction",
  }];
  if (task.summary) {
    messages.push({
      id: `migrated-executor-${task.id}`,
      role: "executor",
      agent: task.request.executorAgent ?? "claude-haha",
      model: task.effectiveModel ?? task.requestedModel,
      timestamp: task.finishedAt ?? task.updatedAt,
      content: task.summary,
      kind: task.status === "failed" ? "error" : "result",
    });
  }
  return messages;
};
