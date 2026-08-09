import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RelayRuntime } from "../server/runtime.js";
import { buildCodexMcpBlock, hasInstalledCodexMcp, mergeCodexMcpBlock } from "./codex-config.js";

const relayUrl = `http://${process.env.RELAY_HOST ?? "127.0.0.1"}:${process.env.RELAY_PORT ?? "17322"}`;
const backgroundMode = process.argv.includes("--background");
const mcpMode = process.argv.includes("--mcp");

app.setName("SolFlash Relay");
app.setPath(
  "userData",
  process.env.RELAY_USER_DATA_DIR || path.join(app.getPath("appData"), "SolFlash Relay"),
);
if (mcpMode) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: RelayRuntime | null = null;
let quitting = false;

console.error(`[desktop] bootstrap background=${backgroundMode} mcp=${mcpMode}`);
const hasSingleInstanceLock = mcpMode || app.requestSingleInstanceLock();
console.error(`[desktop] single-instance=${hasSingleInstanceLock}`);
if (!hasSingleInstanceLock) {
  app.quit();
  process.exit(0);
} else if (!mcpMode) {
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

async function bootstrap() {
  await app.whenReady();
  console.error("[desktop] app ready");
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
  if (!backgroundMode) await showWindow();

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
}

async function ensureRelay() {
  try {
    const response = await fetch(`${relayUrl}/api/health`);
    if (response.ok) return;
  } catch {
    // Start an embedded Relay runtime below.
  }
  const module = await import("../server/runtime.js");
  runtime = await module.startRelayRuntime();
}

async function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
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
    mainWindow?.hide();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(relayUrl);
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 });
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
        { label: "隐藏到后台", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.hide() },
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
    packaged: app.isPackaged,
    portable,
    canInstallMcp: app.isPackaged && !portable,
    mcpInstalled: hasInstalledCodexMcp(current, process.execPath),
    configPath: codexConfigPath(),
  };
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
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, configPath);
  return `MCP 已安装到 ${configPath}。重启 Codex 后生效。`;
}

async function shutdownAndQuit() {
  if (quitting) return;
  quitting = true;
  tray?.destroy();
  tray = null;
  try {
    await runtime?.close();
  } catch (error) {
    dialog.showErrorBox("Relay 退出错误", error instanceof Error ? error.message : String(error));
  }
  app.quit();
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.resolve("build", "icon.png");
}

const desktopExecutable = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

const codexConfigPath = () => process.env.RELAY_CODEX_CONFIG
  || path.join(app.getPath("home"), ".codex", "config.toml");

const usagePrompt = `使用 SolFlash Relay 完成这个任务。你负责架构、UI 决策和最终审查；在明确文件范围、约束和验收命令后，通过 agent_start 把机械实现交给执行 Agent。必须传入当前项目的绝对路径，等待执行完成后检查真实 diff 和测试，只在必要时用 flash_send 定点返工。`;
