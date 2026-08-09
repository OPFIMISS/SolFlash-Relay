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
  getConfig,
  getHahaSessions,
  getSettings,
  getTasks,
  getTokenMonitor,
  importHahaSession,
  markTaskRead,
  sendFollowUp,
  saveSettings,
  startVisibleFlashCheck,
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

const statusLabels: Record<RelayTaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const statusIcons: Record<RelayTaskStatus, typeof Clock3> = {
  queued: Clock3,
  running: Radio,
  waiting: Clock3,
  completed: Check,
  failed: X,
  cancelled: CircleStop,
};

const tokenColors = ["#30796e", "#de6a49", "#d6a33a", "#5792a5"];

const formatTokens = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const formatCost = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;

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
      const next = await sendFollowUp(selected.id, followUp.trim());
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

  const openSettings = () => {
    if (!settings) return;
    setSettingsDraft(structuredClone(settings));
    setSettingsOpen(true);
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
      setDesktopMessage("已接管原 Haha 对话并发送纠偏指令；Relay 将继续使用同一个 sessionId。");
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
                  <StatusPill status={selected.status} />
                  <h2 id="detail-title">{selected.request.title}</h2>
                  <p>{selected.request.objective}</p>
                  <div className="project-context">
                    <strong>{selected.projectName}</strong>
                    <span title={selected.request.workdir}>{selected.request.workdir}</span>
                  </div>
                </div>
                <div className="detail-actions">
                  {selected.status === "running" && (
                    <button
                      className="secondary-button danger-button"
                      disabled={busy}
                      onClick={() => void stopSelected()}
                    >
                      <CircleStop size={17} />
                      停止
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
                <label htmlFor="follow-up">策划端返工指令</label>
                <div className="follow-up-input">
                  <textarea
                    id="follow-up"
                    value={followUp}
                    onChange={(event) => setFollowUp(event.target.value)}
                    placeholder="输入经过审查后的定点修复要求"
                    rows={2}
                  />
                  <button
                    className="primary-button"
                    disabled={busy || !followUp.trim() || selected.status === "running"}
                    onClick={() => void submitFollowUp()}
                    title="恢复同一执行 Agent 会话"
                  >
                    <Send size={18} />
                    发送
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
        <p className="adopt-note">先让当前生成停止，再接管。Relay 会恢复原 sessionId，不会创建新对话。</p>
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
          <label><span>第一条纠偏指令</span><textarea value={instruction} onChange={(event) => onInstruction(event.target.value)} placeholder="例如：先检查现有实现，不要重写架构；修复状态同步和错误处理，然后运行指定测试。" /></label>
        </div>
        <footer>
          <span className="adopt-session-id" title={selectedSession?.title}>
            {selectedSession ? `${selectedSession.title} · ${selectedSession.sessionId.slice(0, 8)}` : "尚未选择会话"}
          </span>
          <div className="dialog-save-actions">
            <button className="secondary-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || loading || !selectedId} onClick={onSubmit}><MessagesSquare size={16} />接管并发送</button>
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
}: {
  tasks: RelayTask[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
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
    ? "A · 主策划"
    : task.sourceSessionTitle
      ? `B · ${task.sourceSessionTitle}`
      : "B · 执行";
  const detail = isPlanner
    ? `${agent} · ${model}`
    : `${agent} · ${model} · ${task.sessionId.slice(0, 8)}`;
  return (
    <section className={`conversation-pane conversation-${role}`}>
      <header>
        <span className="conversation-avatar">{isPlanner ? <Code2 size={16} /> : <Bot size={16} />}</span>
        <div><strong title={title}>{title}</strong><small>{detail}</small></div>
        {!isPlanner && <StatusPill status={task.status} />}
      </header>
      <div className="conversation-messages">
        {messages.length > 0 ? messages.map((message) => (
          <article className={`conversation-message message-${message.kind}`} key={message.id}>
            <div><span>{message.kind === "follow-up" ? "返工指令" : message.kind === "error" ? "错误" : message.kind === "result" ? "最终回复" : message.kind === "output" ? "执行过程" : "任务指令"}</span><time>{formatTime(message.timestamp)}</time></div>
            <p>{message.content}</p>
          </article>
        )) : (
          <div className="conversation-empty">{isPlanner ? "等待策划指令" : "等待执行 Agent 回复"}</div>
        )}
      </div>
    </section>
  );
}

function TaskRow({ task, selected, onSelect }: { task: RelayTask; selected: boolean; onSelect: () => void }) {
  const Icon = statusIcons[task.status];
  return (
    <button className={`task-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className={`task-status-icon status-${task.status}`}><Icon size={16} /></span>
      <span className="task-copy">
        <strong>{task.unread && <i className="unread-dot" />}{task.request.title}</strong>
        <small>{task.request.objective}</small>
      </span>
      <span className="task-meta">
        <small>{formatTime(task.updatedAt)}</small>
        <b>{formatTokens(task.usage.inputTokens + task.usage.outputTokens)}</b>
      </span>
    </button>
  );
}

function StatusPill({ status }: { status: RelayTaskStatus }) {
  const Icon = statusIcons[status];
  return <span className={`status-pill status-${status}`}><Icon size={14} />{statusLabels[status]}</span>;
}

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
