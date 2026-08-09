import "dotenv/config";

import path from "node:path";
import os from "node:os";

import type { RelayConfigView } from "../shared/types.js";

export const relayVersion = "0.6.3";

const parsePort = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export interface RelayConfig extends RelayConfigView {
  dataDir: string;
  hahaGlobalConfigDir: string;
  hahaStateDir: string;
  hahaAllowShell: boolean;
  hahaShareDesktopState: boolean;
  tokenMonitorSecret: string;
}

export const config: RelayConfig = {
  version: relayVersion,
  host: process.env.RELAY_HOST ?? "127.0.0.1",
  port: parsePort(process.env.RELAY_PORT, 17322),
  dataDir: path.resolve(process.env.RELAY_DATA_DIR ?? ".relay-data"),
  hahaRoot: process.env.HAHA_ROOT ?? "D:\\Claude Code Haha",
  hahaGlobalConfigDir: path.resolve(
    process.env.HAHA_GLOBAL_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  ),
  hahaStateDir: path.resolve(
    process.env.HAHA_STATE_DIR ?? ".relay-data/haha-state",
  ),
  hahaModel: process.env.HAHA_MODEL ?? "deepseek-v4-flash",
  hahaEffort: process.env.HAHA_EFFORT ?? "medium",
  hahaAllowShell: parseBoolean(process.env.HAHA_ALLOW_SHELL, true),
  hahaShareDesktopState: parseBoolean(
    process.env.HAHA_SHARE_DESKTOP_STATE,
    true,
  ),
  tokenMonitorUrl:
    process.env.TOKEN_MONITOR_URL ?? "http://127.0.0.1:17321",
  tokenMonitorSecret: process.env.TOKEN_MONITOR_SECRET ?? "",
  tokenMonitorProjectLabel:
    process.env.TOKEN_MONITOR_PROJECT_LABEL ?? "SolFlashRelay",
};

export const publicConfig = (source: RelayConfig = config): RelayConfigView => ({
  version: relayVersion,
  host: source.host,
  port: source.port,
  hahaRoot: source.hahaRoot,
  hahaModel: source.hahaModel,
  hahaEffort: source.hahaEffort,
  tokenMonitorUrl: source.tokenMonitorUrl,
  tokenMonitorProjectLabel: source.tokenMonitorProjectLabel,
  hahaShareDesktopState: source.hahaShareDesktopState,
});
