import { rm } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { config } from "./config.js";
import { startRelayRuntime } from "./runtime.js";

const projectRoot = process.cwd();
const port = 17326;
const dataDir = path.join(config.dataDir, "mcp-test");
await rm(dataDir, { recursive: true, force: true });
const runtime = await startRelayRuntime({
  ...config,
  port,
  dataDir,
  hahaStateDir: path.join(dataDir, "haha-state"),
});
const childEnv = Object.fromEntries(
  Object.entries({ ...process.env, RELAY_PORT: String(port) })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "dist", "server", "mcp.js")],
  cwd: projectRoot,
  env: childEnv,
  stderr: "pipe",
});
const stderr: string[] = [];
transport.stderr?.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stderr.push(text);
  process.stderr.write(text);
});

const client = new Client({ name: "relay-self-test", version: "0.1.0" });

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = 10000) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

await withTimeout(client.connect(transport), "MCP connect");

try {
  const tools = await withTimeout(client.listTools(), "MCP listTools");
  const names = tools.tools.map((tool) => tool.name).sort();
  for (const expected of [
    "agent_start",
    "agent_run",
    "flash_cancel",
    "flash_list",
    "flash_send",
    "flash_start",
    "flash_status",
    "flash_wait",
    "relay_profiles",
    "relay_register_agent",
    "relay_set_profile",
  ]) {
    if (!names.includes(expected)) throw new Error(`Missing MCP tool: ${expected}`);
  }

  const result = await withTimeout(
    client.callTool({ name: "flash_list", arguments: { limit: 1 } }),
    "MCP flash_list",
  );
  if (result.isError) throw new Error(`flash_list returned an MCP error: ${JSON.stringify(result)}`);

  const profiles = await withTimeout(
    client.callTool({ name: "relay_profiles", arguments: {} }),
    "MCP relay_profiles",
  );
  if (profiles.isError) throw new Error(`relay_profiles returned an MCP error: ${JSON.stringify(profiles)}`);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!health.ok) throw new Error(`Detached daemon health returned ${health.status}`);

  console.log(JSON.stringify({ ok: true, tools: names, daemon: await health.json(), stderr }));
} finally {
  await withTimeout(client.close(), "MCP close", 3000).catch(() => transport.close());
  await runtime.close();
  await rm(dataDir, { recursive: true, force: true });
}
