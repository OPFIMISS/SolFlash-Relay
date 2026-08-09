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
  },
} as RelayTask;

await rm(root, { recursive: true, force: true });
try {
  const visible = await buildAgentRun(
    { ...config, hahaShareDesktopState: true },
    haha,
    task,
    "test",
    false,
  );
  if (visible.cwd !== workdir) throw new Error("Haha run did not preserve the exact planner workdir");
  if (visible.cliModel !== "haiku") {
    throw new Error(`Expected Haha Flash to resolve through haiku, received ${visible.cliModel}`);
  }
  if (visible.env.CLAUDE_CONFIG_DIR !== config.hahaGlobalConfigDir) {
    throw new Error("Visible Haha task is not using the desktop session store");
  }
  if (!visible.args.includes(`${task.projectName} · ${task.request.title}`)) {
    throw new Error("Haha session name does not include the project and task names");
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
  console.log(JSON.stringify({ ok: true, workdir, cliModel: visible.cliModel, isolated: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
