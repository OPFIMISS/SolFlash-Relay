import {
  Activity,
  Bot,
  Cable,
  Check,
  CircleCheckBig,
  CircleDollarSign,
  CircleStop,
  Clock3,
  Code2,
  Cpu,
  Copy,
  FileCode2,
  Folder,
  FolderSearch,
  Gauge,
  GitCompareArrows,
  Moon,
  MessagesSquare,
  Percent,
  Pause,
  Play,
  Plus,
  Power,
  Radio,
  RefreshCw,
  ScanSearch,
  Rocket,
  Send,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sun,
  TerminalSquare,
  TriangleAlert,
  WalletCards,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

import type {
  RelayConfigView,
  RelayEvent,
  HahaSessionSummary,
  RelaySettings,
  RelayTask,
  RelayTaskStatus,
  TokenMonitorSummary,
} from "../shared/types";
import {
  cancelTask,
  deleteTask,
  getConfig,
  getHahaSessions,
  getSettings,
  getTasks,
  getTokenMonitor,
  importHahaSession,
  markTaskRead,
  pauseTask,
  resumeTask,
  sendFollowUp,
  sendPlannerFollowUp,
  saveSettings,
  startVisibleFlashCheck,
  startPlannerTask,
} from "./api";

const emptyMonitor: TokenMonitorSummary = {
  connected: false,
  source: "",
  error: null,
  projectLabel: "",
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

type DesktopStatus = Awaited<ReturnType<NonNullable<Window["relayDesktop"]>["getStatus"]>>;

interface NewTaskDraft {
  title: string;
  objective: string;
  workdir: string;
  allowedFiles: string;
  constraints: string;
  acceptanceCommands: string;
  plannerAgent: string;
  plannerModel: string;
  executorAgent: string;
  executorModel: string;
  effort: RelaySettings["executorEffort"];
  reviewAfterExecution: boolean;
}

const statusLabels: Record<RelayTaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const statusIcons: Record<RelayTaskStatus, typeof Clock3> = {
  queued: Clock3,
  running: Radio,
  waiting: Clock3,
  paused: Pause,
  completed: Check,
  failed: X,
  cancelled: CircleStop,
};

const workflowLabel = (task: RelayTask) => {
  if (task.status === "paused") return "已暂停";
  if (!task.workflowMode || task.workflowMode === "direct") return statusLabels[task.status];
  if (task.workflowPhase === "planner-review") return "Sol 审查中";
  if (task.workflowPhase === "executor-run") return task.status === "queued" ? "等待 Flash" : "Flash 执行中";
  if (task.workflowPhase === "planner-verification") return "Sol 复审中";
  if (task.workflowPhase === "completed") return "Sol 验收完成";
  return statusLabels[task.status];
};

const tokenColors = ["#30796e", "#de6a49", "#d6a33a", "#5792a5"];

const formatTokens = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const formatCost = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const splitLines = (value: string) => value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);

const formatTime = (value: string | null) => {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
};

export function App() {
  const [tasks, setTasks] = useState<RelayTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [config, setConfig] = useState<RelayConfigView | null>(null);
  const [monitor, setMonitor] = useState<TokenMonitorSummary>(emptyMonitor);
  const [settings, setSettings] = useState<RelaySettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<RelaySettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDraft, setNewTaskDraft] = useState<NewTaskDraft | null>(null);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptWorkdir, setAdoptWorkdir] = useState("");
  const [hahaSessions, setHahaSessions] = useState<HahaSessionSummary[]>([]);
  const [adoptSessionId, setAdoptSessionId] = useState("");
  const [adoptFiles, setAdoptFiles] = useState("");
  const [adoptInstruction, setAdoptInstruction] = useState("");
  const [adoptLoading, setAdoptLoading] = useState(false);
  const [desktopMessage, setDesktopMessage] = useState<string | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null);
  const [period, setPeriod] = useState("today");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("relay-theme") === "dark" ? "dark" : "light",
  );
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextConfig, nextMonitor, nextSettings] = await Promise.all([
        getTasks(),
        getConfig(),
        getTokenMonitor(period),
        getSettings(),
      ]);
      setTasks(nextTasks);
      setConfig(nextConfig);
      setMonitor(nextMonitor);
      setSettings(nextSettings);
      setSelectedId((current) => current ?? nextTasks[0]?.id ?? null);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [period]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    const events = new EventSource("/api/events");
    events.addEventListener("task", (event) => {
      const task = JSON.parse((event as MessageEvent).data) as RelayTask;
      setTasks((current) =>
        [task, ...current.filter((item) => item.id !== task.id)].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      );
      setSelectedId((current) => current ?? task.id);
    });
    events.addEventListener("task-deleted", (event) => {
      const { taskId } = JSON.parse((event as MessageEvent).data) as { taskId: string };
      setTasks((current) => current.filter((task) => task.id !== taskId));
      setSelectedId((current) => current === taskId ? null : current);
    });
    return () => {
      window.clearInterval(timer);
      events.close();
    };
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("relay-theme", theme);
  }, [theme]);

  useEffect(() => {
    void window.relayDesktop?.getStatus().then(setDesktopStatus).catch(() => undefined);
    return window.relayDesktop?.onFocusTask((taskId) => setSelectedId(taskId));
  }, []);

  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null;
  const projectGroups = useMemo(() => {
    const groups = new Map<string, RelayTask[]>();
    for (const task of tasks) {
      const key = task.request.workdir.replaceAll("/", "\\").toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    return [...groups.values()].sort((a, b) => b[0].updatedAt.localeCompare(a[0].updatedAt));
  }, [tasks]);
  const activeCount = tasks.filter((task) => task.status === "running").length;
  const totalUsage = tasks.reduce(
    (sum, task) => ({
      tokens: sum.tokens + task.usage.inputTokens + task.usage.outputTokens,
      cost: sum.cost + task.usage.costUsd,
    }),
    { tokens: 0, cost: 0 },
  );

  useEffect(() => {
    if (window.relayDesktop || !selected?.unread || document.visibilityState !== "visible" || !document.hasFocus()) return;
    void markTaskRead(selected.id).then((next) => {
      setTasks((current) => current.map((task) => task.id === next.id ? next : task));
    }).catch(() => undefined);
  }, [selected?.id, selected?.unread]);

  const submitFollowUp = async () => {
    if (!selected || !followUp.trim()) return;
    setBusy(true);
    try {
      const next = selected.workflowMode === "planner-adoption"
        ? await sendPlannerFollowUp(selected.id, followUp.trim())
        : await sendFollowUp(selected.id, followUp.trim());
      setTasks((current) => [next, ...current.filter((task) => task.id !== next.id)]);
      setFollowUp("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const stopSelected = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await cancelTask(selected.id);
      setTasks((current) => [next, ...current.filter((task) => task.id !== next.id)]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const pauseSelected = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await pauseTask(selected.id);
      setTasks((current) => [next, ...current.filter((task) => task.id !== next.id)]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const resumeSelected = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await resumeTask(selected.id);
      setTasks((current) => [next, ...current.filter((task) => task.id !== next.id)]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (taskId: string) => {
    setBusy(true);
    try {
      await deleteTask(taskId);
      setTasks((current) => current.filter((task) => task.id !== taskId));
      setSelectedId((current) => current === taskId ? null : current);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const openSettings = () => {
    if (!settings) return;
    setSettingsDraft(structuredClone(settings));
    setSettingsOpen(true);
  };

  const openNewTaskDialog = () => {
    if (!settings) return;
    setNewTaskDraft({
      title: "",
      objective: "",
      workdir: "",
      allowedFiles: "",
      constraints: "保留无关的用户改动\n不要提交、重置或覆盖工作区",
      acceptanceCommands: "",
      plannerAgent: settings.plannerAgent,
      plannerModel: settings.plannerModel,
      executorAgent: settings.executorAgent,
      executorModel: settings.executorModel,
      effort: settings.executorEffort,
      reviewAfterExecution: true,
    });
    setNewTaskOpen(true);
  };

  const submitNewTask = async () => {
    if (!newTaskDraft?.objective.trim()) {
      setError("请填写任务需求。");
      return;
    }
    setBusy(true);
    try {
      const task = await startPlannerTask({
        title: newTaskDraft.title.trim() || newTaskDraft.objective.trim().slice(0, 36),
        objective: newTaskDraft.objective.trim(),
        workdir: newTaskDraft.workdir.trim(),
        allowedFiles: splitLines(newTaskDraft.allowedFiles),
        constraints: splitLines(newTaskDraft.constraints),
        acceptanceCommands: splitLines(newTaskDraft.acceptanceCommands),
        plannerAgent: newTaskDraft.plannerAgent,
        plannerModel: newTaskDraft.plannerModel,
        executorAgent: newTaskDraft.executorAgent,
        model: newTaskDraft.executorModel,
        effort: newTaskDraft.effort,
        reviewAfterExecution: newTaskDraft.reviewAfterExecution,
      });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setSelectedId(task.id);
      setNewTaskOpen(false);
      setDesktopMessage("任务已交给真实主策划 Agent。策划完成后，Relay 才会创建同路径的执行 Agent 对话。");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const scanHahaSessions = async (workdir: string) => {
    if (!workdir.trim()) return;
    setAdoptLoading(true);
    try {
      const sessions = await getHahaSessions(workdir.trim());
      setHahaSessions(sessions);
      const first = sessions[0];
      setAdoptSessionId(first?.sessionId ?? "");
      setAdoptFiles(first?.changedFiles.join("\n") ?? "");
      if (sessions.length === 0) setDesktopMessage("这个项目路径下没有找到可接管的 Haha 对话。");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setAdoptLoading(false);
    }
  };

  const openAdoptDialog = () => {
    const workdir = selected?.request.workdir ?? "";
    setAdoptWorkdir(workdir);
    setHahaSessions([]);
    setAdoptSessionId("");
    setAdoptFiles("");
    setAdoptInstruction("");
    setAdoptOpen(true);
    if (workdir) void scanHahaSessions(workdir);
  };

  const submitAdopt = async () => {
    const allowedFiles = adoptFiles.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
    if (!adoptSessionId || allowedFiles.length === 0 || !adoptInstruction.trim()) {
      setError("请选择 Haha 对话，并填写允许文件和第一条纠偏指令。");
      return;
    }
    setBusy(true);
    try {
      const task = await importHahaSession({
        sessionId: adoptSessionId,
        workdir: adoptWorkdir.trim(),
        allowedFiles,
        instruction: adoptInstruction.trim(),
      });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setSelectedId(task.id);
      setAdoptOpen(false);
      setDesktopMessage("接管已启动：Relay 正在相同项目目录创建真实 Codex / Sol 对话。Sol 审查完成后才会把纠偏指令发送给原 Haha sessionId。");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const submitSettings = async () => {
    if (!settingsDraft) return;
    setBusy(true);
    try {
      const next = await saveSettings(settingsDraft);
      setSettings(next);
      setSettingsDraft(next);
      setSettingsOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const installDesktopMcp = async () => {
    if (!window.relayDesktop) return;
    setBusy(true);
    try {
      setDesktopMessage(await window.relayDesktop.installMcp());
      setDesktopStatus(await window.relayDesktop.getStatus());
    } catch (nextError) {
      setDesktopMessage(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const copyUsagePrompt = async () => {
    if (!window.relayDesktop) return;
    setDesktopMessage(await window.relayDesktop.copyUsagePrompt());
  };

  const fixTokenMonitor = async () => {
    if (!window.relayDesktop) return;
    setBusy(true);
    try {
      const compatibility = await window.relayDesktop.fixTokenMonitor();
      setDesktopStatus((current) => current ? { ...current, tokenMonitorCompatibility: compatibility } : current);
      setDesktopMessage(compatibility.message);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const runVisibleFlashCheck = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const task = await startVisibleFlashCheck(selected.request.workdir);
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setSelectedId(task.id);
      setDesktopMessage("已派发可见 Flash 自检。请在 Haha 的同项目会话中查看，Relay 会校验最终回复和实际模型。");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const planner = settings?.agents.find((agent) => agent.id === settings.plannerAgent);
  const executor = settings?.agents.find((agent) => agent.id === settings.executorAgent);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <GitCompareArrows size={19} />
          </div>
          <div>
            <h1>SolFlash Relay</h1>
            <p>多 Agent 本地控制面</p>
          </div>
        </div>

        <div className="agent-path" aria-label="Agent 链路状态">
          <AgentNode icon={Code2} label={planner?.label ?? "Planner"} detail={settings?.plannerModel ?? "未配置"} online={Boolean(settings)} />
          <span className="path-line" />
          <AgentNode icon={Server} label="Relay" detail="MCP" online={Boolean(config)} />
          <span className="path-line" />
          <AgentNode
            icon={Bot}
            label={executor?.label ?? "Executor"}
            detail={settings?.executorModel ?? "未配置"}
            online={Boolean(config)}
            active={activeCount > 0}
          />
        </div>

        <div className="toolbar">
          <button className="icon-button" title="新建主策划任务" onClick={openNewTaskDialog}>
            <Plus size={18} />
          </button>
          <button className="icon-button" title="接管已有 Haha 对话" onClick={openAdoptDialog}>
            <MessagesSquare size={18} />
          </button>
          <button className="icon-button" title="Agent 与模型设置" onClick={openSettings}>
            <Settings2 size={18} />
          </button>
          <button className="icon-button" title="刷新" onClick={() => void refresh()}>
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button"
            title={theme === "light" ? "深色模式" : "浅色模式"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={18} />
          <span>{error}</span>
          <button title="关闭" onClick={() => setError(null)}>
            <X size={17} />
          </button>
        </div>
      )}

      {desktopStatus && (
        <section className="activation-strip" aria-label="Relay 开启状态">
          <div className="activation-icon"><Rocket size={19} /></div>
          <div className="activation-copy">
            <strong>Relay 后台托管已开启</strong>
            <span>{desktopStatus.mcpInstalled
              ? "Codex MCP 已安装。现在可以在 Codex 中复制指令并派发第一个任务。"
              : desktopStatus.canInstallMcp
                ? "还差一步：安装 Codex MCP，然后重启 Codex。"
                : "便携版可托管后台；Codex MCP 请使用 Setup 安装版。"}</span>
          </div>
          <span className={`activation-state ${desktopStatus.mcpInstalled ? "ready" : "waiting"}`}>
            {desktopStatus.mcpInstalled ? <CircleCheckBig size={15} /> : <Cable size={15} />}
            {desktopStatus.mcpInstalled ? "已可用" : "待接入"}
          </span>
          <div className="activation-actions">
            {!desktopStatus.mcpInstalled && desktopStatus.canInstallMcp && (
              <button className="secondary-button" disabled={busy} onClick={() => void installDesktopMcp()}><Cable size={16} />安装 MCP</button>
            )}
            <button className="primary-button" onClick={() => void copyUsagePrompt()}><Copy size={16} />复制使用指令</button>
          </div>
        </section>
      )}

      <main className="dashboard-grid">
        <section className="queue-panel" aria-labelledby="queue-title">
          <div className="section-heading">
            <div>
              <span className="eyebrow">任务队列</span>
              <h2 id="queue-title">策划端派发的实现任务</h2>
            </div>
            <span className="count-badge">{tasks.length}</span>
          </div>

          <div className="task-list">
            {tasks.length === 0 ? (
              <div className="empty-state">
                <Zap size={24} />
                <strong>等待策划端派发任务</strong>
                <span>MCP 任务会自动出现在这里</span>
              </div>
            ) : (
              projectGroups.map((group) => (
                <ProjectGroup
                  key={group[0].request.workdir}
                  tasks={group}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelectedId}
                  onDelete={(taskId) => void removeTask(taskId)}
                />
              ))
            )}
          </div>
        </section>

        <section className="detail-panel" aria-labelledby="detail-title">
          {selected ? (
            <>
              <div className="detail-header">
                <div className="detail-title">
                  <StatusPill status={selected.status} label={workflowLabel(selected)} />
                  <h2 id="detail-title">{selected.request.title}</h2>
                  <p>{selected.request.objective}</p>
                  <div className="project-context">
                    <strong>{selected.projectName}</strong>
                    <span title={selected.request.workdir}>{selected.request.workdir}</span>
                  </div>
                </div>
                <div className="detail-actions">
                  {["queued", "running", "waiting"].includes(selected.status) && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void pauseSelected()}
                    >
                      <Pause size={17} />
                      暂停
                    </button>
                  )}
                  {selected.status === "paused" && (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void resumeSelected()}
                    >
                      <Play size={17} />
                      继续
                    </button>
                  )}
                  {["queued", "running", "waiting", "paused"].includes(selected.status) && (
                    <button
                      className="secondary-button danger-button"
                      disabled={busy}
                      onClick={() => void stopSelected()}
                    >
                      <CircleStop size={17} />
                      取消
                    </button>
                  )}
                </div>
              </div>

              <div className="metric-strip">
                <Metric label="执行 Agent" value={selected.request.executorAgent ?? "未记录"} icon={Bot} />
                <Metric label="实际模型" value={selected.effectiveModel ?? selected.requestedModel} icon={Cpu} />
                <Metric
                  label="Token"
                  value={formatTokens(selected.usage.inputTokens + selected.usage.outputTokens)}
                  icon={Gauge}
                />
                <Metric label="成本" value={formatCost(selected.usage.costUsd)} icon={CircleDollarSign} />
              </div>

              {selected.modelWarning && (
                <div className="model-warning" role="alert">
                  <TriangleAlert size={17} />
                  <span>{selected.modelWarning}</span>
                </div>
              )}

              <div className="conversation-stack" aria-label="双 Agent 项目对话">
                <ConversationPane task={selected} role="planner" />
                <ConversationPane task={selected} role="executor" />
              </div>

              <div className="detail-columns">
                <div className="activity-column">
                  <div className="subheading">
                    <Activity size={17} />
                    <h3>实时活动</h3>
                  </div>
                  <EventTimeline events={selected.events} />
                </div>

                <div className="scope-column">
                  <div className="subheading">
                    <FileCode2 size={17} />
                    <h3>变更范围</h3>
                  </div>
                  <FileList
                    allowed={selected.request.allowedFiles}
                    changed={selected.changedFiles}
                    warnings={selected.scopeWarnings}
                  />
                </div>
              </div>

              <div className="follow-up-bar">
                <label htmlFor="follow-up">{selected.workflowMode === "planner-adoption" ? "给 Codex / Sol 的补充决策要求" : "策划端返工指令"}</label>
                <div className="follow-up-input">
                  <textarea
                    id="follow-up"
                    value={followUp}
                    onChange={(event) => setFollowUp(event.target.value)}
                    placeholder={selected.workflowMode === "planner-adoption" ? "Sol 会先在同一个 Codex 对话中审查，再决定给 Flash 的指令" : "输入经过审查后的定点修复要求"}
                    rows={2}
                  />
                  <button
                    className="primary-button"
                    disabled={busy || !followUp.trim() || selected.status === "running" || selected.status === "queued" || selected.status === "waiting" || selected.status === "paused"}
                    onClick={() => void submitFollowUp()}
                    title={selected.workflowMode === "planner-adoption" ? "继续同一个 Codex 决策对话" : "恢复同一执行 Agent 会话"}
                  >
                    <Send size={18} />
                    {selected.workflowMode === "planner-adoption" ? "交给 Sol" : "发送"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state detail-empty">
              <TerminalSquare size={28} />
              <strong>Relay 已开启，等待 Codex 派发任务</strong>
              <span>安装 MCP 后，在 Codex 中粘贴上方使用指令即可开始</span>
            </div>
          )}
        </section>

        <aside className="insight-panel" aria-label="监控摘要">
          <TokenMonitorCard monitor={monitor} period={period} onPeriod={setPeriod} />

          <section className="summary-section">
            <div className="subheading">
              <Zap size={17} />
              <h3>Relay 本地消耗</h3>
            </div>
            <div className="summary-grid">
              <SummaryValue label="任务" value={String(tasks.length)} />
              <SummaryValue label="运行中" value={String(activeCount)} accent />
              <SummaryValue label="Token" value={formatTokens(totalUsage.tokens)} />
              <SummaryValue label="成本" value={formatCost(totalUsage.cost)} />
            </div>
          </section>

          <section className="connection-section">
            <div className="subheading">
              <Server size={17} />
              <h3>连接</h3>
            </div>
            <ConnectionRow label="MCP Relay" value={config ? `${config.host}:${config.port}` : "离线"} online={Boolean(config)} />
            <ConnectionRow label="执行 Agent" value={executor?.label ?? "未配置"} online={Boolean(executor)} />
            <ConnectionRow
              label="Token Monitor"
              value={desktopStatus?.tokenMonitorCompatibility.risk ? "有对话污染风险" : monitor.connected ? "安全接入" : "未运行"}
              online={monitor.connected && !desktopStatus?.tokenMonitorCompatibility.risk}
            />
            <button className="secondary-button self-check-button" disabled={!selected || busy} onClick={() => void runVisibleFlashCheck()} title="会产生一次很小的真实 Flash API 调用">
              <ScanSearch size={16} />验证当前项目的 Flash
            </button>
            {desktopStatus?.tokenMonitorCompatibility
              && (desktopStatus.tokenMonitorCompatibility.risk || desktopStatus.tokenMonitorCompatibility.restartRequired) && (
              <div className={`compatibility-alert ${desktopStatus.tokenMonitorCompatibility.risk ? "danger" : "fixed"}`}>
                {desktopStatus.tokenMonitorCompatibility.risk ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />}
                <div>
                  <strong>{desktopStatus.tokenMonitorCompatibility.risk ? "检测到 Haha 对话污染源" : "Claude 轮询已关闭"}</strong>
                  <span>{desktopStatus.tokenMonitorCompatibility.message}</span>
                </div>
                {desktopStatus.tokenMonitorCompatibility.repairable && (
                  <button className="secondary-button" disabled={busy} onClick={() => void fixTokenMonitor()}>
                    <ShieldCheck size={15} />一键修复
                  </button>
                )}
              </div>
            )}
          </section>
        </aside>
      </main>

      {settingsOpen && settingsDraft && (
        <SettingsDialog
          settings={settingsDraft}
          onChange={setSettingsDraft}
          onClose={() => setSettingsOpen(false)}
          onSave={() => void submitSettings()}
          onInstallMcp={window.relayDesktop ? () => void installDesktopMcp() : undefined}
          onQuit={window.relayDesktop ? () => void window.relayDesktop?.quit() : undefined}
          desktopMessage={desktopMessage}
          busy={busy}
        />
      )}
      {newTaskOpen && newTaskDraft && settings && (
        <NewTaskDialog
          draft={newTaskDraft}
          settings={settings}
          busy={busy}
          onChange={setNewTaskDraft}
          onClose={() => setNewTaskOpen(false)}
          onSubmit={() => void submitNewTask()}
        />
      )}
      {adoptOpen && (
        <AdoptHahaDialog
          workdir={adoptWorkdir}
          sessions={hahaSessions}
          selectedId={adoptSessionId}
          allowedFiles={adoptFiles}
          instruction={adoptInstruction}
          loading={adoptLoading}
          busy={busy}
          onWorkdir={setAdoptWorkdir}
          onScan={() => void scanHahaSessions(adoptWorkdir)}
          onSelect={(session) => {
            setAdoptSessionId(session.sessionId);
            setAdoptFiles(session.changedFiles.join("\n"));
          }}
          onAllowedFiles={setAdoptFiles}
          onInstruction={setAdoptInstruction}
          onClose={() => setAdoptOpen(false)}
          onSubmit={() => void submitAdopt()}
        />
      )}
    </div>
  );
}

function NewTaskDialog({
  draft,
  settings,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: NewTaskDraft;
  settings: RelaySettings;
  busy: boolean;
  onChange: (draft: NewTaskDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const planners = settings.agents.filter((agent) => agent.enabled && agent.role !== "executor");
  const executors = settings.agents.filter((agent) => agent.enabled && agent.role !== "planner" && agent.transport !== "host");
  const planner = planners.find((agent) => agent.id === draft.plannerAgent);
  const executor = executors.find((agent) => agent.id === draft.executorAgent);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-dialog new-task-dialog" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <header>
          <div><span className="eyebrow">Planner First</span><h2 id="new-task-title">新建多 Agent 任务</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <p className="adopt-note">主策划会先在项目路径创建真实对话并规划，再让执行 Agent 在同一路径新建对话。路径留空时，Relay 会创建独立的托管工作目录。</p>
        <div className="new-task-main-fields">
          <label><span>任务标题（可选）</span><input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="根据需求自动生成" /></label>
          <label><span>项目绝对路径（可选）</span><input value={draft.workdir} onChange={(event) => onChange({ ...draft, workdir: event.target.value })} placeholder="留空则创建 Relay 托管目录" /></label>
          <label className="new-task-objective"><span>想法 / 需求</span><textarea value={draft.objective} onChange={(event) => onChange({ ...draft, objective: event.target.value })} placeholder="描述你想做什么。主策划会先检查项目、决定框架和执行边界。" /></label>
        </div>
        <div className="settings-columns">
          <fieldset>
            <legend>主策划</legend>
            <label>Agent</label>
            <select value={draft.plannerAgent} onChange={(event) => {
              const next = planners.find((agent) => agent.id === event.target.value);
              onChange({ ...draft, plannerAgent: event.target.value, plannerModel: next?.defaultModel ?? "" });
            }}>
              {planners.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
            </select>
            <label>模型</label>
            <ModelField models={planner?.models ?? []} value={draft.plannerModel} onChange={(plannerModel) => onChange({ ...draft, plannerModel })} />
          </fieldset>
          <fieldset>
            <legend>执行端</legend>
            <label>Agent</label>
            <select value={draft.executorAgent} onChange={(event) => {
              const next = executors.find((agent) => agent.id === event.target.value);
              onChange({ ...draft, executorAgent: event.target.value, executorModel: next?.defaultModel ?? "" });
            }}>
              {executors.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
            </select>
            <label>模型</label>
            <ModelField models={executor?.models ?? []} value={draft.executorModel} onChange={(executorModel) => onChange({ ...draft, executorModel })} />
            <label>思考强度</label>
            <select value={draft.effort} onChange={(event) => onChange({ ...draft, effort: event.target.value as NewTaskDraft["effort"] })}>
              <option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">超高</option><option value="max">最大</option>
            </select>
          </fieldset>
        </div>
        <div className="adopt-fields new-task-scope-fields">
          <label><span>允许修改的文件 / 目录</span><textarea value={draft.allowedFiles} onChange={(event) => onChange({ ...draft, allowedFiles: event.target.value })} placeholder="每行一个；留空表示整个项目" /></label>
          <label><span>约束</span><textarea value={draft.constraints} onChange={(event) => onChange({ ...draft, constraints: event.target.value })} /></label>
          <label><span>验收命令</span><textarea value={draft.acceptanceCommands} onChange={(event) => onChange({ ...draft, acceptanceCommands: event.target.value })} placeholder="每行一个；可留空让主策划决定" /></label>
        </div>
        <label className="review-toggle"><input type="checkbox" checked={draft.reviewAfterExecution} onChange={(event) => onChange({ ...draft, reviewAfterExecution: event.target.checked })} /><span><strong>执行完成后返回主策划审查</strong><small>关闭后，执行 Agent 返回结果即结束；开启后，Sol 会检查真实代码并决定通过或返工。</small></span></label>
        <footer>
          <span className="adopt-session-id">{draft.workdir.trim() || "Relay 托管工作目录"}</span>
          <div className="dialog-save-actions">
            <button className="secondary-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || !draft.objective.trim()} onClick={onSubmit}><Plus size={16} />交给主策划</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function AdoptHahaDialog({
  workdir,
  sessions,
  selectedId,
  allowedFiles,
  instruction,
  loading,
  busy,
  onWorkdir,
  onScan,
  onSelect,
  onAllowedFiles,
  onInstruction,
  onClose,
  onSubmit,
}: {
  workdir: string;
  sessions: HahaSessionSummary[];
  selectedId: string;
  allowedFiles: string;
  instruction: string;
  loading: boolean;
  busy: boolean;
  onWorkdir: (value: string) => void;
  onScan: () => void;
  onSelect: (session: HahaSessionSummary) => void;
  onAllowedFiles: (value: string) => void;
  onInstruction: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const selectedSession = sessions.find((session) => session.sessionId === selectedId);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-dialog adopt-dialog" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
        <header>
          <div><span className="eyebrow">Existing Session</span><h2 id="adopt-title">接管 Haha 项目对话</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <p className="adopt-note">先让当前 Haha 生成停止。Relay 会在相同项目目录创建真实 Codex / Sol 对话完成审查，再恢复原 Haha sessionId 执行，不会新建 Haha 对话。</p>
        <div className="adopt-path-row">
          <label>
            <span>项目绝对路径</span>
            <input value={workdir} onChange={(event) => onWorkdir(event.target.value)} placeholder="C:\workspace\project" />
          </label>
          <button className="secondary-button" disabled={loading || !workdir.trim()} onClick={onScan}>
            <FolderSearch size={16} />{loading ? "扫描中" : "扫描对话"}
          </button>
        </div>
        <div className="adopt-session-list" aria-label="Haha 对话列表">
          {sessions.length > 0 ? sessions.map((session) => (
            <button
              key={session.sessionId}
              className={session.sessionId === selectedId ? "selected" : ""}
              onClick={() => onSelect(session)}
            >
              <span><strong>{session.title}</strong><small>{session.model} · {formatTime(session.updatedAt)}</small></span>
              <p>{session.lastResponse || session.lastPrompt || "暂无可预览回复"}</p>
            </button>
          )) : <div className="adopt-empty">输入项目路径并扫描可见 Haha 对话</div>}
        </div>
        <div className="adopt-fields">
          <label><span>允许修改的文件</span><textarea value={allowedFiles} onChange={(event) => onAllowedFiles(event.target.value)} placeholder="每行一个相对路径；已自动填入当前 Git 改动" /></label>
          <label><span>交给 Sol 的接管目标</span><textarea value={instruction} onChange={(event) => onInstruction(event.target.value)} placeholder="例如：审查 Flash 当前实现和 Git diff，判断架构、状态同步与错误处理问题，再生成明确的纠偏指令。" /></label>
        </div>
        <footer>
          <span className="adopt-session-id" title={selectedSession?.title}>
            {selectedSession ? `${selectedSession.title} · ${selectedSession.sessionId.slice(0, 8)}` : "尚未选择会话"}
          </span>
          <div className="dialog-save-actions">
            <button className="secondary-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || loading || !selectedId} onClick={onSubmit}><MessagesSquare size={16} />交给 Sol 接管</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SettingsDialog({
  settings,
  onChange,
  onClose,
  onSave,
  onInstallMcp,
  onQuit,
  desktopMessage,
  busy,
}: {
  settings: RelaySettings;
  onChange: (settings: RelaySettings) => void;
  onClose: () => void;
  onSave: () => void;
  onInstallMcp?: () => void;
  onQuit?: () => void;
  desktopMessage: string | null;
  busy: boolean;
}) {
  const planners = settings.agents.filter((agent) => agent.enabled && agent.role !== "executor");
  const executors = settings.agents.filter((agent) => agent.enabled && agent.role !== "planner" && agent.transport !== "host");
  const planner = planners.find((agent) => agent.id === settings.plannerAgent);
  const executor = executors.find((agent) => agent.id === settings.executorAgent);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span className="eyebrow">Relay Profile</span><h2 id="settings-title">Agent 与模型</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="settings-columns">
          <fieldset>
            <legend>主策划</legend>
            <label>Agent</label>
            <select value={settings.plannerAgent} onChange={(event) => {
              const next = planners.find((agent) => agent.id === event.target.value);
              onChange({ ...settings, plannerAgent: event.target.value, plannerModel: next?.defaultModel ?? "" });
            }}>
              {planners.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
            </select>
            <label>模型</label>
            <ModelField models={planner?.models ?? []} value={settings.plannerModel} onChange={(plannerModel) => onChange({ ...settings, plannerModel })} />
          </fieldset>
          <fieldset>
            <legend>执行端</legend>
            <label>Agent</label>
            <select value={settings.executorAgent} onChange={(event) => {
              const next = executors.find((agent) => agent.id === event.target.value);
              onChange({ ...settings, executorAgent: event.target.value, executorModel: next?.defaultModel ?? "" });
            }}>
              {executors.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
            </select>
            <label>模型</label>
            <ModelField models={executor?.models ?? []} value={settings.executorModel} onChange={(executorModel) => onChange({ ...settings, executorModel })} />
            <label>思考强度</label>
            <select value={settings.executorEffort} onChange={(event) => onChange({ ...settings, executorEffort: event.target.value as RelaySettings["executorEffort"] })}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">超高</option>
              <option value="max">最大</option>
            </select>
          </fieldset>
        </div>
        {desktopMessage && <div className="desktop-message">{desktopMessage}</div>}
        <footer>
          <div className="dialog-desktop-actions">
            {onInstallMcp && <button className="secondary-button" disabled={busy} onClick={onInstallMcp}><Cable size={16} />安装 Codex MCP</button>}
            {onQuit && <button className="icon-button danger-button" title="彻底退出" onClick={onQuit}><Power size={17} /></button>}
          </div>
          <div className="dialog-save-actions">
            <button className="secondary-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy} onClick={onSave}>保存</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ModelField({ models, value, onChange }: { models: string[]; value: string; onChange: (value: string) => void }) {
  const options = [...new Set(models.filter(Boolean))];
  const known = options.includes(value);
  return (
    <div className="model-field">
      <select value={known ? value : "__custom"} onChange={(event) => onChange(event.target.value === "__custom" ? "" : event.target.value)}>
        {options.map((model) => <option key={model} value={model}>{model}</option>)}
        <option value="__custom">自定义模型 ID…</option>
      </select>
      {!known && <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如 sol、luna 或中转站模型 ID" />}
    </div>
  );
}

function AgentNode({
  icon: Icon,
  label,
  detail,
  online,
  active = false,
}: {
  icon: typeof Bot;
  label: string;
  detail: string;
  online: boolean;
  active?: boolean;
}) {
  return (
    <div className={`agent-node ${active ? "is-active" : ""}`}>
      <span className="agent-icon"><Icon size={17} /></span>
      <span><strong>{label}</strong><small>{detail}</small></span>
      <i className={online ? "online" : ""} />
    </div>
  );
}

function ProjectGroup({
  tasks,
  selectedId,
  onSelect,
  onDelete,
}: {
  tasks: RelayTask[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}) {
  const project = tasks[0];
  const unread = tasks.filter((task) => task.unread).length;
  return (
    <section className="project-group">
      <header className="project-group-header" title={project.request.workdir}>
        <Folder size={15} />
        <span><strong>{project.projectName}</strong><small>{project.request.workdir}</small></span>
        {unread > 0 && <b>{unread}</b>}
      </header>
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          selected={task.id === selectedId}
          onSelect={() => onSelect(task.id)}
          onDelete={() => onDelete(task.id)}
        />
      ))}
    </section>
  );
}

function ConversationPane({ task, role }: { task: RelayTask; role: "planner" | "executor" }) {
  const messages = (task.messages ?? []).filter((message) => message.role === role);
  const isPlanner = role === "planner";
  const agent = isPlanner ? task.request.plannerAgent : task.request.executorAgent;
  const model = isPlanner
    ? task.request.plannerModel
    : task.effectiveModel ?? task.requestedModel;
  const title = isPlanner
    ? "A · Codex / Sol 决策层"
    : task.sourceSessionTitle
      ? `B · ${task.sourceSessionTitle}`
      : "B · 执行";
  const detail = isPlanner
    ? `${agent} · ${model}${task.plannerThreadId ? ` · 已创建 Codex 对话 · ${task.plannerThreadId}` : " · 等待创建真实对话"}`
    : `${agent} · ${model} · ${task.sessionId.slice(0, 8)}`;
  const phaseLabel = task.status === "paused"
    ? "已暂停"
    : isPlanner
    ? task.workflowPhase === "planner-review"
      ? "审查中"
      : task.workflowPhase === "planner-verification"
        ? "复审中"
        : task.workflowPhase === "completed"
          ? "验收完成"
          : task.plannerThreadId
            ? "已给出指令"
            : "等待启动"
    : task.workflowPhase === "planner-review"
      ? "等待 Sol"
      : task.workflowPhase === "planner-verification"
        ? "等待复审"
        : task.workflowPhase === "completed"
          ? "执行完成"
          : statusLabels[task.status];
  return (
    <section className={`conversation-pane conversation-${role}`}>
      <header>
        <span className="conversation-avatar">{isPlanner ? <Code2 size={16} /> : <Bot size={16} />}</span>
        <div><strong title={title}>{title}</strong><small title={detail}>{detail}</small></div>
        <div className="conversation-header-actions">
          {isPlanner && task.plannerThreadId && (
            <button
              className="icon-button compact-icon-button"
              title="复制完整 Codex 对话 ID"
              aria-label="复制完整 Codex 对话 ID"
              onClick={() => void navigator.clipboard.writeText(task.plannerThreadId ?? "")}
            ><Copy size={14} /></button>
          )}
          <StatusPill status={task.status} label={phaseLabel} />
        </div>
      </header>
      <div className="conversation-messages">
        {messages.length > 0 ? messages.map((message) => (
          <article className={`conversation-message message-${message.kind}`} key={message.id}>
            <div><span>{conversationMessageLabel(message.kind, isPlanner)}</span><time>{formatTime(message.timestamp)}</time></div>
            <p>{message.content}</p>
          </article>
        )) : (
          <div className="conversation-empty">{isPlanner ? "等待策划指令" : "等待执行 Agent 回复"}</div>
        )}
      </div>
    </section>
  );
}

function TaskRow({ task, selected, onSelect, onDelete }: { task: RelayTask; selected: boolean; onSelect: () => void; onDelete: () => void }) {
  const Icon = statusIcons[task.status];
  const canDelete = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  return (
    <div className={`task-row ${selected ? "selected" : ""}`} role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onSelect();
    }}>
      {canDelete ? (
        <button className={`task-status-icon task-delete status-${task.status}`} title="删除对话" aria-label={`删除 ${task.request.title}`} onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}><Icon size={16} /></button>
      ) : (
        <span className={`task-status-icon status-${task.status}`}><Icon size={16} /></span>
      )}
      <span className="task-copy">
        <strong>{task.unread && <i className="unread-dot" />}{task.request.title}</strong>
        <small>{task.request.objective}</small>
      </span>
      <span className="task-meta">
        <small>{formatTime(task.updatedAt)}</small>
        <b>{formatTokens(task.usage.inputTokens + task.usage.outputTokens)}</b>
      </span>
    </div>
  );
}

function StatusPill({ status, label }: { status: RelayTaskStatus; label?: string }) {
  const Icon = statusIcons[status];
  return <span className={`status-pill status-${status}`}><Icon size={14} />{label ?? statusLabels[status]}</span>;
}

const conversationMessageLabel = (kind: RelayTask["messages"][number]["kind"], isPlanner: boolean) => {
  if (kind === "error") return "错误";
  if (isPlanner) {
    if (kind === "instruction") return "接管目标";
    if (kind === "follow-up") return "给 Flash 的指令";
    if (kind === "result") return "Sol 复审结论";
    return "Sol 审查结论";
  }
  if (kind === "result") return "Flash 最终回复";
  if (kind === "output") return "Haha 原对话 / 执行过程";
  return kind === "follow-up" ? "返工指令" : "任务指令";
};

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Cpu }) {
  return <div className="metric"><Icon size={17} /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

function EventTimeline({ events }: { events: RelayEvent[] }) {
  const visible = [...events].reverse().slice(0, 40);
  if (visible.length === 0) return <div className="inline-empty">等待运行事件</div>;
  return (
    <div className="event-list">
      {visible.map((event) => (
        <div className={`event-row event-${event.kind.replace(".", "-")}`} key={event.id}>
          <span className="event-dot" />
          <div><p>{event.message}</p><time>{formatTime(event.timestamp)}</time></div>
        </div>
      ))}
    </div>
  );
}

function FileList({ allowed, changed, warnings }: { allowed: string[]; changed: string[]; warnings: string[] }) {
  const files = Array.from(new Set([...allowed, ...changed]));
  return (
    <div className="file-list">
      {files.map((file) => {
        const warning = warnings.includes(file);
        const touched = changed.includes(file);
        return (
          <div className={`file-row ${warning ? "warning" : ""}`} key={file}>
            {warning ? <ShieldAlert size={15} /> : <FileCode2 size={15} />}
            <span title={file}>{file}</span>
            <small>{warning ? "越界" : touched ? "已修改" : "允许"}</small>
          </div>
        );
      })}
    </div>
  );
}

function TokenMonitorCard({ monitor, period, onPeriod }: { monitor: TokenMonitorSummary; period: string; onPeriod: (value: string) => void }) {
  const data = useMemo(() => [
    { name: "输入", value: monitor.inputTokens },
    { name: "输出", value: monitor.outputTokens },
    { name: "缓存读取", value: monitor.cacheReadTokens },
    { name: "缓存写入", value: monitor.cacheCreationTokens },
  ].filter((item) => item.value > 0), [monitor]);
  const processedTokens = monitor.inputTokens + monitor.outputTokens + monitor.cacheReadTokens + monitor.cacheCreationTokens;
  const cacheEligibleTokens = monitor.inputTokens + monitor.cacheReadTokens;
  const savingsRate = processedTokens > 0 ? monitor.cacheReadTokens / processedTokens : 0;
  const cacheHitRate = cacheEligibleTokens > 0 ? monitor.cacheReadTokens / cacheEligibleTokens : 0;

  return (
    <section className="token-section">
      <div className="token-heading">
        <div><span className="eyebrow">Token Monitor</span><h2>{monitor.projectLabel || "项目用量"}</h2></div>
        <span className={`connection-dot ${monitor.connected ? "online" : ""}`} title={monitor.connected ? "已连接" : monitor.error ?? "未连接"} />
      </div>

      <div className="segmented-control" data-period={period} aria-label="统计周期">
        <span className="segment-indicator" aria-hidden="true" />
        {[{ id: "today", label: "今日" }, { id: "week", label: "本周" }, { id: "month", label: "本月" }].map((item) => (
          <button key={item.id} className={period === item.id ? "active" : ""} onClick={() => onPeriod(item.id)}>{item.label}</button>
        ))}
      </div>

      <div className="token-period-content" key={period}>
        <div className="token-chart">
          <ResponsiveContainer width="100%" height={168}>
            <PieChart>
              <Pie
                data={data.length ? data : [{ name: "无数据", value: 1 }]}
                dataKey="value"
                innerRadius={55}
                outerRadius={75}
                paddingAngle={data.length > 1 ? 3 : 0}
                stroke="none"
                animationDuration={420}
                animationEasing="ease-out"
              >
                {(data.length ? data : [{ name: "无数据", value: 1 }]).map((entry, index) => <Cell key={entry.name} fill={data.length ? tokenColors[index % tokenColors.length] : "var(--surface-muted)"} />)}
              </Pie>
              <Tooltip formatter={(value) => formatTokens(Number(value))} contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-raised)" }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="chart-center"><strong>{formatTokens(monitor.totalTokens)}</strong><span>Token</span></div>
        </div>

        <div className="token-totals">
          <SummaryValue label="成本" value={formatCost(monitor.totalCostUsd)} />
          <SummaryValue label="会话" value={String(monitor.sessions)} />
        </div>

        <div className="efficiency-grid">
          <SummaryValue label="缓存节省" value={formatTokens(monitor.cacheReadTokens)} accent />
          <SummaryValue label="节省率" value={`${(savingsRate * 100).toFixed(1)}%`} />
          <SummaryValue label="缓存命中" value={`${(cacheHitRate * 100).toFixed(1)}%`} />
          <SummaryValue label="实际处理" value={formatTokens(processedTokens)} />
        </div>

        {!monitor.connected && (
          <div className="monitor-offline"><WifiOff size={16} /><span>{monitor.error ?? "等待 Token Monitor Hub"}</span></div>
        )}

        {data.length > 0 && <div className="legend-list">{data.map((item, index) => <div key={item.name}><i style={{ background: tokenColors[index % tokenColors.length] }} /><span>{item.name}</span><strong>{formatTokens(item.value)}</strong></div>)}</div>}

        <div className="balance-section">
          <div className="balance-heading"><WalletCards size={15} /><strong>余额与额度</strong></div>
          {monitor.providerLimits.length > 0 ? monitor.providerLimits.map((limit) => (
            <div className="balance-row" key={limit.provider}>
              <div><strong>{limit.label}</strong><span>{limit.plan ?? limit.unit}</span></div>
              <div className="balance-value"><strong>{formatQuota(limit.remaining, limit.unit)}</strong><span>剩余</span></div>
              <div className="quota-track"><i style={{ width: `${Math.max(0, Math.min(100, 100 - limit.percentage))}%` }} /></div>
            </div>
          )) : <div className="balance-empty">Token Monitor 尚未提供中转站余额或额度数据</div>}
        </div>
      </div>
    </section>
  );
}

const formatQuota = (value: number, unit: string) => {
  if (/usd|dollar|\$/i.test(unit)) return formatCost(value);
  if (/token/i.test(unit)) return `${formatTokens(value)} Token`;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} ${unit === "quota" ? "额度" : unit}`;
};

function SummaryValue({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={`summary-value ${accent ? "accent" : ""}`}><small>{label}</small><strong>{value}</strong></div>;
}

function ConnectionRow({ label, value, online }: { label: string; value: string; online: boolean }) {
  return <div className="connection-row"><span><i className={online ? "online" : ""} />{label}</span><strong title={value}>{value}</strong></div>;
}
