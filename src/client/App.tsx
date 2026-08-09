import {
  Activity,
  Bot,
  Cable,
  Check,
  CircleDollarSign,
  CircleStop,
  Clock3,
  Code2,
  Cpu,
  FileCode2,
  Gauge,
  GitCompareArrows,
  Moon,
  Power,
  Radio,
  RefreshCw,
  Send,
  Server,
  Settings2,
  ShieldAlert,
  Sun,
  TerminalSquare,
  TriangleAlert,
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
  RelaySettings,
  RelayTask,
  RelayTaskStatus,
  TokenMonitorSummary,
} from "../shared/types";
import {
  cancelTask,
  getConfig,
  getSettings,
  getTasks,
  getTokenMonitor,
  sendFollowUp,
  saveSettings,
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
  updatedAt: null,
};

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
  const [desktopMessage, setDesktopMessage] = useState<string | null>(null);
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

  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null;
  const activeCount = tasks.filter((task) => task.status === "running").length;
  const totalUsage = tasks.reduce(
    (sum, task) => ({
      tokens: sum.tokens + task.usage.inputTokens + task.usage.outputTokens,
      cost: sum.cost + task.usage.costUsd,
    }),
    { tokens: 0, cost: 0 },
  );

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
    } catch (nextError) {
      setDesktopMessage(nextError instanceof Error ? nextError.message : String(nextError));
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
              tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  selected={task.id === selected?.id}
                  onSelect={() => setSelectedId(task.id)}
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
              <strong>尚无任务详情</strong>
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
            <ConnectionRow label="Token Monitor" value={monitor.connected ? "已接入" : "未运行"} online={monitor.connected} />
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
            <input list="planner-models" value={settings.plannerModel} onChange={(event) => onChange({ ...settings, plannerModel: event.target.value })} />
            <datalist id="planner-models">{planner?.models.map((model) => <option key={model} value={model} />)}</datalist>
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
            <input list="executor-models" value={settings.executorModel} onChange={(event) => onChange({ ...settings, executorModel: event.target.value })} />
            <datalist id="executor-models">{executor?.models.map((model) => <option key={model} value={model} />)}</datalist>
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

function TaskRow({ task, selected, onSelect }: { task: RelayTask; selected: boolean; onSelect: () => void }) {
  const Icon = statusIcons[task.status];
  return (
    <button className={`task-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className={`task-status-icon status-${task.status}`}><Icon size={16} /></span>
      <span className="task-copy">
        <strong>{task.request.title}</strong>
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

  return (
    <section className="token-section">
      <div className="token-heading">
        <div><span className="eyebrow">Token Monitor</span><h2>{monitor.projectLabel || "项目用量"}</h2></div>
        <span className={`connection-dot ${monitor.connected ? "online" : ""}`} title={monitor.connected ? "已连接" : monitor.error ?? "未连接"} />
      </div>

      <div className="segmented-control" data-period={period} aria-label="统计周期">
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

        {!monitor.connected && (
          <div className="monitor-offline"><WifiOff size={16} /><span>{monitor.error ?? "等待 Token Monitor Hub"}</span></div>
        )}

        {data.length > 0 && <div className="legend-list">{data.map((item, index) => <div key={item.name}><i style={{ background: tokenColors[index % tokenColors.length] }} /><span>{item.name}</span><strong>{formatTokens(item.value)}</strong></div>)}</div>}
      </div>
    </section>
  );
}

function SummaryValue({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={`summary-value ${accent ? "accent" : ""}`}><small>{label}</small><strong>{value}</strong></div>;
}

function ConnectionRow({ label, value, online }: { label: string; value: string; online: boolean }) {
  return <div className="connection-row"><span><i className={online ? "online" : ""} />{label}</span><strong title={value}>{value}</strong></div>;
}
