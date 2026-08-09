import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type TokenMonitorSettings = Record<string, unknown> & {
  limitsEnabled?: boolean;
  limitProviders?: string | string[];
  limitProviderOrder?: string | string[];
  limitsRefreshMs?: number;
};

export interface TokenMonitorCompatibility {
  settingsFound: boolean;
  risk: boolean;
  repairable: boolean;
  claudeLimitEnabled: boolean;
  refreshMs: number | null;
  restartRequired: boolean;
  message: string;
  backupPath: string | null;
}

const providerList = (value: unknown) => {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(source.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
};

const statusFromSettings = (
  settings: TokenMonitorSettings,
  overrides: Partial<TokenMonitorCompatibility> = {},
): TokenMonitorCompatibility => {
  const providers = providerList(settings.limitProviders ?? settings.limitProviderOrder);
  const limitsEnabled = settings.limitsEnabled !== false;
  const claudeLimitEnabled = limitsEnabled && providers.includes("claude");
  const refreshMs = Number.isFinite(Number(settings.limitsRefreshMs))
    ? Number(settings.limitsRefreshMs)
    : null;
  return {
    settingsFound: true,
    risk: claudeLimitEnabled,
    repairable: claudeLimitEnabled,
    claudeLimitEnabled,
    refreshMs,
    restartRequired: false,
    message: claudeLimitEnabled
      ? `Token Monitor 会每 ${formatInterval(refreshMs)}调用 Claude /usage，可能持续创建 Haha 对话。`
      : "Token Monitor 的 Claude /usage 轮询已关闭。",
    backupPath: null,
    ...overrides,
  };
};

export const inspectTokenMonitorCompatibility = async (
  settingsPath: string,
): Promise<TokenMonitorCompatibility> => {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as TokenMonitorSettings;
    return statusFromSettings(settings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        settingsFound: false,
        risk: false,
        repairable: false,
        claudeLimitEnabled: false,
        refreshMs: null,
        restartRequired: false,
        message: "未检测到 Token Monitor 本地配置。",
        backupPath: null,
      };
    }
    return {
      settingsFound: true,
      risk: true,
      repairable: false,
      claudeLimitEnabled: false,
      refreshMs: null,
      restartRequired: false,
      message: `无法检查 Token Monitor 配置：${error instanceof Error ? error.message : String(error)}`,
      backupPath: null,
    };
  }
};

export const disableTokenMonitorClaudePolling = async (
  settingsPath: string,
): Promise<TokenMonitorCompatibility> => {
  const raw = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(raw) as TokenMonitorSettings;
  const current = statusFromSettings(settings);
  if (!current.claudeLimitEnabled) return current;

  const providers = providerList(settings.limitProviders ?? settings.limitProviderOrder)
    .filter((provider) => provider !== "claude");
  settings.limitProviders = providers.join(",");

  await mkdir(path.dirname(settingsPath), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = `${settingsPath}.solflash-backup-${stamp}`;
  await copyFile(settingsPath, backupPath);
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  return statusFromSettings(settings, {
    restartRequired: true,
    message: "已关闭 Claude /usage 轮询。请退出并重启 Token Monitor 使运行中的实例立即应用。",
    backupPath,
  });
};

const formatInterval = (milliseconds: number | null) => {
  if (!milliseconds || milliseconds < 1000) return "定期";
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} 分钟`;
  return `${Math.round(milliseconds / 1000)} 秒`;
};
