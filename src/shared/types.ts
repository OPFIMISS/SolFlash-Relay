export type RelayTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type RelayEventKind =
  | "task.created"
  | "task.started"
  | "task.output"
  | "task.tool"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.model-warning"
  | "task.scope-warning";

export type AgentConversationKind =
  | "instruction"
  | "follow-up"
  | "output"
  | "result"
  | "error";

export interface AgentConversationMessage {
  id: string;
  role: "planner" | "executor";
  agent: string;
  model: string;
  timestamp: string;
  content: string;
  kind: AgentConversationKind;
}

export interface RelayTaskRequest {
  title: string;
  objective: string;
  workdir: string;
  allowedFiles: string[];
  contextFiles?: string[];
  constraints?: string[];
  acceptanceCommands?: string[];
  notes?: string;
  plannerAgent?: string;
  plannerModel?: string;
  executorAgent?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type AgentRole = "planner" | "executor" | "both";
export type AgentTransport = "host" | "haha-sidecar" | "claude-cli" | "opencode-cli" | "reasonix-cli" | "custom-cli";

export interface AgentDefinition {
  id: string;
  label: string;
  role: AgentRole;
  transport: AgentTransport;
  enabled: boolean;
  command?: string;
  models: string[];
  defaultModel: string;
  args?: string[];
  resumeArgs?: string[];
  outputFormat?: "stream-json" | "jsonl" | "text";
  promptTransport?: "stdin" | "argument";
}

export interface RelaySettings {
  plannerAgent: string;
  plannerModel: string;
  executorAgent: string;
  executorModel: string;
  executorEffort: "low" | "medium" | "high" | "xhigh" | "max";
  agents: AgentDefinition[];
}

export interface ProviderLimitSummary {
  provider: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
  unit: string;
  resetAt: string | null;
  plan: string | null;
}

export interface RelayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  model: string | null;
}

export interface RelayTask {
  id: string;
  sessionId: string;
  request: RelayTaskRequest;
  status: RelayTaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  summary: string;
  error: string | null;
  changedFiles: string[];
  scopeWarnings: string[];
  projectName: string;
  requestedModel: string;
  effectiveModel: string | null;
  modelWarning: string | null;
  unread: boolean;
  usage: RelayUsage;
  events: RelayEvent[];
  messages: AgentConversationMessage[];
}

export interface RelayEvent {
  id: string;
  taskId: string;
  kind: RelayEventKind;
  timestamp: string;
  message: string;
  detail?: unknown;
}

export interface RelayConfigView {
  version: string;
  host: string;
  port: number;
  hahaRoot: string;
  hahaModel: string;
  hahaEffort: string;
  tokenMonitorUrl: string;
  tokenMonitorProjectLabel: string;
  hahaShareDesktopState: boolean;
}

export interface TokenMonitorSummary {
  connected: boolean;
  source: string;
  error: string | null;
  projectLabel: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  sessions: number;
  byClient: Record<string, number>;
  byModel: Record<string, number>;
  providerLimits: ProviderLimitSummary[];
  updatedAt: string | null;
}
