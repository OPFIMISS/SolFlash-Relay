import type { HahaSessionSummary, RelayTask, RelayUsage } from "../shared/types.js";
import { CodexAppServer } from "./codex-app-server.js";

export interface PlannerReview {
  threadId: string;
  summary: string;
  instruction: string;
  verdict?: "pass" | "revise";
  usage: RelayUsage;
}

export interface PlannerRunner {
  planTask(
    task: RelayTask,
    goal: string,
    onThreadCreated?: (threadId: string) => Promise<void>,
  ): Promise<PlannerReview>;
  reviewAdoption(
    task: RelayTask,
    session: HahaSessionSummary,
    goal: string,
    onThreadCreated?: (threadId: string) => Promise<void>,
  ): Promise<PlannerReview>;
  continueReview(task: RelayTask, goal: string): Promise<PlannerReview>;
  verifyImplementation(task: RelayTask): Promise<PlannerReview>;
}

const adoptionSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    instruction: { type: "string" },
  },
  required: ["summary", "instruction"],
  additionalProperties: false,
} as const;

const verificationSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    summary: { type: "string" },
    instruction: { type: "string" },
  },
  required: ["verdict", "summary", "instruction"],
  additionalProperties: false,
} as const;

export class CodexPlanner implements PlannerRunner {
  async planTask(task: RelayTask, goal: string, onThreadCreated?: (threadId: string) => Promise<void>) {
    const server = new CodexAppServer();
    try {
      await server.initialize();
      const threadId = await server.startThread({
        cwd: task.request.workdir,
        model: plannerModel(task),
        effort: plannerEffort(task),
        title: `${task.projectName} · ${task.request.title}`.slice(0, 96),
      });
      await onThreadCreated?.(threadId);
      const turn = await server.runTurn({
        threadId,
        model: plannerModel(task),
        effort: plannerEffort(task),
        outputSchema: adoptionSchema,
        prompt:
          `# SolFlash Relay 新任务：${task.request.title}\n\n` +
          `你是本任务真实的主策划 Agent。请先在当前项目目录只读理解需求和现有代码，不要修改文件，不要调用 SolFlash Relay MCP，也不要自行实现。\n\n` +
          `用户需求：\n${goal}\n\n` +
          `允许执行 Agent 修改的范围：\n${task.request.allowedFiles.map((file) => `- ${file}`).join("\n")}\n\n` +
          `约束：\n${(task.request.constraints ?? []).map((item) => `- ${item}`).join("\n") || "（无额外约束）"}\n\n` +
          `验收命令：\n${(task.request.acceptanceCommands ?? []).map((item) => `- ${item}`).join("\n") || "（由你根据项目决定）"}\n\n` +
          `请规划架构、文件边界、实现顺序和验收方式。输出 summary 给用户解释你的方案；输出 instruction 作为交给执行 Agent 的完整实现任务。`,
      });
      const result = parseResponse<{ summary: string; instruction: string }>(turn.finalResponse);
      if (!result.instruction.trim()) throw new Error("Planner returned an empty executor instruction.");
      return { threadId, summary: result.summary.trim(), instruction: result.instruction.trim(), usage: turn.usage };
    } finally {
      server.close();
    }
  }

  async reviewAdoption(
    task: RelayTask,
    session: HahaSessionSummary,
    goal: string,
    onThreadCreated?: (threadId: string) => Promise<void>,
  ) {
    const server = new CodexAppServer();
    try {
      await server.initialize();
      const threadId = await server.startThread({
        cwd: task.request.workdir,
        model: plannerModel(task),
        effort: plannerEffort(task),
        title: `${task.projectName} · Sol 接管 ${session.title}`.slice(0, 96),
      });
      await onThreadCreated?.(threadId);
      const turn = await server.runTurn({
        threadId,
        model: plannerModel(task),
        effort: plannerEffort(task),
        outputSchema: adoptionSchema,
        prompt:
          `# SolFlash Relay 接管：${session.title}\n\n` +
          `你是本任务真实的 Codex / Sol 决策层。请在当前项目目录进行只读审查，不要修改文件，不要调用 SolFlash Relay MCP，也不要把工作再次委派出去。\n\n` +
          `用户的接管目标：\n${goal}\n\n` +
          `已接管的 Haha 会话：\n- sessionId: ${session.sessionId}\n- 标题: ${session.title}\n- 模型: ${session.model}\n- 最近回复:\n${session.lastResponse || "（无）"}\n\n` +
          `允许 Flash 修改的文件：\n${task.request.allowedFiles.map((file) => `- ${file}`).join("\n")}\n\n` +
          `请读取相关源码、README 和 Git diff/status，判断 Flash 当前实现的问题。输出：\n` +
          `1. summary：给用户看的审查结论，说明你实际检查了什么。\n` +
          `2. instruction：给原 Haha Flash 会话的完整、明确、可执行纠偏指令，必须限制在 allowedFiles 内，并包含必要验收。`,
      });
      const result = parseResponse<{ summary: string; instruction: string }>(turn.finalResponse);
      if (!result.instruction.trim()) throw new Error("Codex planner returned an empty Flash instruction.");
      return {
        threadId,
        summary: result.summary.trim(),
        instruction: result.instruction.trim(),
        usage: turn.usage,
      };
    } finally {
      server.close();
    }
  }

  async verifyImplementation(task: RelayTask) {
    if (!task.plannerThreadId) throw new Error("Cannot verify without a Codex planner thread ID.");
    const server = new CodexAppServer();
    try {
      await server.initialize();
      await server.resumeThread(task.plannerThreadId, { cwd: task.request.workdir, model: plannerModel(task) });
      const turn = await server.runTurn({
        threadId: task.plannerThreadId,
        model: plannerModel(task),
        effort: plannerEffort(task),
        outputSchema: verificationSchema,
        prompt:
          `Flash 已在原 Haha sessionId ${task.sessionId} 完成一轮修改。\n\n` +
          `Flash 最终回复：\n${task.summary || "（空）"}\n\n` +
          `检测到的变更文件：\n${task.changedFiles.map((file) => `- ${file}`).join("\n") || "（无）"}\n\n` +
          `范围警告：\n${task.scopeWarnings.map((file) => `- ${file}`).join("\n") || "（无）"}\n\n` +
          `请继续在同一 Codex 对话中只读审查真实代码和 Git diff，不要修改文件，不要调用 Relay MCP。` +
          `若实现符合接管目标，verdict=pass 且 instruction 留空；若仍需修复，verdict=revise 并给出下一条完整 Flash 指令。`,
      });
      const result = parseResponse<{ verdict: "pass" | "revise"; summary: string; instruction: string }>(turn.finalResponse);
      if (result.verdict === "revise" && !result.instruction.trim()) {
        throw new Error("Codex planner requested revision but returned no instruction.");
      }
      return {
        threadId: task.plannerThreadId,
        verdict: result.verdict,
        summary: result.summary.trim(),
        instruction: result.instruction.trim(),
        usage: turn.usage,
      };
    } finally {
      server.close();
    }
  }

  async continueReview(task: RelayTask, goal: string) {
    if (!task.plannerThreadId) throw new Error("Cannot continue without a Codex planner thread ID.");
    const server = new CodexAppServer();
    try {
      await server.initialize();
      await server.resumeThread(task.plannerThreadId, { cwd: task.request.workdir, model: plannerModel(task) });
      const turn = await server.runTurn({
        threadId: task.plannerThreadId,
        model: plannerModel(task),
        effort: plannerEffort(task),
        outputSchema: adoptionSchema,
        prompt:
          `用户对接管任务补充了新的决策要求：\n${goal}\n\n` +
          `请在同一项目和同一 Codex 对话中只读检查当前代码、Git diff 和已有上下文。不要修改文件，不要调用 Relay MCP。` +
          `输出 summary 和一条准备交给原 Haha sessionId ${task.sessionId} 的完整 instruction。`,
      });
      const result = parseResponse<{ summary: string; instruction: string }>(turn.finalResponse);
      if (!result.instruction.trim()) throw new Error("Codex planner returned an empty Flash instruction.");
      return {
        threadId: task.plannerThreadId,
        summary: result.summary.trim(),
        instruction: result.instruction.trim(),
        usage: turn.usage,
      };
    } finally {
      server.close();
    }
  }
}

const plannerModel = (task: RelayTask) => task.request.plannerModel || "gpt-5.6-sol";
const plannerEffort = (task: RelayTask) => task.request.effort === "max" ? "xhigh" : task.request.effort ?? "high";

const parseResponse = <T>(value: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Codex planner returned invalid structured output: ${value.slice(0, 500)}`);
    return JSON.parse(match[0]) as T;
  }
};
