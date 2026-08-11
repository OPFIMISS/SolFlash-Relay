import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import type { AgentDefinition, HahaSessionImportRequest, RelaySettings, RelayTaskRequest } from "../shared/types.js";
import { discoverHahaModels } from "./agent-runner.js";
import { discoverHahaSessions } from "./haha-sessions.js";
import { publicConfig, relayVersion, type RelayConfig } from "./config.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";
import { TokenMonitorClient } from "./token-monitor.js";
import { SettingsStore } from "./settings-store.js";

export const startHttpServer = (
  relayConfig: RelayConfig,
  manager: TaskManager,
  store: TaskStore,
  tokenMonitor: TokenMonitorClient,
  settings: SettingsStore,
) => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, version: relayVersion, now: new Date().toISOString() });
  });
  app.get("/api/config", (_request, response) => response.json(publicConfig(relayConfig)));
  app.get("/api/settings", async (_request, response) => {
    const current = settings.get();
    const discovered = await discoverHahaModels(relayConfig);
    const haha = current.agents.find((agent) => agent.id === "claude-haha");
    if (haha) haha.models = [...new Set([...haha.models, ...discovered])];
    response.json(current);
  });
  app.put("/api/settings", async (request, response) => {
    try {
      response.json(await settings.save(request.body as RelaySettings));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/agents", async (request, response) => {
    try {
      const agent = request.body as AgentDefinition;
      if (!agent.id?.trim() || !agent.label?.trim() || !agent.transport) {
        return response.status(400).json({ error: "Agent id, label, and transport are required." });
      }
      return response.json(await settings.upsertAgent(agent));
    } catch (error) {
      return response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get("/api/tasks", (_request, response) => response.json(manager.list()));
  app.get("/api/haha-sessions", async (request, response) => {
    try {
      response.json(await discoverHahaSessions(relayConfig, String(request.query.workdir ?? "")));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/tasks/import-haha", async (request, response) => {
    try {
      const input = request.body as HahaSessionImportRequest;
      if (!input.sessionId?.trim() || !input.workdir?.trim()) {
        return response.status(400).json({ error: "sessionId and workdir are required." });
      }
      if (!input.instruction?.trim()) {
        return response.status(400).json({ error: "instruction is required." });
      }
      const sessions = await discoverHahaSessions(relayConfig, input.workdir);
      const session = sessions.find((item) => item.sessionId === input.sessionId);
      if (!session) return response.status(404).json({ error: "Haha session not found for this project path." });
      return response.status(202).json(await manager.adopt(session, input.allowedFiles ?? [], input.instruction ?? ""));
    } catch (error) {
      return response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/tasks/:id", (request, response) => {
    const task = manager.get(request.params.id);
    if (!task) return response.status(404).json({ error: "Task not found" });
    return response.json(task);
  });
  app.get("/api/tasks/:id/wait", async (request, response) => {
    const afterUpdatedAt = String(request.query.afterUpdatedAt ?? "");
    const timeoutSeconds = Math.min(
      60,
      Math.max(1, Number(request.query.timeoutSeconds ?? 30)),
    );
    const task = await store.waitForUpdate(
      request.params.id,
      afterUpdatedAt,
      timeoutSeconds * 1000,
    );
    if (!task) return response.status(404).json({ error: "Task not found" });
    return response.json(task);
  });
  app.post("/api/tasks", async (request, response) => {
    try {
      const task = await manager.start(request.body as RelayTaskRequest);
      response.status(202).json(task);
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/planner-led", async (request, response) => {
    try {
      response.status(202).json(await manager.startPlannerLed(request.body as RelayTaskRequest));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/:id/message", async (request, response) => {
    try {
      response.status(202).json(
        await manager.send(request.params.id, String(request.body?.instruction ?? "")),
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/:id/planner-message", async (request, response) => {
    try {
      response.status(202).json(
        await manager.review(request.params.id, String(request.body?.instruction ?? "")),
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/:id/cancel", async (request, response) => {
    try {
      response.json(await manager.cancel(request.params.id));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/:id/pause", async (request, response) => {
    try {
      response.json(await manager.pause(request.params.id));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/:id/resume", async (request, response) => {
    try {
      response.status(202).json(await manager.resume(request.params.id));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.delete("/api/tasks/:id", async (request, response) => {
    try {
      const id = await manager.delete(request.params.id);
      response.json({ id });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/tasks/:id/read", async (request, response) => {
    const task = manager.get(request.params.id);
    if (!task) return response.status(404).json({ error: "Task not found" });
    task.unread = false;
    return response.json(await store.set(task));
  });
  app.get("/api/token-monitor", async (request, response) => {
    response.json(
      await tokenMonitor.getProjectSummary(String(request.query.period ?? "today")),
    );
  });

  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write(`event: ready\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);

    const onTask = (task: unknown) => {
      response.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`);
    };
    const onTaskDeleted = (taskId: string) => {
      response.write(`event: task-deleted\ndata: ${JSON.stringify({ taskId })}\n\n`);
    };
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15000);
    store.on("task", onTask);
    store.on("task-deleted", onTaskDeleted);
    request.on("close", () => {
      clearInterval(keepAlive);
      store.off("task", onTask);
      store.off("task-deleted", onTaskDeleted);
    });
  });

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(currentDir, "../client");
  if (existsSync(path.join(clientDir, "index.html"))) {
    app.use(express.static(clientDir));
    app.use((_request, response) => {
      response.sendFile(path.join(clientDir, "index.html"));
    });
  }

  const server = app.listen(relayConfig.port, relayConfig.host, () => {
    console.error(
      `[relay] dashboard http://${relayConfig.host}:${relayConfig.port}`,
    );
  });
  return server;
};
