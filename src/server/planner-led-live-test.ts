import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { RelayTask } from "../shared/types.js";
import { config } from "./config.js";
import { SettingsStore } from "./settings-store.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";

if (process.env.ALLOW_PAID_PLANNER_LED_E2E !== "1") {
  throw new Error("Set ALLOW_PAID_PLANNER_LED_E2E=1 to run the real Codex → Haha → Codex workflow.");
}

const root = path.join(config.dataDir, "planner-led-live-test");
const workdir = path.join(root, "workspace");
const proof = "relay-planner-led-proof.txt";
await rm(root, { recursive: true, force: true });
await mkdir(workdir, { recursive: true });

const testConfig = {
  ...config,
  dataDir: path.join(root, "state"),
  hahaShareDesktopState: true,
};
const store = new TaskStore(testConfig.dataDir);
await store.load();
const settings = new SettingsStore(testConfig.dataDir);
await settings.load();
await settings.save({
  ...settings.get(),
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: "claude-haha",
  executorModel: "deepseek-v4-flash",
  executorEffort: "low",
});
const manager = new TaskManager(testConfig, store, settings);
const started = await manager.startPlannerLed({
  title: "SolFlash Relay full planner workflow probe",
  objective: `Create ${proof} containing exactly PLANNER_FLASH_SOL_OK followed by a newline. This is a minimal integration probe.`,
  workdir,
  allowedFiles: [proof],
  constraints: ["Do not modify any other file.", "Do not commit."],
  acceptanceCommands: [],
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: "claude-haha",
  model: "deepseek-v4-flash",
  effort: "low",
  reviewAfterExecution: true,
});

const deadline = Date.now() + 10 * 60_000;
let task: RelayTask | null = started;
while (Date.now() < deadline) {
  task = manager.get(started.id);
  if (task && ["completed", "failed", "cancelled"].includes(task.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!task || task.status !== "completed") {
  throw new Error(`Real planner-led workflow failed: ${task?.error ?? task?.status ?? "missing"}`);
}
const content = await readFile(path.join(workdir, proof), "utf8");
if (content !== "PLANNER_FLASH_SOL_OK\n") throw new Error(`Unexpected proof: ${JSON.stringify(content)}`);
if (!task.plannerThreadId) throw new Error("No real Codex planner thread was persisted");
if (task.effectiveModel !== "deepseek-v4-flash") throw new Error(`Expected Flash, received ${task.effectiveModel ?? "unknown"}`);
if ((task.plannerRounds ?? 0) < 2 || task.workflowPhase !== "completed") throw new Error("Sol did not perform final verification");

console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  plannerThreadId: task.plannerThreadId,
  hahaSessionId: task.sessionId,
  workdir,
  requestedModel: task.requestedModel,
  effectiveModel: task.effectiveModel,
  plannerRounds: task.plannerRounds,
  workflowPhase: task.workflowPhase,
  proof: content.trim(),
}));

if (process.env.KEEP_PLANNER_LED_E2E !== "1") await rm(root, { recursive: true, force: true });
