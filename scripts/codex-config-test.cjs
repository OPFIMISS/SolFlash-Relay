const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const { buildCodexMcpBlock, hasInstalledCodexMcp, mergeCodexMcpBlock } = await import(
    pathToFileURL(path.resolve("dist", "desktop", "codex-config.js")).href
  );
  const executable = "C:\\Program Files\\SolFlash Relay\\SolFlash Relay.exe";
  const appPath = "C:\\Program Files\\SolFlash Relay\\resources\\app.asar";
  const block = buildCodexMcpBlock(executable, appPath);
  const existing = [
    'model = "gpt-5.6-sol"',
    "",
    "# BEGIN sol-flash-relay",
    "obsolete = true",
    "# END sol-flash-relay",
    "",
    "[another_setting]",
    "enabled = true",
    "",
  ].join("\n");
  const merged = mergeCodexMcpBlock(existing, block);

  if (!merged.includes('model = "gpt-5.6-sol"') || !merged.includes("[another_setting]")) {
    throw new Error("MCP installation did not preserve unrelated Codex configuration");
  }
  if ((merged.match(/# BEGIN sol-flash-relay/g) ?? []).length !== 1) {
    throw new Error("MCP managed block replacement is not idempotent");
  }
  if (!merged.includes('ELECTRON_RUN_AS_NODE = "1"')) {
    throw new Error("Packaged MCP Node mode is missing");
  }
  if (!hasInstalledCodexMcp(merged, executable)) {
    throw new Error("Installed MCP status was not detected");
  }
  if (hasInstalledCodexMcp(merged, "C:\\Other\\Relay.exe")) {
    throw new Error("Stale MCP executable was incorrectly reported as installed");
  }

  console.log(JSON.stringify({ ok: true, preservedExistingConfig: true, idempotent: true, installed: true }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
