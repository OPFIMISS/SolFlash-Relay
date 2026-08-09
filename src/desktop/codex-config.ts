import path from "node:path";

const relaySections = new Set([
  "mcp_servers.sol_flash_relay",
  "mcp_servers.sol_flash_relay.env",
]);

export const escapeToml = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export const buildCodexMcpBlock = (executablePath: string, appPath: string) => {
  const executable = escapeToml(executablePath);
  const executableDir = escapeToml(path.dirname(executablePath));
  const mcpScript = escapeToml(path.join(appPath, "dist", "server", "mcp.js"));
  return [
    "# BEGIN sol-flash-relay",
    "[mcp_servers.sol_flash_relay]",
    `command = "${executable}"`,
    `args = ["${mcpScript}"]`,
    `cwd = "${executableDir}"`,
    "enabled = true",
    "startup_timeout_sec = 15",
    "tool_timeout_sec = 900",
    "",
    "[mcp_servers.sol_flash_relay.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    `RELAY_DESKTOP_EXECUTABLE = "${executable}"`,
    `RELAY_DESKTOP_CWD = "${executableDir}"`,
    "# END sol-flash-relay",
  ].join("\r\n");
};

export const mergeCodexMcpBlock = (current: string, block: string) => {
  const base = removeCodexMcpBlocks(current).trimEnd();
  return `${base}${base ? "\r\n\r\n" : ""}${block}\r\n`;
};

export const hasInstalledCodexMcp = (current: string, executablePath: string) => {
  const normalized = current.replaceAll("\r\n", "\n");
  return normalized.includes("[mcp_servers.sol_flash_relay]")
    && normalized.includes("[mcp_servers.sol_flash_relay.env]")
    && normalized.includes('ELECTRON_RUN_AS_NODE = "1"')
    && normalized.includes(escapeToml(executablePath));
};

export const removeCodexMcpBlocks = (current: string) => {
  const output: string[] = [];
  let skipSection = false;
  for (const line of current.replaceAll("\r\n", "\n").split("\n")) {
    if (/^\s*# (?:BEGIN|END) sol-flash-relay\s*$/.test(line)) continue;
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
    if (header) skipSection = relaySections.has(header);
    if (!skipSection) output.push(line);
  }
  return output.join("\r\n").replace(/(?:\r\n){3,}/g, "\r\n\r\n");
};
