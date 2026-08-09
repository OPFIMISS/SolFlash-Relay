const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solflash-token-monitor-"));
  const settingsPath = path.join(root, "settings.json");
  const fixture = {
    limitsEnabled: true,
    limitsRefreshMs: 300000,
    limitProviders: "claude,codex,deepseek,thirdparty",
    tokenMonitorSecret: "must-remain-untouched",
  };
  await writeFile(settingsPath, JSON.stringify(fixture), "utf8");

  try {
    const module = await import("../dist/desktop/token-monitor-compat.js");
    const before = await module.inspectTokenMonitorCompatibility(settingsPath);
    assert.equal(before.risk, true);
    assert.equal(before.refreshMs, 300000);

    const repaired = await module.disableTokenMonitorClaudePolling(settingsPath);
    assert.equal(repaired.risk, false);
    assert.equal(repaired.restartRequired, true);
    assert.ok(repaired.backupPath);

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.limitProviders, "codex,deepseek,thirdparty");
    assert.equal(saved.tokenMonitorSecret, fixture.tokenMonitorSecret);
    assert.deepEqual(JSON.parse(await readFile(repaired.backupPath, "utf8")), fixture);
    console.log(JSON.stringify({ ok: true, before, repaired, savedProviders: saved.limitProviders }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
