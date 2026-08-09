import type {
  RelayConfigView,
  HahaSessionImportRequest,
  HahaSessionSummary,
  RelaySettings,
  RelayTask,
  TokenMonitorSummary,
} from "../shared/types";

const json = async <T>(response: Response): Promise<T> => {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

export const getTasks = () => fetch("/api/tasks").then(json<RelayTask[]>);
export const getHahaSessions = (workdir: string) =>
  fetch(`/api/haha-sessions?workdir=${encodeURIComponent(workdir)}`).then(json<HahaSessionSummary[]>);
export const importHahaSession = (request: HahaSessionImportRequest) =>
  fetch("/api/tasks/import-haha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }).then(json<RelayTask>);
export const getConfig = () =>
  fetch("/api/config").then(json<RelayConfigView>);
export const getSettings = () =>
  fetch("/api/settings").then(json<RelaySettings>);
export const saveSettings = (settings: RelaySettings) =>
  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  }).then(json<RelaySettings>);
export const getTokenMonitor = (period = "today") =>
  fetch(`/api/token-monitor?period=${encodeURIComponent(period)}`).then(
    json<TokenMonitorSummary>,
  );
export const cancelTask = (taskId: string) =>
  fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" }).then(json<RelayTask>);
export const deleteTask = (taskId: string) =>
  fetch(`/api/tasks/${taskId}`, { method: "DELETE" }).then(json<{ id: string }>);
export const sendFollowUp = (taskId: string, instruction: string) =>
  fetch(`/api/tasks/${taskId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
  }).then(json<RelayTask>);
export const markTaskRead = (taskId: string) =>
  fetch(`/api/tasks/${taskId}/read`, { method: "POST" }).then(json<RelayTask>);
export const startVisibleFlashCheck = (workdir: string) =>
  fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Visible Flash self-check",
      objective: "Create .relay-data/visible-flash-proof/output.txt containing exactly FLASH_VISIBLE_OK, then reply with exactly FLASH_VISIBLE_OK.",
      workdir,
      allowedFiles: [".relay-data/visible-flash-proof/output.txt"],
      constraints: ["Do not modify any other file.", "Do not run package managers or tests."],
      plannerAgent: "codex",
      plannerModel: "gpt-5.6-sol",
      executorAgent: "claude-haha",
      model: "deepseek-v4-flash",
      effort: "low",
    }),
  }).then(json<RelayTask>);
