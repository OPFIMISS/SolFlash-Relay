const { _electron: electron } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const { rm } = require("node:fs/promises");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, ms, message) => Promise.race([
  promise,
  sleep(ms).then(() => { throw new Error(message); }),
]);

(async () => {
  const executable = path.resolve("release", "win-unpacked", "SolFlash Relay.exe");
  const dataDir = path.resolve(".relay-data", "packaged-background");
  const userDataDir = path.resolve(".relay-data", "packaged-background-user-data");
  await rm(dataDir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  const env = {
    ...process.env,
    RELAY_PORT: "17428",
    RELAY_DATA_DIR: dataDir,
    RELAY_USER_DATA_DIR: userDataDir,
  };

  console.log("[packaged-background] launching packaged host");
  const electronApp = await electron.launch({ executablePath: executable, env });
  const mainPid = electronApp.process().pid;
  try {
    const window = await withTimeout(electronApp.firstWindow(), 15000, "Packaged window did not open");
    await window.waitForSelector(".dashboard-grid");
    console.log("[packaged-background] minimizing through close action");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(500);
    const status = await window.evaluate(() => window.relayDesktop?.getStatus());
    if (!status?.hosted || !status.trayReady || !status.taskbarReady || !status.windowMinimized) {
      throw new Error(`Packaged background entry points are incomplete: ${JSON.stringify(status)}`);
    }

    console.log("[packaged-background] requesting update shutdown");
    const quitProcess = spawn(executable, ["--quit-for-update"], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      quitProcess.once("error", reject);
      quitProcess.once("exit", resolve);
    });

    let exited = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(mainPid, 0);
      } catch {
        exited = true;
        break;
      }
      await sleep(100);
    }
    if (!exited) throw new Error("--quit-for-update did not stop the packaged background host");
    console.log("[packaged-background] checking standalone update shutdown");
    const standaloneQuit = spawn(executable, ["--quit-for-update"], {
      env: { ...env, RELAY_USER_DATA_DIR: `${userDataDir}-standalone` },
      windowsHide: true,
      stdio: "ignore",
    });
    const standaloneCode = await Promise.race([
      new Promise((resolve, reject) => {
        standaloneQuit.once("error", reject);
        standaloneQuit.once("exit", resolve);
      }),
      sleep(5000).then(() => "timeout"),
    ]);
    if (standaloneCode === "timeout") {
      standaloneQuit.kill();
      throw new Error("Standalone --quit-for-update did not exit promptly");
    }
    console.log(JSON.stringify({ ok: true, status, quitForUpdate: true, standaloneQuit: true }));
  } finally {
    await Promise.race([electronApp.close().catch(() => undefined), sleep(3000)]);
    try {
      process.kill(mainPid, 0);
      spawnSync("taskkill", ["/PID", String(mainPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      // The packaged process already exited.
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
