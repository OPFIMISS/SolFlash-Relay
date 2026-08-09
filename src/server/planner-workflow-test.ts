import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { HahaSessionSummary, RelayTask } from "../shared/types.js";
import { config } from "./config.js";
import type { PlannerRunner } from "./planner-runner.js";
import { SettingsStore } from "./settings-store.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";

const execFileAsync = promisify(execFile);
const root = path.join(config.dataDir, "planner-workflow-test");
const workdir = path.join(root, "workspace");
await rm(root, { recursive: true, force: true });
await mkdir(workdir, { recursive: true });
await writeFile(path.join(workdir, "README.md"), "existing Flash scaffold\n", "utf8");
await execFileAsync("git", ["init"], { cwd: workdir, windowsHide: true });

const testConfig = { ...config, dataDir: path.join(root, "state") };
const store = new TaskStore(testConfig.dataDir);
await store.load();
const settings = new SettingsStore(testConfig.dataDir);
await settings.load();
const localAgent = {
  id: "planner-workflow-executor",
  label: "Planner workflow executor",
  role: "executor" as const,
  transport: "custom-cli" as const,
  enabled: true,
  command: "cmd.exe",
  models: ["local-test"],
  defaultModel: "local-test",
  args: ["/d", "/s", "/c", "echo FLASH_FIXED"],
  outputFormat: "text" as const,
  promptTransport: "stdin" as const,
};
await settings.upsertAgent(localAgent);
await settings.save({
  ...settings.get(),
  executorAgent: localAgent.id,
  executorModel: localAgent.defaultModel,
});

const planner: PlannerRunner = {
  async planTask() {
    return {
      threadId: "codex-planner-led-test",
      summary: "Planner created the architecture and bounded implementation plan.",
      instruction: "Return FLASH_FIXED without changing files.",
      usage: { inputTokens: 90, outputTokens: 18, cacheReadTokens: 35, cacheCreationTokens: 0, costUsd: 0, model: "gpt-5.6-sol" },
    };
  },
  async reviewAdoption() {
    return {
      threadId: "codex-thread-test",
      summary: "Sol inspected the project and found one bounded correction.",
      instruction: "Return FLASH_FIXED without changing files.",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 0, costUsd: 0, model: "gpt-5.6-sol" },
    };
  },
  async continueReview() {
    throw new Error("continueReview should not run in this test");
  },
  async verifyImplementation() {
    return {
      threadId: "codex-thread-test",
      verdict: "pass",
      summary: "Sol reviewed the executor result and accepted it.",
      instruction: "",
      usage: { inputTokens: 80, outputTokens: 15, cacheReadTokens: 30, cacheCreationTokens: 0, costUsd: 0, model: "gpt-5.6-sol" },
    };
  },
};

const manager = new TaskManager(testConfig, store, settings, planner);
const session: HahaSessionSummary = {
  sessionId: "8514b596-c362-42a4-9f0b-7c9c9c451cd3",
  title: "Existing Haha scaffold",
  workdir,
  model: "deepseek-v4-flash",
  updatedAt: new Date().toISOString(),
  lastPrompt: "Build the scaffold",
  lastResponse: "Scaffold complete",
  changedFiles: ["README.md"],
};

const started = await manager.adopt(session, ["README.md"], "Review the existing Flash scaffold before correcting it.");
const deadline = Date.now() + 15_000;
let task: RelayTask | null = started;
while (Date.now() < deadline) {
  task = manager.get(started.id);
  if (task && ["completed", "failed", "cancelled"].includes(task.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!task || task.status !== "completed") throw new Error(`Planner workflow failed: ${task?.error ?? task?.status ?? "missing"}`);
if (task.plannerThreadId !== "codex-thread-test") throw new Error("Persistent Codex thread ID was not stored");
if (task.workflowPhase !== "completed" || task.plannerRounds !== 2) throw new Error("Planner workflow phases did not close correctly");
if (!task.summary.includes("FLASH_FIXED")) throw new Error("Executor did not receive the planner correction");
if (task.sessionId !== session.sessionId) throw new Error("Adopted Haha session ID changed");
if (!task.messages.some((message) => message.role === "planner" && message.content.includes("Sol inspected"))) {
  throw new Error("Sol review was not shown in planner conversation A");
}
if (!task.messages.some((message) => message.role === "planner" && message.content.includes("accepted"))) {
  throw new Error("Sol final verification was not returned to planner conversation A");
}

console.log(JSON.stringify({
  ok: true,
  status: task.status,
  workflowPhase: task.workflowPhase,
  plannerThreadId: task.plannerThreadId,
  plannerRounds: task.plannerRounds,
  hahaSessionId: task.sessionId,
  summary: task.summary.trim(),
}));

const plannerLed = await manager.startPlannerLed({
  title: "Planner-led new task",
  objective: "Plan first, then ask the executor for a harmless response.",
  workdir: "",
  allowedFiles: [],
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: localAgent.id,
  model: localAgent.defaultModel,
  effort: "low",
  reviewAfterExecution: false,
});
const plannerLedDeadline = Date.now() + 15_000;
let plannerLedTask: RelayTask | null = plannerLed;
while (Date.now() < plannerLedDeadline) {
  plannerLedTask = manager.get(plannerLed.id);
  if (plannerLedTask && ["completed", "failed", "cancelled"].includes(plannerLedTask.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!plannerLedTask || plannerLedTask.status !== "completed") {
  throw new Error(`Planner-led task failed: ${plannerLedTask?.error ?? plannerLedTask?.status ?? "missing"}`);
}
if (plannerLedTask.plannerThreadId !== "codex-planner-led-test" || plannerLedTask.workflowMode !== "planner-led") {
  throw new Error("Planner-led task did not persist its real planner identity");
}
if (!plannerLedTask.request.workdir.includes("planner-workflow-test") || plannerLedTask.request.allowedFiles[0] !== ".") {
  throw new Error("Blank-path task did not create a Relay-managed workspace with project-wide scope");
}
if (plannerLedTask.sessionId === session.sessionId) throw new Error("New planner-led task reused an adopted Haha session ID");

await rm(root, { recursive: true, force: true });
