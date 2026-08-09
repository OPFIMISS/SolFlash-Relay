const { _electron: electron } = require("playwright");
const { rm } = require("node:fs/promises");
const path = require("node:path");

(async () => {
  const dataDir = path.resolve(".relay-data", "desktop-smoke");
  const userDataDir = path.resolve(".relay-data", "desktop-smoke-user-data");
  await rm(dataDir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  const electronApp = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELAY_PORT: "17426",
      RELAY_DATA_DIR: dataDir,
      RELAY_USER_DATA_DIR: userDataDir,
    },
  });
  try {
    const window = await electronApp.firstWindow({ timeout: 15000 });
    await window.waitForSelector(".dashboard-grid");
    const audit = await window.evaluate(async () => ({
      desktopBridge: Boolean(window.relayDesktop),
      desktopStatus: await window.relayDesktop?.getStatus(),
      copied: await window.relayDesktop?.copyUsagePrompt(),
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      title: document.title,
    }));
    if (!audit.desktopBridge) throw new Error("Sandboxed desktop preload bridge is unavailable");
    if (!audit.desktopStatus?.hosted || !audit.copied?.includes("已复制")) {
      throw new Error("Desktop activation status or usage prompt bridge is unavailable");
    }
    if (audit.horizontalOverflow) throw new Error("Desktop window has horizontal overflow");
    await window.screenshot({ path: path.join(".relay-data", "desktop-window.png"), fullPage: true });
    await window.getByTitle("Agent 与模型设置").click();
    await window.waitForSelector(".settings-dialog");
    await window.waitForTimeout(350);
    if (!(await window.getByText("安装 Codex MCP").isVisible())) {
      throw new Error("Desktop MCP install command is not visible");
    }
    await window.screenshot({ path: path.join(".relay-data", "desktop-settings.png"), fullPage: true });
    await window.getByTitle("关闭").click();

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await window.waitForTimeout(150);
    const notifyTaskId = await window.evaluate(async ({ workdir }) => {
      const settings = await fetch("/api/settings").then((response) => response.json());
      const notifyAgent = {
        id: "notification-test",
        label: "Notification Test",
        role: "executor",
        transport: "custom-cli",
        enabled: true,
        command: "cmd.exe",
        models: ["local-test"],
        defaultModel: "local-test",
        args: ["/d", "/s", "/c", "echo NOTIFY_OK"],
        outputFormat: "text",
        promptTransport: "stdin",
      };
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settings,
          executorAgent: notifyAgent.id,
          executorModel: notifyAgent.defaultModel,
          agents: [...settings.agents.filter((agent) => agent.id !== notifyAgent.id), notifyAgent],
        }),
      });
      const task = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Notification smoke test",
          objective: "Return NOTIFY_OK without changing files.",
          workdir,
          allowedFiles: [".relay-data/notification-smoke.txt"],
          executorAgent: notifyAgent.id,
          model: notifyAgent.defaultModel,
        }),
      }).then((response) => response.json());
      return task.id;
    }, { workdir: process.cwd() });
    if (!notifyTaskId) throw new Error("Notification smoke task was not created");
    await window.waitForFunction(async (taskId) => {
      const task = await fetch(`/api/tasks/${taskId}`).then((response) => response.json());
      return task.status === "completed";
    }, notifyTaskId, { timeout: 10000 });
    await window.waitForTimeout(1300);
    const statusWithUnread = await window.evaluate(() => window.relayDesktop?.getStatus());
    if (!statusWithUnread || statusWithUnread.unreadTasks < 1) {
      throw new Error("Completed execution did not set the Windows unread badge state");
    }
    await electronApp.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      target.hide();
      target.show();
      target.focus();
    });
    await window.waitForTimeout(400);
    const notificationAudit = await window.evaluate(async (taskId) => ({
      desktop: await window.relayDesktop?.getStatus(),
      task: await fetch(`/api/tasks/${taskId}`).then((response) => response.json()),
    }), notifyTaskId);
    if (notificationAudit.desktop?.unreadTasks !== 0 || notificationAudit.task.unread) {
      throw new Error("Focusing Relay did not clear the unread badge and task state");
    }

    await window.setViewportSize({ width: 980, height: 680 });
    const minimumSize = await window.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    if (minimumSize.horizontalOverflow) throw new Error("Minimum desktop window has horizontal overflow");
    await window.screenshot({ path: path.join(".relay-data", "desktop-minimum.png"), fullPage: true });

    await window.evaluate(() => window.close());
    await new Promise((resolve) => setTimeout(resolve, 500));
    const background = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return { windows: windows.length, visible: windows.some((item) => item.isVisible()) };
    });
    if (background.visible) throw new Error("Closing the desktop window did not hide it to the background");

    console.log(JSON.stringify({ ok: true, audit, notificationAudit, minimumSize, background }));
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
