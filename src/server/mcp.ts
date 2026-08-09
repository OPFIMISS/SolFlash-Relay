import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import type { RelaySettings, RelayTask, RelayTaskRequest } from "../shared/types.js";
import { relayVersion } from "./config.js";
import { isTerminal } from "./task-store.js";

const host = process.env.RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.RELAY_PORT ?? 17322);
const relayUrl = process.env.RELAY_URL ?? `http://${host}:${port}`;

const textResult = (value: unknown, isError = false) => ({
  isError,
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const conciseTask = (task: RelayTask | null) => {
  if (!task) return null;
  return {
    id: task.id,
    sessionId: task.sessionId,
    title: task.request.title,
    projectName: task.projectName,
    workdir: task.request.workdir,
    plannerAgent: task.request.plannerAgent,
    plannerModel: task.request.plannerModel,
    executorAgent: task.request.executorAgent,
    requestedModel: task.requestedModel,
    effectiveModel: task.effectiveModel,
    modelWarning: task.modelWarning,
    status: task.status,
    updatedAt: task.updatedAt,
    summary: task.summary,
    error: task.error,
    changedFiles: task.changedFiles,
    scopeWarnings: task.scopeWarnings,
    usage: task.usage,
    recentEvents: task.events.slice(-8),
  };
};

const requestJson = async <T>(route: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${relayUrl}${route}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Relay HTTP ${response.status}`);
  return body;
};

const waitForDaemon = async () => {
  let shouldStart = false;
  try {
    const health = await requestJson<{ version?: string }>("/api/health");
    if (health.version === relayVersion) return;
    throw new Error(`Relay version mismatch: MCP ${relayVersion}, daemon ${health.version ?? "legacy"}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Relay version mismatch:")) throw error;
    shouldStart = true;
  }

  if (shouldStart) {
    const desktopExecutable = process.env.RELAY_DESKTOP_EXECUTABLE;
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const daemonPath = path.join(currentDir, "daemon.js");
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      desktopExecutable || process.execPath,
      desktopExecutable ? ["--background"] : [daemonPath],
      {
      cwd: desktopExecutable
        ? process.env.RELAY_DESKTOP_CWD || process.cwd()
        : path.resolve(currentDir, "../.."),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: childEnv,
      },
    );
    child.unref();
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const health = await requestJson<{ version?: string }>("/api/health");
      if (health.version === relayVersion) return;
    } catch {
      // Keep waiting for the detached daemon.
    }
  }
  throw new Error(`Relay daemon did not start at ${relayUrl}`);
};

const server = new McpServer({ name: "sol-flash-relay", version: relayVersion });

const startSchema = {
  title: z.string().min(1),
  objective: z.string().min(1),
  workdir: z.string().min(1).describe("Absolute path of the current planner project. The executor session is created in this exact directory."),
  allowedFiles: z.array(z.string().min(1)).min(1),
  contextFiles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCommands: z.array(z.string()).optional(),
  notes: z.string().optional(),
  plannerAgent: z.string().optional(),
  plannerModel: z.string().optional(),
  executorAgent: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
};

const startTask = async (request: RelayTaskRequest) => {
  try {
    const task = await requestJson<RelayTask>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return textResult(conciseTask(task));
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
  }
};

server.registerTool(
  "agent_start",
  {
    title: "Start implementation agent task",
    description:
      "Start a bounded task in the selected execution Agent. Always pass the absolute path of the planner's current project so the executor creates or resumes its conversation under the same project.",
    inputSchema: startSchema,
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  startTask,
);

server.registerTool(
  "flash_start",
  {
    title: "Start Haha Flash task",
    description:
      "Start a bounded implementation task in the locally configured Claude Code Haha Flash agent. Use only after Sol has made architecture and UI decisions. Returns immediately with a task ID.",
    inputSchema: startSchema,
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  startTask,
);

server.registerTool(
  "agent_run",
  {
    title: "Run implementation agent and wait",
    description:
      "Start a bounded execution-Agent task and keep this tool call open until the Agent returns a final reply. Prefer this when the planner must automatically receive completion without manually polling flash_wait.",
    inputSchema: {
      ...startSchema,
      timeoutSeconds: z.number().int().min(30).max(3600).default(900),
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ timeoutSeconds, ...request }) => {
    try {
      let task = await requestJson<RelayTask>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(request),
      });
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (!isTerminal(task.status) && Date.now() < deadline) {
        const query = new URLSearchParams({
          afterUpdatedAt: task.updatedAt,
          timeoutSeconds: String(Math.min(60, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)))),
        });
        task = await requestJson<RelayTask>(`/api/tasks/${task.id}/wait?${query}`);
      }
      if (!isTerminal(task.status)) {
        return textResult({
          ...conciseTask(task),
          timedOut: true,
          next: "Call flash_wait with this task ID; the execution Agent is still running.",
        });
      }
      return textResult(conciseTask(task), task.status === "failed");
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "relay_profiles",
  {
    title: "List Relay Agent profiles",
    description: "Return configured planner/executor Agents and model defaults without exposing provider credentials.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return textResult(await requestJson<RelaySettings>("/api/settings"));
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "relay_set_profile",
  {
    title: "Set Relay Agent profile",
    description: "Change default planner Agent/model and execution Agent/model for future tasks.",
    inputSchema: {
      plannerAgent: z.string().min(1),
      plannerModel: z.string(),
      executorAgent: z.string().min(1),
      executorModel: z.string(),
      executorEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async (selection) => {
    try {
      const current = await requestJson<RelaySettings>("/api/settings");
      return textResult(await requestJson<RelaySettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ ...current, ...selection }),
      }));
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "relay_register_agent",
  {
    title: "Register Relay Agent adapter",
    description: "Register or update a credential-free local Agent adapter. Inspect the installed CLI first and never include API keys or tokens.",
    inputSchema: {
      id: z.string().regex(/^[a-z0-9-]+$/),
      label: z.string().min(1),
      role: z.enum(["planner", "executor", "both"]),
      transport: z.enum(["host", "haha-sidecar", "claude-cli", "opencode-cli", "reasonix-cli", "custom-cli"]),
      enabled: z.boolean().default(true),
      command: z.string().optional(),
      models: z.array(z.string()).default([]),
      defaultModel: z.string().default(""),
      args: z.array(z.string()).optional(),
      resumeArgs: z.array(z.string()).optional(),
      outputFormat: z.enum(["stream-json", "jsonl", "text"]).optional(),
      promptTransport: z.enum(["stdin", "argument"]).optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async (agent) => {
    try {
      return textResult(await requestJson<RelaySettings>("/api/agents", {
        method: "POST",
        body: JSON.stringify(agent),
      }));
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "flash_status",
  {
    title: "Get Flash task status",
    description: "Return compact status and recent events for one Flash task.",
    inputSchema: { taskId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ taskId }) => {
    try {
      return textResult(conciseTask(await requestJson<RelayTask>(`/api/tasks/${taskId}`)));
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "flash_wait",
  {
    title: "Wait for Flash progress",
    description:
      "Wait until a Flash task changes or the timeout expires. Returns compact progress rather than the full transcript.",
    inputSchema: {
      taskId: z.string().uuid(),
      afterUpdatedAt: z.string(),
      timeoutSeconds: z.number().int().min(1).max(60).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ taskId, afterUpdatedAt, timeoutSeconds }) => {
    try {
      const query = new URLSearchParams({
        afterUpdatedAt,
        timeoutSeconds: String(timeoutSeconds),
      });
      return textResult(
        conciseTask(
          await requestJson<RelayTask>(`/api/tasks/${taskId}/wait?${query}`),
        ),
      );
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "flash_send",
  {
    title: "Send Flash a follow-up",
    description: "Resume the same Haha session with a targeted correction from Sol.",
    inputSchema: { taskId: z.string().uuid(), instruction: z.string().min(1) },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ taskId, instruction }) => {
    try {
      return textResult(
        conciseTask(
          await requestJson<RelayTask>(`/api/tasks/${taskId}/message`, {
            method: "POST",
            body: JSON.stringify({ instruction }),
          }),
        ),
      );
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "flash_cancel",
  {
    title: "Cancel Flash task",
    description: "Stop the active Haha process for a task.",
    inputSchema: { taskId: z.string().uuid() },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ taskId }) => {
    try {
      return textResult(
        conciseTask(
          await requestJson<RelayTask>(`/api/tasks/${taskId}/cancel`, {
            method: "POST",
          }),
        ),
      );
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "flash_list",
  {
    title: "List Flash tasks",
    description: "List recent Relay tasks without full event histories.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ limit }) => {
    try {
      const tasks = await requestJson<RelayTask[]>("/api/tasks");
      return textResult(tasks.slice(0, limit).map(conciseTask));
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

await waitForDaemon();
await server.connect(new StdioServerTransport());
console.error(`[relay] MCP proxy connected to ${relayUrl}`);
