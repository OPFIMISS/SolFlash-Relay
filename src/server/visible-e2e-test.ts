import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { RelayTask } from "../shared/types.js";
import { config } from "./config.js";
import { SettingsStore } from "./settings-store.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";

if (process.env.ALLOW_PAID_VISIBLE_E2E !== "1") {
  throw new Error("Set ALLOW_PAID_VISIBLE_E2E=1 to run the paid, user-visible Haha Flash check.");
}

const workdir = path.resolve(process.env.VISIBLE_E2E_WORKDIR ?? process.cwd());
const proofRelative = ".relay-data/visible-flash-proof/output.txt";
const dataDir = path.join(workdir, ".relay-data", "visible-e2e", "state");
await mkdir(path.dirname(path.join(workdir, proofRelative)), { recursive: true });

const testConfig = {
  ...config,
  dataDir,
  hahaStateDir: path.join(workdir, ".relay-data", "visible-e2e", "haha-state"),
  hahaShareDesktopState: true,
};
const store = new TaskStore(testConfig.dataDir);
await store.load();
const settings = new SettingsStore(testConfig.dataDir);
await settings.load();
const currentSettings = settings.get();
await settings.save({
  ...currentSettings,
  executorAgent: "claude-haha",
  executorModel: "deepseek-v4-flash",
  executorEffort: "low",
});
const manager = new TaskManager(testConfig, store, settings);

const task = await manager.start({
  title: "Visible Flash self-check",
  objective: `Create ${proofRelative} containing exactly FLASH_VISIBLE_OK followed by a newline, then reply with exactly FLASH_VISIBLE_OK.`,
  workdir,
  allowedFiles: [proofRelative],
  constraints: ["Do not modify any other file.", "Do not run package managers or tests."],
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: "claude-haha",
  model: "deepseek-v4-flash",
  effort: "low",
});

const deadline = Date.now() + 180_000;
let current: RelayTask | null = task;
while (Date.now() < deadline) {
  current = manager.get(task.id);
  if (current && ["completed", "failed", "cancelled"].includes(current.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (!current || current.status !== "completed") {
  throw new Error(`Visible Flash check failed: ${current?.error ?? current?.status ?? "missing"}`);
}
const proof = await readFile(path.join(workdir, proofRelative), "utf8");
if (proof.trim() !== "FLASH_VISIBLE_OK") {
  throw new Error(`Unexpected proof file: ${JSON.stringify(proof)}`);
}
if (!current.summary.includes("FLASH_VISIBLE_OK")) {
  throw new Error(`Flash returned no visible proof reply: ${JSON.stringify(current.summary)}`);
}
if (current.effectiveModel !== "deepseek-v4-flash") {
  throw new Error(`Requested Flash, but Haha reported ${current.effectiveModel ?? "no model"}.`);
}

console.log(JSON.stringify({
  ok: true,
  taskId: current.id,
  sessionId: current.sessionId,
  requestedModel: current.requestedModel,
  effectiveModel: current.effectiveModel,
  summary: current.summary,
  proofFile: path.join(workdir, proofRelative),
  costUsd: current.usage.costUsd,
}));
