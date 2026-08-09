import { once } from "node:events";

interface HahaMessage {
  type?: string;
  text?: string;
  state?: string;
  verb?: string;
  blockType?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
  requestId?: string;
  usage?: Record<string, unknown>;
  subtype?: string;
  modelId?: string;
  data?: Record<string, unknown>;
  message?: string;
  error?: unknown;
}

interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

const sessionId = required("HAHA_SESSION_ID");
const baseUrl = required("HAHA_SERVER_URL");
const providerId = required("HAHA_PROVIDER_ID");
const modelId = required("HAHA_MODEL_ID");
const effortLevel = process.env.HAHA_EFFORT || "medium";
const permissionMode = process.env.HAHA_PERMISSION_MODE || "bypassPermissions";
const timeoutMs = Number(process.env.HAHA_TURN_TIMEOUT_MS || 30 * 60_000);
const prompt = await readStdin();

if (!prompt.trim()) fail("Relay sent an empty Haha prompt.");

const socketUrl = new URL(baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
socketUrl.pathname = `${socketUrl.pathname.replace(/\/$/, "")}/ws/${encodeURIComponent(sessionId)}`;

const WebSocketImpl = (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket;
if (!WebSocketImpl) fail("This runtime does not provide WebSocket support.");

const socket = new WebSocketImpl(socketUrl.toString());
let finalText = "";
let model = modelId;
let usage: Record<string, unknown> = {};
let turnStarted = false;
let messageCompleted = false;
let settled = false;

const send = (message: unknown) => socket.send(JSON.stringify(message));
const emit = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const finish = (error?: string) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (error) {
    emit({ type: "result", is_error: true, result: error, error });
    process.exitCode = 1;
  } else {
    emit({
      type: "result",
      is_error: false,
      result: finalText.trim(),
      usage,
      modelUsage: {
        [model]: {
          inputTokens: numberValue(usage.input_tokens),
          outputTokens: numberValue(usage.output_tokens),
          cacheReadInputTokens: numberValue(usage.cache_read_input_tokens ?? usage.cache_read_tokens),
          cacheCreationInputTokens: numberValue(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens),
        },
      },
      session_id: sessionId,
    });
  }
  socket.close();
};

const timeout = setTimeout(() => {
  try { send({ type: "stop_generation" }); } catch {}
  finish(`Haha desktop turn timed out after ${Math.round(timeoutMs / 60_000)} minutes.`);
}, timeoutMs);

socket.onopen = () => {
  send({ type: "set_runtime_config", providerId, modelId, effortLevel });
  send({ type: "set_permission_mode", mode: permissionMode });
  send({ type: "user_message", content: prompt, attachments: [] });
};

socket.onmessage = (event) => {
  let message: HahaMessage;
  try {
    message = JSON.parse(String(event.data)) as HahaMessage;
  } catch {
    return;
  }

  if (message.type === "status" && message.state && message.state !== "idle") turnStarted = true;
  if (message.type === "content_delta" && typeof message.text === "string") finalText += message.text;
  if (message.type === "content_start" && message.blockType === "tool_use") {
    emit({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: message.toolName || "tool",
          id: message.toolUseId,
          input: message.input ?? {},
        }],
      },
    });
  }
  if (message.type === "tool_result") {
    emit({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: message.toolUseId,
          content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
          is_error: message.isError === true,
        }],
      },
    });
  }
  if (message.type === "system_notification" && message.subtype === "init") {
    const announced = message.data?.model;
    if (typeof announced === "string" && announced.trim()) model = announced;
  }
  if (message.type === "system_notification" && message.subtype === "session_state_changed") {
    const state = message.data?.state;
    if (state === "running") turnStarted = true;
    if (state === "idle" && turnStarted && messageCompleted) finish();
  }
  if (message.type === "message_complete") {
    usage = message.usage ?? {};
    messageCompleted = true;
    if (turnStarted) setTimeout(() => finish(), 250);
  }
  if (message.type === "error" || message.type === "fatal_error") {
    finish(readError(message));
  }
};

socket.onerror = (event) => finish(event.message || "Haha desktop WebSocket failed.");
socket.onclose = (event) => {
  if (!settled) finish(`Haha desktop WebSocket closed before completion (${event.code ?? "unknown"}).`);
};

const stop = () => {
  try { send({ type: "stop_generation" }); } catch {}
  finish("Haha desktop turn was cancelled.");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

await once(process, "beforeExit");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readError(message: HahaMessage) {
  if (typeof message.message === "string") return message.message;
  if (typeof message.error === "string") return message.error;
  if (message.error) return JSON.stringify(message.error);
  return "Haha desktop reported an unknown error.";
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
