const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const executable = process.env.RELAY_PACKAGED_EXE
  || path.join(projectRoot, "release", "win-unpacked", "SolFlash Relay.exe");
const mcpScript = path.join(path.dirname(executable), "resources", "app.asar", "dist", "server", "mcp.js");
const port = 17422;
const relayUrl = `http://127.0.0.1:${port}`;
const testDataDir = path.join(projectRoot, ".relay-data", "packaged-mcp");

const transport = new StdioClientTransport({
  command: executable,
  args: [mcpScript],
  cwd: path.dirname(executable),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    RELAY_DESKTOP_EXECUTABLE: executable,
    RELAY_DESKTOP_CWD: path.dirname(executable),
    RELAY_PORT: String(port),
    RELAY_DATA_DIR: testDataDir,
    RELAY_USER_DATA_DIR: path.join(projectRoot, ".relay-data", "packaged-mcp-user-data"),
  },
  stderr: "pipe",
});
const stderr = [];
transport.stderr?.on("data", (chunk) => {
  const value = chunk.toString("utf8");
  stderr.push(value);
  process.stderr.write(value);
});

const client = new Client({ name: "relay-packaged-test", version: "0.5.0" });

async function withTimeout(promise, label, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processIdForPort() {
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"]);
    const line = stdout
      .split(/\r?\n/)
      .find((item) => item.includes(`127.0.0.1:${port}`) && /LISTENING\s+\d+\s*$/.test(item));
    return line?.match(/(\d+)\s*$/)?.[1];
  } catch {
    return undefined;
  }
}

async function stopTestDaemon() {
  const pid = await processIdForPort();
  if (!pid) return;
  await execFileAsync("taskkill.exe", ["/PID", pid, "/T", "/F"]).catch(() => undefined);
}

(async () => {
  await stopTestDaemon();
  await withTimeout(client.connect(transport), "portable MCP connect", 30000);
  try {
    const result = await withTimeout(client.listTools(), "portable MCP listTools");
    const names = result.tools.map((tool) => tool.name).sort();
    const expected = ["agent_run", "haha_adopt", "haha_sessions"];
    const missing = expected.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      throw new Error(`Missing packaged MCP tools (${missing.join(", ")}): ${names.join(", ")}`);
    }

    const health = await withTimeout(fetch(`${relayUrl}/api/health`), "portable daemon health");
    if (!health.ok) throw new Error(`Portable daemon health returned ${health.status}`);

    console.log(JSON.stringify({
      ok: true,
      executable,
      tools: names,
      daemon: await health.json(),
      stderr,
    }));
  } finally {
    await withTimeout(client.close(), "portable MCP close", 5000).catch(() => transport.close());
    await stopTestDaemon();
  }
})().catch(async (error) => {
  await stopTestDaemon();
  console.error(error);
  process.exitCode = 1;
});
