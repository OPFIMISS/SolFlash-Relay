import { lstat, rm } from "node:fs/promises";
import path from "node:path";

import type { AgentDefinition, RelayTask } from "../shared/types.js";
import { buildAgentRun } from "./agent-runner.js";
import { config } from "./config.js";

const root = path.join(config.dataDir, "agent-runner-test");
const workdir = path.resolve(".");
const haha: AgentDefinition = {
  id: "claude-haha",
  label: "Claude Code Haha",
  role: "executor",
  transport: "haha-sidecar",
  enabled: true,
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  defaultModel: "deepseek-v4-flash",
};
const task = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  projectName: path.basename(workdir),
  requestedModel: "deepseek-v4-flash",
  effectiveModel: null,
  modelWarning: null,
  request: {
    title: "Adapter path test",
    objective: "Do not run",
    workdir,
    allowedFiles: ["README.md"],
    executorAgent: "claude-haha",
    model: "deepseek-v4-flash",
    effort: "high",
  },
} as RelayTask;

await rm(root, { recursive: true, force: true });
try {
  const visible = await buildAgentRun(
    { ...config, hahaShareDesktopState: true },
    haha,
    task,
    "test",
    true,
  );
  if (visible.cwd !== workdir) throw new Error("Haha run did not preserve the exact planner workdir");
  if (visible.cliModel !== "deepseek-v4-flash") {
    throw new Error(`Expected Haha desktop runtime to receive Flash, received ${visible.cliModel}`);
  }
  if (visible.env.HAHA_SESSION_ID !== task.sessionId || visible.env.HAHA_MODEL_ID !== "deepseek-v4-flash") {
    throw new Error("Visible Haha task is not targeting the adopted desktop session and model");
  }
  if (!visible.args.some((item) => item.endsWith("haha-live-worker.js"))) {
    throw new Error("Visible Haha task is not using the desktop WebSocket worker");
  }
  if (visible.env.HAHA_EFFORT !== "high") {
    throw new Error("Task effort was not forwarded to Haha");
  }

  const isolatedState = path.join(root, "haha-state");
  const isolated = await buildAgentRun(
    { ...config, hahaShareDesktopState: false, hahaStateDir: isolatedState },
    haha,
    task,
    "test",
    false,
  );
  const stateInfo = await lstat(path.join(isolatedState, "cc-haha"));
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new Error("Isolated Haha state must be a real directory, not a junction to desktop data");
  }
  if (isolated.env.CLAUDE_CONFIG_DIR !== isolatedState) {
    throw new Error("Isolated run did not use the isolated state directory");
  }

  const custom: AgentDefinition = {
    id: "custom-worker",
    label: "Custom intermediary worker",
    role: "executor",
    transport: "custom-cli",
    enabled: true,
    command: "worker-cli",
    models: ["sol", "luna"],
    defaultModel: "luna",
    args: ["run", "--model", "{model}", "--project", "{workdir}", "--session", "{sessionId}"],
    promptTransport: "stdin",
    outputFormat: "jsonl",
  };
  const customTask = {
    ...task,
    requestedModel: "luna",
    request: { ...task.request, executorAgent: custom.id, model: "luna" },
  };
  const customRun = await buildAgentRun(config, custom, customTask, "custom prompt", false);
  if (customRun.command !== "worker-cli" || !customRun.args.includes("luna") || customRun.cwd !== workdir) {
    throw new Error("Custom intermediary Agent did not preserve model and project path");
  }
  if (customRun.prompt !== "custom prompt" || customRun.outputFormat !== "jsonl") {
    throw new Error("Custom Agent prompt transport or output format is incorrect");
  }

  const opencode: AgentDefinition = {
    id: "opencode",
    label: "OpenCode",
    role: "executor",
    transport: "opencode-cli",
    enabled: true,
    command: "opencode",
    models: ["openrouter/luna"],
    defaultModel: "openrouter/luna",
  };
  const opencodeRun = await buildAgentRun(
    config,
    opencode,
    { ...task, requestedModel: "openrouter/luna", request: { ...task.request, executorAgent: opencode.id, model: "openrouter/luna" } },
    "opencode prompt",
    false,
  );
  if (!opencodeRun.args.includes("openrouter/luna") || !opencodeRun.args.includes(workdir)) {
    throw new Error("OpenCode adapter did not receive the selected intermediary model and workdir");
  }

  console.log(JSON.stringify({
    ok: true,
    workdir,
    cliModel: visible.cliModel,
    effort: "high",
    isolated: true,
    customModel: customRun.cliModel,
    opencodeModel: opencodeRun.cliModel,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
