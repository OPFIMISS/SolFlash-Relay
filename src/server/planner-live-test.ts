import path from "node:path";

import type { HahaSessionSummary, RelayTask } from "../shared/types.js";
import { CodexPlanner } from "./planner-runner.js";

if (process.env.ALLOW_LIVE_CODEX_PLANNER !== "1") {
  throw new Error("Set ALLOW_LIVE_CODEX_PLANNER=1 to create a real persisted Codex planner thread.");
}

const workdir = path.resolve(process.env.PLANNER_LIVE_WORKDIR ?? process.cwd());
const now = new Date().toISOString();
const task: RelayTask = {
  id: "planner-live-test",
  sessionId: "8514b596-c362-42a4-9f0b-7c9c9c451cd3",
  request: {
    title: "SolFlash Relay planner integration probe",
    objective: "Verify that Relay creates a real persisted Codex planner conversation.",
    workdir,
    allowedFiles: ["README.md"],
    plannerAgent: "codex",
    plannerModel: "gpt-5.6-sol",
    executorAgent: "claude-haha",
    model: "deepseek-v4-flash",
    effort: "low",
  },
  status: "waiting",
  createdAt: now,
  startedAt: null,
  finishedAt: null,
  updatedAt: now,
  summary: "",
  error: null,
  changedFiles: [],
  scopeWarnings: [],
  projectName: path.basename(workdir),
  requestedModel: "deepseek-v4-flash",
  effectiveModel: null,
  modelWarning: null,
  unread: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, model: null },
  events: [],
  messages: [],
  origin: "adopted",
  workflowMode: "planner-adoption",
  workflowPhase: "planner-review",
  plannerThreadId: null,
  plannerRounds: 0,
  plannerUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, model: "gpt-5.6-sol" },
};
const session: HahaSessionSummary = {
  sessionId: task.sessionId,
  title: "SolFlash Relay planner integration probe",
  workdir,
  model: "deepseek-v4-flash",
  updatedAt: now,
  lastPrompt: "Probe",
  lastResponse: "No implementation changes were made.",
  changedFiles: [],
};

const review = await new CodexPlanner().reviewAdoption(
  task,
  session,
  "This is an integration probe. Inspect only README.md, make no changes, and produce a short harmless Flash instruction that asks for no file modifications.",
);
console.log(JSON.stringify({ ok: true, workdir, ...review }));
