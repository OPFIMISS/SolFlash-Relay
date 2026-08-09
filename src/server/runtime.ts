import type { Server } from "node:http";

import { config, type RelayConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { SettingsStore } from "./settings-store.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";
import { TokenMonitorClient } from "./token-monitor.js";

export interface RelayRuntime {
  server: Server;
  manager: TaskManager;
  close: () => Promise<void>;
}

export const startRelayRuntime = async (
  relayConfig: RelayConfig = config,
): Promise<RelayRuntime> => {
  const store = new TaskStore(relayConfig.dataDir);
  await store.load();
  const settings = new SettingsStore(relayConfig.dataDir);
  await settings.load();
  const manager = new TaskManager(relayConfig, store, settings);
  const tokenMonitor = new TokenMonitorClient(relayConfig);
  const server = startHttpServer(
    relayConfig,
    manager,
    store,
    tokenMonitor,
    settings,
  );

  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
    server.once("error", reject);
  });

  return {
    server,
    manager,
    close: async () => {
      await manager.shutdown();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
