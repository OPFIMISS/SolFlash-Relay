import path from "node:path";

const managedPattern = /^# BEGIN sol-flash-relay\r?\n.*?^# END sol-flash-relay\r?\n?/gms;

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
  const base = current.replace(managedPattern, "").trimEnd();
  return `${base}${base ? "\r\n\r\n" : ""}${block}\r\n`;
};

export const hasInstalledCodexMcp = (current: string, executablePath: string) => {
  const managedBlock = current.match(managedPattern)?.[0] ?? "";
  return managedBlock.includes("ELECTRON_RUN_AS_NODE")
    && managedBlock.includes(escapeToml(executablePath));
};
