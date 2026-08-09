import type { TokenMonitorSummary } from "../shared/types.js";
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
      const periodData = asRecord(periods[period] ?? periods.today);
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
      let latest = "";

      for (const sessionValue of Object.values(sessions)) {
        const session = asRecord(sessionValue);
        if (asString(session.projectLabel).toLowerCase() !== wanted) continue;
        sessionCount += 1;
        inputTokens += asNumber(session.inputTokens);
        outputTokens += asNumber(session.outputTokens);
        cacheReadTokens += asNumber(session.cacheReadTokens);
        cacheCreationTokens += asNumber(
          session.cacheWriteTokens ?? session.cacheCreationTokens,
        );
        const client = asString(session.client) || "unknown";
        byClient[client] =
          (byClient[client] ?? 0) + asNumber(session.totalTokens);
        sumMap(byModel, session.models);
        const lastUsedAt = asString(session.lastUsedAt);
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
        totalTokens: asNumber(matchingProject?.tokens),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalCostUsd: asNumber(matchingProject?.costUsd),
        sessions: sessionCount,
        byClient,
        byModel,
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
      updatedAt: null,
    };
  }
}
