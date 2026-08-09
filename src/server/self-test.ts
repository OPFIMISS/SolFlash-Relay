import { rm } from "node:fs/promises";
import path from "node:path";

import type { RelayTask } from "../shared/types.js";
import { config } from "./config.js";
import { startHttpServer } from "./http.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";
import { TokenMonitorClient } from "./token-monitor.js";
import { SettingsStore } from "./settings-store.js";

const testConfig = {
  ...config,
  port: 17323,
  dataDir: path.join(config.dataDir, "self-test"),
  hahaStateDir: path.join(config.dataDir, "self-test", "haha-state"),
};

await rm(testConfig.dataDir, { recursive: true, force: true });
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
  const health = await fetch(`http://${testConfig.host}:${testConfig.port}/api/health`);
  if (!health.ok) throw new Error(`Health endpoint returned ${health.status}`);
  const payload = (await health.json()) as { ok?: boolean };
  if (!payload.ok) throw new Error("Health payload did not report ok=true");

  const tasks = await fetch(`http://${testConfig.host}:${testConfig.port}/api/tasks`);
  if (!tasks.ok) throw new Error(`Tasks endpoint returned ${tasks.status}`);
  const taskPayload = (await tasks.json()) as unknown[];
  if (!Array.isArray(taskPayload)) throw new Error("Tasks endpoint did not return an array");

  const now = new Date().toISOString();
  const deletableTask: RelayTask = {
    id: "delete-self-test",
    sessionId: "delete-self-test-session",
    request: {
      title: "Delete self-test",
      objective: "Verify persisted deletion.",
      workdir: process.cwd(),
      allowedFiles: [],
      plannerAgent: "codex",
      plannerModel: "gpt-5.6-sol",
      executorAgent: "claude-haha",
      model: "deepseek-v4-flash",
    },
    status: "failed",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
    summary: "",
    error: "test",
    changedFiles: [],
    scopeWarnings: [],
    projectName: path.basename(process.cwd()),
    requestedModel: "deepseek-v4-flash",
    effectiveModel: null,
    modelWarning: null,
    unread: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, model: null },
    events: [],
    messages: [],
  };
  await store.set(deletableTask);
  const deleted = await fetch(`http://${testConfig.host}:${testConfig.port}/api/tasks/${deletableTask.id}`, { method: "DELETE" });
  if (!deleted.ok) throw new Error(`Delete endpoint returned ${deleted.status}`);
  const missing = await fetch(`http://${testConfig.host}:${testConfig.port}/api/tasks/${deletableTask.id}`);
  if (missing.status !== 404 || store.get(deletableTask.id)) {
    throw new Error("Deleted task remained available in the API or persistent store");
  }

  console.log(JSON.stringify({ ok: true, health: payload, tasks: taskPayload.length, deleted: true }));
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
