import { rm } from "node:fs/promises";
import path from "node:path";

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

  console.log(JSON.stringify({ ok: true, health: payload, tasks: taskPayload.length }));
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
