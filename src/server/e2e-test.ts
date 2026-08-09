import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { RelayTask } from "../shared/types.js";
import { config } from "./config.js";
import { startHttpServer } from "./http.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";
import { TokenMonitorClient } from "./token-monitor.js";
import { SettingsStore } from "./settings-store.js";

const execFileAsync = promisify(execFile);
const root = path.join(config.dataDir, "e2e-test");
const workdir = path.join(root, "workspace");
const testConfig = {
  ...config,
  port: 17324,
  dataDir: path.join(root, "state"),
  hahaStateDir: path.join(root, "haha-state"),
  hahaShareDesktopState: false,
};

await rm(root, { recursive: true, force: true });
await mkdir(workdir, { recursive: true });
await writeFile(path.join(workdir, "seed.txt"), "USER_OWNED\n", "utf8");
await execFileAsync("git", ["init"], { cwd: workdir, windowsHide: true });

const store = new TaskStore(testConfig.dataDir);
await store.load();
const settings = new SettingsStore(testConfig.dataDir);
await settings.load();
const manager = new TaskManager(testConfig, store, settings);
const server = startHttpServer(
  testConfig,
  manager,
  store,
  new TokenMonitorClient(testConfig),
  settings,
);

await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

try {
  const task = await manager.start({
    title: "Relay E2E smoke test",
    objective: "Create output.txt containing exactly RELAY_E2E_OK followed by a newline.",
    workdir,
    allowedFiles: ["output.txt"],
    constraints: [
      "Do not modify seed.txt",
      "Do not create any other file",
    ],
    acceptanceCommands: [],
    model: "deepseek-v4-flash",
    effort: "low",
  });

  const deadline = Date.now() + 120_000;
  let current: RelayTask | null = task;
  while (Date.now() < deadline) {
    current = manager.get(task.id);
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!current || current.status !== "completed") {
    throw new Error(`E2E task did not complete: ${current?.error ?? current?.status ?? "missing"}`);
  }
  const output = await readFile(path.join(workdir, "output.txt"), "utf8");
  const seed = await readFile(path.join(workdir, "seed.txt"), "utf8");
  if (output !== "RELAY_E2E_OK\n") throw new Error(`Unexpected output.txt: ${JSON.stringify(output)}`);
  if (seed !== "USER_OWNED\n") throw new Error("Flash modified the user-owned seed file");
  if (current.scopeWarnings.length) {
    throw new Error(`Scope warnings: ${current.scopeWarnings.join(", ")}`);
  }
  if (current.effectiveModel !== "deepseek-v4-flash") {
    throw new Error(`Expected Flash but Haha reported ${current.effectiveModel ?? "no model"}`);
  }

  const firstCost = current.usage.costUsd;
  const originalSessionId = current.sessionId;
  await manager.send(
    current.id,
    "Replace output.txt with exactly RELAY_E2E_RESUMED_OK followed by a newline. Do not change any other file.",
  );

  const resumeDeadline = Date.now() + 120_000;
  while (Date.now() < resumeDeadline) {
    current = manager.get(task.id);
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!current || current.status !== "completed") {
    throw new Error(`Resume task did not complete: ${current?.error ?? current?.status ?? "missing"}`);
  }
  const resumedOutput = await readFile(path.join(workdir, "output.txt"), "utf8");
  if (resumedOutput !== "RELAY_E2E_RESUMED_OK\n") {
    throw new Error(`Unexpected resumed output: ${JSON.stringify(resumedOutput)}`);
  }
  if (current.sessionId !== originalSessionId) {
    throw new Error("Haha follow-up did not preserve the original session ID");
  }
  if (current.usage.costUsd <= firstCost) {
    throw new Error("Task usage did not accumulate the follow-up cost");
  }

  console.log(
    JSON.stringify({
      ok: true,
      taskId: current.id,
      sessionId: current.sessionId,
      model: current.usage.model,
      costUsd: current.usage.costUsd,
      resumed: true,
      changedFiles: current.changedFiles,
    }),
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (process.env.KEEP_RELAY_E2E !== "1") {
    await rm(root, { recursive: true, force: true });
  }
}
