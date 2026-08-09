import { createServer } from "node:http";

import { config } from "./config.js";
import { TokenMonitorClient } from "./token-monitor.js";

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      now: "2026-08-09T08:00:00.000Z",
      periods: {
        today: {
          projects: {
            project: {
              label: "SolFlashRelay",
              tokens: 42000,
              costUsd: 0.84,
              clients: { codex: 24000, claude: 18000 },
            },
          },
          sessions: {
            sol: {
              projectLabel: "SolFlashRelay",
              client: "codex",
              inputTokens: 20000,
              outputTokens: 4000,
              cacheReadTokens: 8000,
              cacheWriteTokens: 500,
              totalTokens: 24000,
              models: { "gpt-5.6-sol": 24000 },
              lastUsedAt: "2026-08-09T07:50:00.000Z",
            },
            flash: {
              projectLabel: "SolFlashRelay",
              client: "claude",
              inputTokens: 16000,
              outputTokens: 2000,
              cacheReadTokens: 12000,
              cacheWriteTokens: 0,
              totalTokens: 18000,
              models: { "deepseek-v4-flash": 18000 },
              lastUsedAt: "2026-08-09T07:55:00.000Z",
            },
          },
        },
        month: {
          projects: {
            project: { label: "SolFlashRelay", tokens: 10000, costUsd: 0.2 },
          },
          sessions: {
            recent: {
              projectLabel: "SolFlashRelay",
              client: "claude",
              inputTokens: 800,
              outputTokens: 200,
              cacheReadTokens: 400,
              totalTokens: 1000,
              costUsd: 0.02,
              models: { "deepseek-v4-flash": 1000 },
              lastUsedAt: "2026-08-08T10:00:00.000Z",
            },
            old: {
              projectLabel: "SolFlashRelay",
              client: "codex",
              inputTokens: 8000,
              outputTokens: 1000,
              totalTokens: 9000,
              costUsd: 0.18,
              models: { "gpt-5.6-sol": 9000 },
              lastUsedAt: "2026-08-01T10:00:00.000Z",
            },
          },
        },
      },
      limits: {
        providers: {
          deepseek: { label: "DeepSeek", used: 12, limit: 50, remaining: 38, percentage: 24, unit: "usd" },
        },
      },
    }),
  );
});

await new Promise<void>((resolve, reject) => {
  server.listen(17325, "127.0.0.1", resolve);
  server.once("error", reject);
});

try {
  const client = new TokenMonitorClient({
    ...config,
    tokenMonitorUrl: "http://127.0.0.1:17325",
    tokenMonitorProjectLabel: "SolFlashRelay",
  });
  const summary = await client.getProjectSummary("today");
  if (!summary.connected) throw new Error(summary.error ?? "Token Monitor did not connect");
  if (summary.totalTokens !== 42000 || summary.totalCostUsd !== 0.84) {
    throw new Error(`Unexpected aggregate: ${JSON.stringify(summary)}`);
  }
  if (summary.byModel["gpt-5.6-sol"] !== 24000) {
    throw new Error("Codex model breakdown was not parsed");
  }
  if (summary.byModel["deepseek-v4-flash"] !== 18000) {
    throw new Error("Flash model breakdown was not parsed");
  }
  if (summary.byClient.codex !== 24000 || summary.byClient.claude !== 18000) {
    throw new Error("Client breakdown was double-counted or parsed incorrectly");
  }
  if (summary.providerLimits[0]?.remaining !== 38) {
    throw new Error("Provider balance was not parsed");
  }
  const week = await client.getProjectSummary("week");
  if (week.totalTokens !== 1000 || week.sessions !== 1 || week.totalCostUsd !== 0.02) {
    throw new Error(`Weekly fallback did not filter month sessions: ${JSON.stringify(week)}`);
  }
  console.log(JSON.stringify({ ok: true, summary }));
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
