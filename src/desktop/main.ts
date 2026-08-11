import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RelayRuntime } from "../server/runtime.js";
import { relayVersion } from "../server/config.js";
import type { RelayTask } from "../shared/types.js";
import { buildCodexMcpBlock, hasInstalledCodexMcp, mergeCodexMcpBlock } from "./codex-config.js";
import { disableTokenMonitorClaudePolling, inspectTokenMonitorCompatibility } from "./token-monitor-compat.js";

const relayUrl = `http://${process.env.RELAY_HOST ?? "127.0.0.1"}:${process.env.RELAY_PORT ?? "17322"}`;
const backgroundMode = process.argv.includes("--background");
const mcpMode = process.argv.includes("--mcp");
const quitForUpdateMode = process.argv.includes("--quit-for-update");

app.setName("SolFlash Relay");
if (process.platform === "win32") app.setAppUserModelId("com.solflash.relay");
app.setPath(
  "userData",
  process.env.RELAY_USER_DATA_DIR || path.join(app.getPath("appData"), "SolFlash Relay"),
);
if (mcpMode) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: RelayRuntime | null = null;
let quitting = false;
const unreadTaskIds = new Set<string>();
const notifiedTaskIds = new Set<string>();
let eventRequest: ReturnType<typeof http.get> | null = null;
let eventPollTimer: NodeJS.Timeout | null = null;

console.error(`[desktop] bootstrap background=${backgroundMode} mcp=${mcpMode}`);
if (quitForUpdateMode) {
  stopPackagedInstancesForUpdate();
} else {
  const hasSingleInstanceLock = mcpMode || app.requestSingleInstanceLock();
  console.error(`[desktop] single-instance=${hasSingleInstanceLock}`);
  if (!hasSingleInstanceLock) {
    app.quit();
    process.exit(0);
  } else {
    if (!mcpMode) {
      app.on("second-instance", (_event, commandLine) => {
        if (commandLine.includes("--background")) return;
        void showWindow();
      });
    }
    void bootstrap().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[desktop] fatal\n${message}`);
      if (app.isReady()) dialog.showErrorBox("SolFlash Relay 启动失败", message);
      app.exit(1);
    });
  }
}

function stopPackagedInstancesForUpdate() {
  const executableName = path.basename(process.execPath);
  if (process.platform === "win32" && executableName.toLowerCase() === "solflash relay.exe") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/F", "/T", "/IM", executableName], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => app.exit(1));
    killer.unref();
    setTimeout(() => app.exit(0), 2000);
    return;
  }
  app.exit(0);
}

async function bootstrap() {
  await app.whenReady();
  console.error("[desktop] app ready");
  if (!backgroundMode && !mcpMode) await rm(userExitLockPath(), { force: true });
  configureEnvironment();

  if (mcpMode) {
    await import("../server/mcp.js");
    return;
  }

  await ensureRelay();
  console.error(`[desktop] relay ready at ${relayUrl}`);
  createTray();
  createApplicationMenu();
  registerIpc();
  await showWindow(undefined, backgroundMode);
  await syncUnreadTasks(false);
  connectTaskEvents();
  eventPollTimer = setInterval(() => void syncUnreadTasks(true), 1000);

  app.on("activate", () => void showWindow());
  app.on("window-all-closed", () => {
    // Closing the window keeps Relay hosted in the tray.
  });
}

function configureEnvironment() {
  const executable = desktopExecutable();
  process.env.RELAY_DATA_DIR ||= path.join(app.getPath("userData"), "relay-data");
  process.env.RELAY_DESKTOP_EXECUTABLE = executable;
  process.env.RELAY_DESKTOP_CWD = path.dirname(executable);
  process.env.RELAY_USER_EXIT_LOCK = userExitLockPath();
}

const userExitLockPath = () => path.join(app.getPath("userData"), "user-exit.lock");

async function ensureRelay() {
  try {
    const response = await fetch(`${relayUrl}/api/health`);
    if (response.ok) {
      const health = await response.json() as { version?: string };
      if (health.version === relayVersion) return;
      throw new Error(
        `端口 ${new URL(relayUrl).port} 正由旧版 Relay (${health.version ?? "0.3.x"}) 占用。` +
        `请先从托盘退出旧版，再启动 SolFlash Relay ${relayVersion}。`,
      );
    }
  } catch {
    try {
      const response = await fetch(`${relayUrl}/api/health`);
      if (response.ok) {
        const health = await response.json() as { version?: string };
        throw new Error(
          `检测到旧版 Relay (${health.version ?? "0.3.x"}) 仍在后台运行。` +
          `请退出旧版后再启动 ${relayVersion}，否则模型设置和任务记录会来自旧进程。`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("旧版 Relay")) throw error;
    }
  }
  const module = await import("../server/runtime.js");
  runtime = await module.startRelayRuntime();
}

async function showWindow(taskId?: string, startMinimized = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (startMinimized) {
      mainWindow.showInactive();
      mainWindow.minimize();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (taskId) mainWindow.webContents.send("relay:focus-task", taskId);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    skipTaskbar: false,
    backgroundColor: "#f3f3ef",
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== relayUrl && !url.startsWith(`${relayUrl}/`)) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.minimize();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!quitting) setTimeout(() => void showWindow(undefined, true), 0);
  });
  mainWindow.on("focus", () => void clearUnreadTasks());
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (startMinimized) mainWindow?.minimize();
  });
  await mainWindow.loadURL(relayUrl);
  updateOverlayIcon();
  if (taskId) mainWindow.webContents.send("relay:focus-task", taskId);
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 });
  if (image.isEmpty()) throw new Error(`无法加载托盘图标：${iconPath()}`);
  tray = new Tray(image);
  tray.setToolTip("SolFlash Relay");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制台", click: () => void showWindow() },
    { type: "separator" },
    { label: "退出", click: () => void shutdownAndQuit() },
  ]));
  tray.on("click", () => void showWindow());
}

function createApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "应用",
      submenu: [
        { label: "最小化到任务栏", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.minimize() },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => void shutdownAndQuit() },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
  ]));
}

function registerIpc() {
  ipcMain.handle("relay:install-mcp", installMcpConfig);
  ipcMain.handle("relay:get-status", getDesktopStatus);
  ipcMain.handle("relay:fix-token-monitor", fixTokenMonitorCompatibility);
  ipcMain.handle("relay:copy-usage-prompt", () => {
    clipboard.writeText(usagePrompt);
    return "已复制 Codex 使用指令。";
  });
  ipcMain.handle("relay:quit", async () => shutdownAndQuit());
}

async function getDesktopStatus() {
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  let current = "";
  try {
    current = await readFile(codexConfigPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    hosted: true,
    trayReady: Boolean(tray && !tray.isDestroyed()),
    taskbarReady: Boolean(mainWindow && !mainWindow.isDestroyed()),
    windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    windowMinimized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()),
    packaged: app.isPackaged,
    portable,
    canInstallMcp: app.isPackaged && !portable,
    mcpInstalled: hasInstalledCodexMcp(current, process.execPath),
    configPath: codexConfigPath(),
    unreadTasks: unreadTaskIds.size,
    tokenMonitorCompatibility: await inspectTokenMonitorCompatibility(tokenMonitorSettingsPath()),
  };
}

async function fixTokenMonitorCompatibility() {
  return disableTokenMonitorClaudePolling(tokenMonitorSettingsPath());
}

async function installMcpConfig() {
  if (!app.isPackaged) {
    throw new Error("请从打包后的 SolFlash Relay EXE 安装 MCP。开发模式仍使用 scripts/install-codex-mcp.ps1。 ");
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    throw new Error("便携版外壳不支持 MCP 所需的标准输入输出转发。请安装 Setup 版本，再从安装后的程序中执行此操作。");
  }
  const configPath = codexConfigPath();
  const block = buildCodexMcpBlock(process.execPath, app.getAppPath());
  await mkdir(path.dirname(configPath), { recursive: true });
  let current = "";
  try {
    current = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = mergeCodexMcpBlock(current, block);
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rm(configPath, { force: true });
  await rename(temporary, configPath);
  return `MCP 已安装到 ${configPath}。重启 Codex 后生效。`;
}

async function shutdownAndQuit() {
  if (quitting) return;
  quitting = true;
  await mkdir(path.dirname(userExitLockPath()), { recursive: true });
  await writeFile(userExitLockPath(), new Date().toISOString(), "utf8");
  const window = mainWindow;
  mainWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
  tray?.destroy();
  tray = null;
  try {
    eventRequest?.destroy();
    eventRequest = null;
    if (eventPollTimer) clearInterval(eventPollTimer);
    eventPollTimer = null;
    await runtime?.close();
  } catch (error) {
    dialog.showErrorBox("Relay 退出错误", error instanceof Error ? error.message : String(error));
  }
  app.exit(0);
}

function connectTaskEvents() {
  eventRequest?.destroy();
  eventRequest = http.get(`${relayUrl}/api/events`, (response) => {
    response.setEncoding("utf8");
    let buffer = "";
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data && frame.includes("event: task")) {
          try { handleTaskEvent(JSON.parse(data) as RelayTask); } catch { /* Ignore incomplete frames. */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    });
    response.on("end", () => {
      eventRequest = null;
      if (!quitting) setTimeout(connectTaskEvents, 1500);
    });
  });
  eventRequest.on("error", () => {
    eventRequest = null;
    if (!quitting) setTimeout(connectTaskEvents, 1500);
  });
}

function handleTaskEvent(task: RelayTask) {
  if (!task.unread || !["completed", "failed"].includes(task.status)) return;
  unreadTaskIds.add(task.id);
  updateOverlayIcon();
  if (notifiedTaskIds.has(task.id)) return;
  notifiedTaskIds.add(task.id);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: task.status === "completed" ? "执行 Agent 已完成" : "执行 Agent 任务失败",
    body: `${task.projectName} · ${task.request.title}\n${task.status === "completed" ? "Sol 可以开始审查结果。" : task.error ?? "请打开 Relay 查看详情。"}`,
    icon: iconPath(),
  });
  notification.on("click", () => void showWindow(task.id));
  notification.show();
}

async function syncUnreadTasks(notify: boolean) {
  try {
    createTray();
    const tasks = await fetch(`${relayUrl}/api/tasks`).then((response) => response.json()) as RelayTask[];
    const currentUnread = new Set(
      tasks.filter((task) => task.unread && ["completed", "failed"].includes(task.status)).map((task) => task.id),
    );
    for (const taskId of unreadTaskIds) {
      if (!currentUnread.has(taskId)) unreadTaskIds.delete(taskId);
    }
    for (const task of tasks) {
      if (!task.unread || !["completed", "failed"].includes(task.status)) continue;
      if (notify) handleTaskEvent(task);
      else unreadTaskIds.add(task.id);
    }
    updateOverlayIcon();
  } catch {
    // The event stream will retry after Relay is ready.
  }
}

async function clearUnreadTasks() {
  if (unreadTaskIds.size === 0) return;
  const ids = [...unreadTaskIds];
  unreadTaskIds.clear();
  updateOverlayIcon();
  await Promise.allSettled(ids.map((id) => fetch(`${relayUrl}/api/tasks/${id}/read`, { method: "POST" })));
}

function updateOverlayIcon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (unreadTaskIds.size === 0) {
    mainWindow.setOverlayIcon(null, "没有未读任务");
    return;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#d94343"/><text x="16" y="22" text-anchor="middle" font-family="Segoe UI" font-size="19" font-weight="700" fill="white">1</text></svg>`;
  const badge = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  mainWindow.setOverlayIcon(badge, `${unreadTaskIds.size} 个未读任务`);
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.resolve("build", "icon.png");
}

const desktopExecutable = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

const codexConfigPath = () => process.env.RELAY_CODEX_CONFIG
  || path.join(app.getPath("home"), ".codex", "config.toml");

const tokenMonitorSettingsPath = () => process.env.RELAY_TOKEN_MONITOR_SETTINGS
  || path.join(app.getPath("appData"), "Token Monitor", "settings.json");

const usagePrompt = `使用 SolFlash Relay 完成这个任务。你负责架构、UI 决策和最终审查；在明确文件范围、约束和验收命令后，优先通过 agent_run 把机械实现交给执行 Agent并等待最终回复。必须传入当前项目的绝对路径，完成后检查真实 diff 和测试，只在必要时用 flash_send 定点返工；需要异步运行时才使用 agent_start。`;
