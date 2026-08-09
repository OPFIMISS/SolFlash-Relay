const { _electron: electron } = require("playwright");
const path = require("node:path");

(async () => {
  const electronApp = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELAY_DATA_DIR: path.resolve(".relay-data", "desktop-smoke"),
      RELAY_USER_DATA_DIR: path.resolve(".relay-data", "desktop-smoke-user-data"),
    },
  });
  try {
    const window = await electronApp.firstWindow({ timeout: 15000 });
    await window.waitForSelector(".dashboard-grid");
    const audit = await window.evaluate(() => ({
      desktopBridge: Boolean(window.relayDesktop),
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      title: document.title,
    }));
    if (!audit.desktopBridge) throw new Error("Sandboxed desktop preload bridge is unavailable");
    if (audit.horizontalOverflow) throw new Error("Desktop window has horizontal overflow");
    await window.screenshot({ path: path.join(".relay-data", "desktop-window.png"), fullPage: true });
    await window.getByTitle("Agent 与模型设置").click();
    await window.waitForSelector(".settings-dialog");
    if (!(await window.getByText("安装 Codex MCP").isVisible())) {
      throw new Error("Desktop MCP install command is not visible");
    }
    await window.screenshot({ path: path.join(".relay-data", "desktop-settings.png"), fullPage: true });
    await window.getByTitle("关闭").click();

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

    console.log(JSON.stringify({ ok: true, audit, minimumSize, background }));
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
