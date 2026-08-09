import type { ProviderLimitSummary, TokenMonitorSummary } from "../shared/types.js";
import type { RelayConfig } from "./config.js";

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" ? (value as UnknownRecord) : {};

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const asString = (value: unknown) =>
  typeof value === "string" ? value : "";

const sumMap = (target: Record<string, number>, source: unknown) => {
  for (const [key, value] of Object.entries(asRecord(source))) {
    target[key] = (target[key] ?? 0) + asNumber(value);
  }
};

const startOfWeek = (value: string) => {
  const date = new Date(value || Date.now());
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const parseProviderLimits = (payload: UnknownRecord): ProviderLimitSummary[] => {
  const providers = asRecord(asRecord(payload.limits).providers);
  return Object.entries(providers).flatMap(([provider, value]) => {
    const item = asRecord(value);
    const used = asNumber(item.used ?? item.usage ?? item.spent);
    const limit = asNumber(item.limit ?? item.quota ?? item.total);
    const explicitRemaining = asNumber(item.remaining ?? item.balance ?? item.available);
    const remaining = explicitRemaining || Math.max(0, limit - used);
    const percentage = asNumber(item.percentage)
      || (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
    if (!(used || limit || remaining || percentage)) return [];
    return [{
      provider,
      label: asString(item.label ?? item.name) || provider,
      used,
      limit,
      remaining,
      percentage,
      unit: asString(item.unit) || "quota",
      resetAt: asString(item.resetAt ?? item.reset_at) || null,
      plan: asString(item.plan) || null,
    }];
  });
};

export class TokenMonitorClient {
  constructor(private readonly relayConfig: RelayConfig) {}

  async getProjectSummary(period = "today"): Promise<TokenMonitorSummary> {
    const empty = this.#emptySummary();
    try {
      const url = new URL("/api/stats", this.relayConfig.tokenMonitorUrl);
      const headers: Record<string, string> = {};
      if (this.relayConfig.tokenMonitorSecret) {
        headers.Authorization = `Bearer ${this.relayConfig.tokenMonitorSecret}`;
        headers["X-Token-Monitor-Secret"] =
          this.relayConfig.tokenMonitorSecret;
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        throw new Error(`Token Monitor returned HTTP ${response.status}`);
      }

      const payload = asRecord(await response.json());
      const periods = asRecord(payload.periods);
      const hasNativeWeek = Boolean(periods.week);
      const periodData = asRecord(
        periods[period]
          ?? (period === "week" ? periods.month : undefined)
          ?? periods.today,
      );
      const sessions = asRecord(periodData.sessions);
      const projects = asRecord(periodData.projects);
      const wanted = this.relayConfig.tokenMonitorProjectLabel.trim().toLowerCase();

      const matchingProject = Object.values(projects)
        .map(asRecord)
        .find((project) => asString(project.label).toLowerCase() === wanted);

      const byClient: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      let sessionCount = 0;
      let sessionTokens = 0;
      let sessionCostUsd = 0;
      let latest = "";
      const weekStart = startOfWeek(asString(payload.now));

      for (const sessionValue of Object.values(sessions)) {
        const session = asRecord(sessionValue);
        if (asString(session.projectLabel).toLowerCase() !== wanted) continue;
        const lastUsedAt = asString(session.lastUsedAt);
        if (period === "week" && !hasNativeWeek && new Date(lastUsedAt).getTime() < weekStart) {
          continue;
        }
        sessionCount += 1;
        inputTokens += asNumber(session.inputTokens);
        outputTokens += asNumber(session.outputTokens);
        cacheReadTokens += asNumber(session.cacheReadTokens);
        cacheCreationTokens += asNumber(
          session.cacheWriteTokens ?? session.cacheCreationTokens,
        );
        const client = asString(session.client) || "unknown";
        sessionTokens += asNumber(session.totalTokens)
          || asNumber(session.inputTokens) + asNumber(session.outputTokens);
        sessionCostUsd += asNumber(session.costUsd ?? session.totalCostUsd);
        byClient[client] =
          (byClient[client] ?? 0) + asNumber(session.totalTokens);
        sumMap(byModel, session.models);
        if (lastUsedAt > latest) latest = lastUsedAt;
      }

      if (matchingProject && sessionCount === 0) {
        sumMap(byClient, matchingProject.clients);
      }

      return {
        connected: true,
        source: url.origin,
        error: null,
        projectLabel: this.relayConfig.tokenMonitorProjectLabel,
        totalTokens: period === "week" && !hasNativeWeek
          ? sessionTokens
          : asNumber(matchingProject?.tokens) || sessionTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalCostUsd: period === "week" && !hasNativeWeek
          ? sessionCostUsd
          : asNumber(matchingProject?.costUsd) || sessionCostUsd,
        sessions: sessionCount,
        byClient,
        byModel,
        providerLimits: parseProviderLimits(payload),
        updatedAt: latest || asString(payload.now) || null,
      };
    } catch (error) {
      return {
        ...empty,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  #emptySummary(): TokenMonitorSummary {
    return {
      connected: false,
      source: this.relayConfig.tokenMonitorUrl,
      error: null,
      projectLabel: this.relayConfig.tokenMonitorProjectLabel,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      sessions: 0,
      byClient: {},
      byModel: {},
      providerLimits: [],
      updatedAt: null,
    };
  }
}
