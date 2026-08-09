import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import type {
  AgentConversationKind,
  HahaSessionSummary,
  RelayEvent,
  RelayEventKind,
  RelayTask,
  RelayTaskRequest,
  RelayUsage,
} from "../shared/types.js";
import { buildAgentRun } from "./agent-runner.js";
import type { RelayConfig } from "./config.js";
import { CodexPlanner, type PlannerRunner } from "./planner-runner.js";
import { SettingsStore } from "./settings-store.js";
import { TaskStore } from "./task-store.js";

const execFileAsync = promisify(execFile);
const maxPlannerRounds = 3;

interface GitEntry {
  status: string;
  hash: string;
}

interface GitSnapshot {
  repoRoot: string | null;
  entries: Map<string, GitEntry>;
  allowed: Set<string>;
}

interface HahaJsonEvent {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
  message?:
    | string
    | {
        content?: Array<Record<string, unknown>>;
      };
  error?: unknown;
  errors?: unknown[];
  session_id?: string;
  sessionID?: string;
  model?: string;
}

const emptyUsage = (): RelayUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  model: null,
});

const normalizePath = (value: string) => value.replaceAll("\\", "/");
const safeName = (value: string) => value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export class TaskManager {
  readonly #processes = new Map<string, ReturnType<typeof spawn>>();

  constructor(
    private readonly relayConfig: RelayConfig,
    private readonly store: TaskStore,
    private readonly settingsStore: SettingsStore,
    private readonly planner: PlannerRunner = new CodexPlanner(),
  ) {}

  async start(request: RelayTaskRequest) {
    const normalized = await this.#validateRequest(request);
    const settings = this.settingsStore.get();
    const executorAgent = normalized.executorAgent ?? settings.executorAgent;
    const requestedModel = normalized.model ?? settings.executorModel;
    const plannerAgent = normalized.plannerAgent ?? settings.plannerAgent;
    const plannerModel = normalized.plannerModel ?? settings.plannerModel;
    this.#requireExecutor(executorAgent);
    const now = new Date().toISOString();
    const task: RelayTask = {
      id: randomUUID(),
      sessionId: randomUUID(),
      request: {
        ...normalized,
        plannerAgent,
        plannerModel,
        executorAgent,
        model: requestedModel,
        effort: normalized.effort ?? settings.executorEffort,
      },
      status: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      summary: "",
      error: null,
      changedFiles: [],
      scopeWarnings: [],
      projectName: path.basename(normalized.workdir),
      requestedModel,
      effectiveModel: null,
      modelWarning: null,
      unread: false,
      usage: emptyUsage(),
      events: [],
      messages: [],
      workflowMode: "direct",
      workflowPhase: "executor-run",
      plannerThreadId: null,
      plannerRounds: 0,
      plannerUsage: emptyUsage(),
    };

    await this.store.set(task);
    await this.#message(task, "planner", "instruction", task.request.objective);
    await this.#event(task, "task.created", `Task created: ${task.request.title}`);
    void this.#run(task, this.#buildInitialPrompt(task), false);
    return task;
  }

  async startPlannerLed(request: RelayTaskRequest) {
    const settings = this.settingsStore.get();
    const title = request.title?.trim() || "未命名任务";
    const workdir = request.workdir?.trim() || path.join(
      this.relayConfig.dataDir,
      "projects",
      `${Date.now()}-${safeName(title)}`,
    );
    await mkdir(workdir, { recursive: true });
    const normalized = await this.#validateRequest({
      ...request,
      title,
      workdir,
      allowedFiles: request.allowedFiles?.length ? request.allowedFiles : ["."],
      plannerAgent: request.plannerAgent ?? settings.plannerAgent,
      plannerModel: request.plannerModel ?? settings.plannerModel,
      executorAgent: request.executorAgent ?? settings.executorAgent,
      model: request.model ?? settings.executorModel,
      effort: request.effort ?? settings.executorEffort,
      reviewAfterExecution: request.reviewAfterExecution ?? true,
    });
    this.#requireExecutor(normalized.executorAgent ?? settings.executorAgent);
    const now = new Date().toISOString();
    const task: RelayTask = {
      id: randomUUID(),
      sessionId: randomUUID(),
      request: normalized,
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
      requestedModel: normalized.model ?? settings.executorModel,
      effectiveModel: null,
      modelWarning: null,
      unread: false,
      usage: emptyUsage(),
      events: [],
      messages: [],
      origin: "relay",
      workflowMode: "planner-led",
      workflowPhase: "planner-review",
      plannerThreadId: null,
      plannerRounds: 0,
      plannerUsage: emptyUsage(),
    };
    await this.store.set(task);
    await this.#message(task, "planner", "instruction", normalized.objective);
    await this.#event(task, "task.created", `Planner-led task created in ${workdir}.`);
    void this.#runPlannerTask(task, normalized.objective);
    return task;
  }

  async #runPlannerTask(task: RelayTask, goal: string) {
    try {
      task.status = "waiting";
      task.workflowPhase = "planner-review";
      await this.store.set(task);
      await this.#event(task, "task.planner-started", `Creating a visible planner conversation in ${task.request.workdir}.`);
      const review = await this.planner.planTask(task, goal, async (threadId) => {
        task.plannerThreadId = threadId;
        await this.store.set(task);
        await this.#event(task, "task.planner-started", `Created visible planner thread ${threadId}.`);
      }, (summary) => this.#plannerProgress(task, summary));
      task.plannerThreadId = review.threadId;
      task.plannerRounds = 1;
      task.plannerUsage = mergeUsage(task.plannerUsage ?? emptyUsage(), review.usage);
      await this.store.set(task);
      await this.#message(task, "planner", "output", review.summary);
      await this.#event(task, "task.planner-completed", `Planner completed framework and execution guidance in thread ${review.threadId}.`);
      await this.#queueExecutor(task, review.instruction, false);
    } catch (error) {
      await this.#fail(task, error instanceof Error ? error.message : String(error), "planner");
    }
  }

  async send(taskId: string, instruction: string) {
    const task = this.#requireTask(taskId);
    return this.#queueExecutor(task, instruction, true);
  }

  async review(taskId: string, goal: string) {
    const task = this.#requireTask(taskId);
    if (task.workflowMode === "direct" || !task.plannerThreadId) {
      throw new Error("This task has no persistent Codex planner conversation.");
    }
    if (this.#processes.has(task.id) || task.status === "running" || task.workflowPhase === "planner-review" || task.workflowPhase === "planner-verification") {
      throw new Error("Wait for the current planner or executor turn to finish first.");
    }
    if (!goal.trim()) throw new Error("Planner guidance must not be empty.");
    void this.#runPlannerGoal(task, goal.trim());
    return task;
  }

  async #runPlannerGoal(task: RelayTask, goal: string) {
    try {
      task.status = "waiting";
      task.workflowPhase = "planner-review";
      task.finishedAt = null;
      task.error = null;
      task.unread = false;
      await this.store.set(task);
      await this.#message(task, "planner", "instruction", goal);
      await this.#event(task, "task.planner-started", `User guidance was sent to Codex thread ${task.plannerThreadId}.`);
      const review = await this.planner.continueReview(task, goal, (summary) => this.#plannerProgress(task, summary));
      task.plannerRounds = (task.plannerRounds ?? 0) + 1;
      task.plannerUsage = mergeUsage(task.plannerUsage ?? emptyUsage(), review.usage);
      await this.store.set(task);
      await this.#message(task, "planner", "output", review.summary);
      await this.#event(task, "task.planner-completed", `Sol produced a new correction in Codex thread ${task.plannerThreadId}.`);
      await this.#queueExecutor(task, review.instruction, true);
    } catch (error) {
      await this.#fail(task, error instanceof Error ? error.message : String(error), "planner");
    }
  }

  async #queueExecutor(task: RelayTask, instruction: string, resume: boolean) {
    if (this.#processes.has(task.id)) {
      throw new Error("The execution agent is already running for this task.");
    }
    if (!instruction.trim()) throw new Error("Instruction must not be empty.");

    task.status = "queued";
    task.workflowPhase = "executor-run";
    task.finishedAt = null;
    task.error = null;
    task.unread = false;
    task.summary = "";
    await this.store.set(task);
    await this.#message(task, "planner", "follow-up", instruction.trim());
    void this.#run(task, this.#buildFollowUpPrompt(task, instruction), resume);
    return task;
  }

  async adopt(session: HahaSessionSummary, allowedFiles: string[], instruction: string) {
    if (!this.relayConfig.hahaShareDesktopState) {
      throw new Error("Adopting desktop Haha sessions requires HAHA_SHARE_DESKTOP_STATE=true.");
    }
    if (!instruction.trim()) throw new Error("A first correction instruction is required.");
    const settings = this.settingsStore.get();
    const executorAgent = settings.executorAgent;
    this.#requireExecutor(executorAgent);
    const requestedModel = session.model && session.model !== "unknown"
      ? session.model
      : settings.executorModel;
    const normalized = await this.#validateRequest({
      title: session.title,
      objective: "接管已有 Haha 项目对话，由主策划审查当前实现并继续发送纠偏指令。",
      workdir: session.workdir,
      allowedFiles,
      contextFiles: [],
      constraints: ["Preserve unrelated user changes.", "Do not create a new session; resume the adopted session."],
      acceptanceCommands: [],
      plannerAgent: settings.plannerAgent,
      plannerModel: settings.plannerModel,
      executorAgent,
      model: requestedModel,
      effort: settings.executorEffort,
    });
    const now = new Date().toISOString();
    const task: RelayTask = {
      id: randomUUID(),
      sessionId: session.sessionId,
      request: normalized,
      status: "waiting",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      summary: session.lastResponse,
      error: null,
      changedFiles: session.changedFiles,
      scopeWarnings: [],
      projectName: path.basename(normalized.workdir),
      requestedModel,
      effectiveModel: session.model === "unknown" ? null : session.model,
      modelWarning: null,
      unread: false,
      usage: emptyUsage(),
      events: [],
      messages: [],
      origin: "adopted",
      sourceSessionTitle: session.title,
      workflowMode: "planner-adoption",
      workflowPhase: "planner-review",
      plannerThreadId: null,
      plannerRounds: 0,
      plannerUsage: emptyUsage(),
    };

    await this.store.set(task);
    await this.#message(task, "planner", "instruction", instruction.trim());
    if (session.lastResponse) await this.#message(task, "executor", "output", session.lastResponse);
    await this.#event(task, "task.created", `Adopted existing Haha session: ${session.title}`, {
      sessionId: session.sessionId,
      workdir: session.workdir,
    });
    void this.#runPlannerAdoption(task, session, instruction.trim());
    return task;
  }

  async #runPlannerAdoption(task: RelayTask, session: HahaSessionSummary, goal: string) {
    try {
      task.status = "waiting";
      task.workflowPhase = "planner-review";
      await this.store.set(task);
      await this.#event(task, "task.planner-started", `Codex / Sol is reviewing ${session.title} in ${task.request.workdir}.`);
      const review = await this.planner.reviewAdoption(task, session, goal, async (threadId) => {
        task.plannerThreadId = threadId;
        await this.store.set(task);
        await this.#event(task, "task.planner-started", `Created visible Codex planner thread ${threadId}.`);
      }, (summary) => this.#plannerProgress(task, summary));
      task.plannerThreadId = review.threadId;
      task.plannerRounds = 1;
      task.plannerUsage = mergeUsage(task.plannerUsage ?? emptyUsage(), review.usage);
      await this.store.set(task);
      await this.#message(task, "planner", "output", review.summary);
      await this.#event(task, "task.planner-completed", `Sol review completed in Codex thread ${review.threadId}.`);
      await this.#queueExecutor(task, review.instruction, true);
    } catch (error) {
      await this.#fail(task, error instanceof Error ? error.message : String(error), "planner");
    }
  }

  async cancel(taskId: string) {
    const task = this.#requireTask(taskId);
    const child = this.#processes.get(taskId);
    if (child && !child.killed) await terminateProcess(child);
    task.status = "cancelled";
    task.finishedAt = new Date().toISOString();
    await this.store.set(task);
    await this.#event(task, "task.cancelled", "Task cancelled by Sol or the user.");
    this.#releasePlanner(task);
    return task;
  }

  async delete(taskId: string) {
    const task = this.#requireTask(taskId);
    if (this.#processes.has(taskId) || task.status === "queued" || task.status === "running" || task.status === "waiting") {
      throw new Error("Wait for the active planner/executor turn to finish before deleting it.");
    }
    await this.store.delete(taskId);
    return taskId;
  }

  get(taskId: string) {
    return this.store.get(taskId);
  }

  list() {
    return this.store.list();
  }

  async shutdown() {
    const active = [...this.#processes.entries()];
    for (const [taskId, child] of active) {
      if (!child.killed) await terminateProcess(child);
      const task = this.store.get(taskId);
      if (!task || task.status !== "running") continue;
      task.status = "cancelled";
      task.finishedAt = new Date().toISOString();
      await this.store.set(task);
      await this.#event(task, "task.cancelled", "Execution Agent stopped because Relay exited.");
    }
    this.planner.close?.();
  }

  async #run(task: RelayTask, prompt: string, resume: boolean) {
    const agent = this.#requireExecutor(task.request.executorAgent ?? "claude-haha");
    let run;
    try {
      run = await buildAgentRun(this.relayConfig, agent, task, prompt, resume);
    } catch (error) {
      await this.#fail(
        task,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const before = await captureGitSnapshot(
      task.request.workdir,
      task.request.allowedFiles,
    );
    task.status = "running";
    task.startedAt ??= new Date().toISOString();
    task.finishedAt = null;
    await this.store.set(task);
    await this.#event(
      task,
      "task.started",
      resume
        ? `Resumed the existing ${agent.label} session in ${task.request.workdir}.`
        : `Started ${agent.label} in project ${task.projectName}.`,
      { requestedModel: run.requestedModel, cliModel: run.cliModel },
    );
    await this.#event(
      task,
      "task.output",
      `Model dispatch: requested ${run.requestedModel}; executor CLI received ${run.cliModel}.`,
    );

    const child = spawn(run.command, run.args, {
      cwd: run.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: run.env,
    });
    this.#processes.set(task.id, child);

    let receivedResult = false;
    let stderr = "";
    let processing = Promise.resolve();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      processing = processing.then(async () => {
        if (run.outputFormat === "text") {
          const sessionMatch = line.match(/session(?:\s+id)?[^0-9a-f]*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
          if (sessionMatch) task.sessionId = sessionMatch[1];
          task.summary = `${task.summary}${task.summary ? "\n" : ""}${line}`.slice(-8000);
          await this.#event(task, "task.output", line);
          return;
        }
        receivedResult ||= await this.#handleAgentLine(task, line);
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      void this.#fail(task, error.message);
    });

    child.on("close", (code) => {
      void (async () => {
        this.#processes.delete(task.id);
        await processing;
        const after = await captureGitSnapshot(
          task.request.workdir,
          task.request.allowedFiles,
        );
        const changes = compareSnapshots(before, after);
        task.changedFiles = changes.changed;
        task.scopeWarnings = changes.changed.filter(
          (file) => !isAllowedPath(file, changes.allowed),
        );

        await this.store.set(task);

        for (const warning of task.scopeWarnings) {
          await this.#event(
            task,
            "task.scope-warning",
            `Flash changed a file outside allowedFiles: ${warning}`,
          );
        }

        await this.#checkEffectiveModel(task);

        if (task.status === "cancelled") return;
        if (task.status === "failed") return;
        const missingHahaReply = run.outputFormat === "stream-json"
          && (!receivedResult || !task.summary.trim());
        const missingTextReply = run.outputFormat === "text" && !task.summary.trim();
        if (code !== 0 || missingHahaReply || missingTextReply) {
          await this.#fail(
            task,
            stderr.trim() || (!receivedResult
              ? `${agent.label} exited without a final result. No model reply was received.`
              : `${agent.label} returned an empty final result.`),
          );
          return;
        }
        await this.#message(task, "executor", "result", task.summary);
        const requiresPlannerReview = task.workflowMode === "planner-adoption"
          || (task.workflowMode === "planner-led" && task.request.reviewAfterExecution !== false);
        if (requiresPlannerReview && task.plannerThreadId) {
          await this.#runPlannerVerification(task);
          return;
        }
        await this.#complete(task, task.summary || `${agent.label} process completed.`);
      })();
    });

    if (run.prompt !== null) child.stdin.write(run.prompt);
    child.stdin.end();
  }

  async #runPlannerVerification(task: RelayTask) {
    try {
      task.status = "waiting";
      task.workflowPhase = "planner-verification";
      await this.store.set(task);
      await this.#event(task, "task.planner-started", `Codex / Sol is reviewing Flash's real code changes in thread ${task.plannerThreadId}.`);
      const review = await this.planner.verifyImplementation(
        task,
        (summary) => this.#plannerProgress(task, summary),
      );
      task.plannerRounds = (task.plannerRounds ?? 0) + 1;
      task.plannerUsage = mergeUsage(task.plannerUsage ?? emptyUsage(), review.usage);
      await this.store.set(task);
      await this.#message(task, "planner", "result", review.summary);
      await this.#event(task, "task.planner-completed", `Sol verification returned ${review.verdict ?? "pass"}.`);

      if (review.verdict === "revise") {
        if ((task.plannerRounds ?? 0) >= maxPlannerRounds) {
          await this.#fail(task, `Sol still found issues after ${task.plannerRounds} review rounds: ${review.summary}`, "planner");
          return;
        }
        await this.#queueExecutor(task, review.instruction, true);
        return;
      }
      await this.#complete(task, `Sol final review passed: ${review.summary}`);
    } catch (error) {
      await this.#fail(task, error instanceof Error ? error.message : String(error), "planner");
    }
  }

  async #complete(task: RelayTask, message: string) {
    task.status = "completed";
    task.workflowPhase = "completed";
    task.finishedAt = new Date().toISOString();
    task.unread = true;
    await this.store.set(task);
    await this.#event(task, "task.completed", message);
    this.#releasePlanner(task);
  }

  async #handleAgentLine(task: RelayTask, line: string) {
    let payload: HahaJsonEvent;
    try {
      payload = JSON.parse(line) as HahaJsonEvent;
    } catch {
      await this.#event(task, "task.output", line);
      return false;
    }

    if (payload.session_id || payload.sessionID) {
      task.sessionId = payload.session_id ?? payload.sessionID ?? task.sessionId;
    }

    if (payload.type === "assistant") {
      const message =
        payload.message && typeof payload.message === "object"
          ? payload.message
          : undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          await this.#event(task, "task.output", block.text);
        }
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          await this.#event(task, "task.tool", `Flash called ${name}`, block.input);
        }
      }
    }

    if (payload.type === "user") {
      const message =
        payload.message && typeof payload.message === "object"
          ? payload.message
          : undefined;
      for (const block of message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const content = typeof block.content === "string" ? block.content : "Tool result";
        await this.#event(
          task,
          block.is_error ? "task.output" : "task.tool",
          content,
          block,
        );
      }
    }

    if (payload.type === "result") {
      const resultMessage = payload.result ?? readHahaError(payload);
      task.summary = payload.is_error ? "" : resultMessage;
      task.usage = readUsage(payload, task.usage);
      task.effectiveModel = task.usage.model;
      task.error = payload.is_error ? resultMessage : null;
      await this.store.set(task);
      if (payload.is_error) {
        task.status = "failed";
        task.finishedAt = new Date().toISOString();
        task.unread = true;
        await this.store.set(task);
        await this.#message(task, "executor", "error", resultMessage || "Task failed.");
        await this.#event(
          task,
          "task.failed",
          resultMessage || "Task failed.",
          payload,
        );
        this.#releasePlanner(task);
      }
      return true;
    }

    return false;
  }

  async #checkEffectiveModel(task: RelayTask) {
    task.effectiveModel = task.usage.model ?? task.effectiveModel;
    if (!task.effectiveModel || task.effectiveModel === task.requestedModel) {
      await this.store.set(task);
      return;
    }
    task.modelWarning = `Requested ${task.requestedModel}, but ${task.effectiveModel} handled the task.`;
    await this.store.set(task);
    await this.#event(task, "task.model-warning", task.modelWarning);
  }

  async #event(
    task: RelayTask,
    kind: RelayEventKind,
    message: string,
    detail?: unknown,
  ) {
    const event: RelayEvent = {
      id: randomUUID(),
      taskId: task.id,
      kind,
      timestamp: new Date().toISOString(),
      message,
      detail,
    };
    await this.store.appendEvent(task.id, event);
  }

  async #message(
    task: RelayTask,
    role: "planner" | "executor",
    kind: AgentConversationKind,
    content: string,
  ) {
    await this.store.appendMessage(task.id, {
      id: randomUUID(),
      role,
      agent: role === "planner"
        ? task.request.plannerAgent ?? "codex"
        : task.request.executorAgent ?? "claude-haha",
      model: role === "planner"
        ? task.request.plannerModel ?? ""
        : task.effectiveModel ?? task.requestedModel,
      timestamp: new Date().toISOString(),
      content,
      kind,
    });
  }

  async #plannerProgress(task: RelayTask, summary: string) {
    const content = summary.trim();
    if (!content) return;
    const lastPlannerMessage = [...(task.messages ?? [])].reverse().find((message) => message.role === "planner");
    if (lastPlannerMessage?.kind === "output" && lastPlannerMessage.content === content) return;
    await this.#message(task, "planner", "output", content);
  }

  async #fail(task: RelayTask, message: string, role: "planner" | "executor" = "executor") {
    task.status = "failed";
    task.error = message;
    task.finishedAt = new Date().toISOString();
    task.unread = true;
    await this.store.set(task);
    await this.#message(task, role, "error", message);
    await this.#event(task, "task.failed", message);
    this.#releasePlanner(task);
  }

  #releasePlanner(task: RelayTask) {
    if (task.plannerThreadId) this.planner.releaseThread?.(task.plannerThreadId);
  }

  #requireTask(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  #requireExecutor(agentId: string) {
    const agent = this.settingsStore.get().agents.find((item) => item.id === agentId);
    if (!agent || !agent.enabled) throw new Error(`Execution agent is unavailable: ${agentId}`);
    if (agent.role === "planner" || agent.transport === "host") {
      throw new Error(`Agent cannot execute implementation tasks: ${agentId}`);
    }
    return agent;
  }

  async #validateRequest(request: RelayTaskRequest): Promise<RelayTaskRequest> {
    if (!request.title?.trim()) throw new Error("title is required.");
    if (!request.objective?.trim()) throw new Error("objective is required.");
    if (!request.workdir?.trim()) throw new Error("workdir is required.");
    if (!request.allowedFiles?.length) {
      throw new Error("allowedFiles must contain at least one path.");
    }

    const workdir = path.resolve(request.workdir);
    const info = await stat(workdir);
    if (!info.isDirectory()) throw new Error(`workdir is not a directory: ${workdir}`);

    const allowedFiles = request.allowedFiles.map((file) => {
      const absolute = path.resolve(workdir, file);
      const relative = path.relative(workdir, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`allowedFiles path escapes workdir: ${file}`);
      }
      return normalizePath(relative || ".");
    });

    return {
      ...request,
      title: request.title.trim(),
      objective: request.objective.trim(),
      workdir,
      allowedFiles,
      contextFiles: request.contextFiles ?? [],
      constraints: request.constraints ?? [],
      acceptanceCommands: request.acceptanceCommands ?? [],
    };
  }

  #buildInitialPrompt(task: RelayTask) {
    return `You are the implementation worker. ${task.request.plannerAgent} (${task.request.plannerModel}) is the architect and final reviewer.\n\n` +
      `Repository: ${task.request.workdir}\n` +
      `Project: ${task.projectName}\n` +
      `Task ID: ${task.id}\n\n` +
      `Implement the JSON task below. Modify only allowedFiles. Do not redesign the architecture, broaden scope, commit, reset, restore, checkout, or overwrite unrelated uncommitted work. If another file must change, stop and explain why. Run acceptanceCommands when shell access is available. Finish with a concise implementation report.\n\n` +
      JSON.stringify(task.request, null, 2);
  }

  #buildFollowUpPrompt(task: RelayTask, instruction: string) {
    return `${task.request.plannerAgent} reviewed your previous implementation for task ${task.id}.\n` +
      `Apply only this follow-up instruction while preserving the original allowedFiles and constraints:\n\n${instruction}\n\n` +
      `Original task:\n${JSON.stringify(task.request, null, 2)}`;
  }
}

const readUsage = (payload: HahaJsonEvent, previous: RelayUsage): RelayUsage => {
  const modelEntry = Object.entries(payload.modelUsage ?? {})[0];
  const model = modelEntry?.[0] ?? previous.model;
  const modelUsage = modelEntry?.[1] ?? {};
  const usage = payload.usage ?? {};
  return {
    inputTokens:
      previous.inputTokens +
      (asNumber(modelUsage.inputTokens) || asNumber(usage.input_tokens)),
    outputTokens:
      previous.outputTokens +
      (asNumber(modelUsage.outputTokens) || asNumber(usage.output_tokens)),
    cacheReadTokens:
      previous.cacheReadTokens +
      (asNumber(modelUsage.cacheReadInputTokens) ||
        asNumber(usage.cache_read_input_tokens)),
    cacheCreationTokens:
      previous.cacheCreationTokens +
      (asNumber(modelUsage.cacheCreationInputTokens) ||
        asNumber(usage.cache_creation_input_tokens)),
    costUsd:
      previous.costUsd +
      (payload.total_cost_usd ?? asNumber(modelUsage.costUSD)),
    model,
  };
};

const mergeUsage = (previous: RelayUsage, next: RelayUsage): RelayUsage => ({
  inputTokens: previous.inputTokens + next.inputTokens,
  outputTokens: previous.outputTokens + next.outputTokens,
  cacheReadTokens: previous.cacheReadTokens + next.cacheReadTokens,
  cacheCreationTokens: previous.cacheCreationTokens + next.cacheCreationTokens,
  costUsd: previous.costUsd + next.costUsd,
  model: next.model ?? previous.model,
});

const readHahaError = (payload: HahaJsonEvent) => {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error) return JSON.stringify(payload.error);
  if (payload.errors?.length) return payload.errors.map(String).join("\n");
  if (typeof payload.message === "string") return payload.message;
  return `Haha reported ${payload.subtype ?? "an unknown error"}.`;
};

const captureGitSnapshot = async (
  workdir: string,
  allowedFiles: string[],
): Promise<GitSnapshot> => {
  try {
    const { stdout: rootOutput } = await execFileAsync(
      "git",
      ["-C", workdir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", windowsHide: true },
    );
    const repoRoot = rootOutput.trim();
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const statuses = parseGitStatus(stdout);
    const candidates = new Set(statuses.keys());
    for (const file of allowedFiles) {
      candidates.add(normalizePath(path.relative(repoRoot, path.resolve(workdir, file))));
    }

    const allowed = new Set(
      allowedFiles.map((file) =>
        normalizePath(path.relative(repoRoot, path.resolve(workdir, file))),
      ),
    );
    const entries = new Map<string, GitEntry>();
    for (const file of candidates) {
      entries.set(file, {
        status: statuses.get(file) ?? "  ",
        hash: await hashFile(path.join(repoRoot, file)),
      });
    }
    return { repoRoot, entries, allowed };
  } catch {
    return { repoRoot: null, entries: new Map(), allowed: new Set() };
  }
};

const parseGitStatus = (output: string) => {
  const entries = new Map<string, string>();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = normalizePath(record.slice(3));
    entries.set(file, status);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
};

const hashFile = async (filePath: string) => {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return info.isDirectory() ? "<directory>" : "<other>";
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "<missing>";
  }
};

const compareSnapshots = (before: GitSnapshot, after: GitSnapshot) => {
  if (!after.repoRoot) return { changed: [], allowed: new Set<string>() };
  const changed = new Set<string>();
  const files = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const file of files) {
    const left = before.entries.get(file);
    const right = after.entries.get(file);
    if (!left || !right || left.status !== right.status || left.hash !== right.hash) {
      changed.add(file);
    }
  }
  return { changed: [...changed].sort(), allowed: after.allowed };
};

const isAllowedPath = (file: string, allowed: Set<string>) => {
  for (const scope of allowed) {
    if (scope === "." || file === scope || file.startsWith(`${scope}/`)) return true;
  }
  return false;
};

const terminateProcess = async (child: ReturnType<typeof spawn>) => {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    } catch {
      // Fall back to Node's direct child termination.
    }
  }
  child.kill("SIGTERM");
};
