import type {
  RelayConfigView,
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
export const sendFollowUp = (taskId: string, instruction: string) =>
  fetch(`/api/tasks/${taskId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
  }).then(json<RelayTask>);
