const { _electron: electron } = require("playwright");
const { readFile, rm } = require("node:fs/promises");
const path = require("node:path");

const projectRoot = process.cwd();
const executable = path.join(projectRoot, "release", "win-unpacked", "SolFlash Relay.exe");
const configPath = path.join(projectRoot, ".relay-data", "packaged-desktop", "config.toml");

(async () => {
  await rm(path.dirname(configPath), { recursive: true, force: true });
  const electronApp = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      RELAY_PORT: "17423",
      RELAY_DATA_DIR: path.join(projectRoot, ".relay-data", "packaged-desktop", "data"),
      RELAY_USER_DATA_DIR: path.join(projectRoot, ".relay-data", "packaged-desktop", "user-data"),
      RELAY_CODEX_CONFIG: configPath,
    },
  });
  try {
    const window = await electronApp.firstWindow({ timeout: 20000 });
    await window.waitForSelector(".dashboard-grid");
    await window.getByTitle("Agent 与模型设置").click();
    await window.getByText("安装 Codex MCP").click();
    await window.waitForSelector(".desktop-message");

    const message = await window.locator(".desktop-message").innerText();
    const config = await readFile(configPath, "utf8");
    for (const expected of [
      "[mcp_servers.sol_flash_relay]",
      `command = "${executable.replaceAll("\\", "\\\\")}"`,
      "ELECTRON_RUN_AS_NODE = \"1\"",
      "RELAY_DESKTOP_EXECUTABLE",
      "dist\\\\server\\\\mcp.js",
    ]) {
      if (!config.includes(expected)) throw new Error(`Installed MCP config is missing: ${expected}`);
    }

    console.log(JSON.stringify({ ok: true, executable, configPath, message }));
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
