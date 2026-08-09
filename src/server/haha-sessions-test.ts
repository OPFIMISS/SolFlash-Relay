import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { discoverHahaSessions } from "./haha-sessions.js";
import { SettingsStore } from "./settings-store.js";
import { TaskManager } from "./task-manager.js";
import { TaskStore } from "./task-store.js";

const root = path.join(config.dataDir, "haha-sessions-test");
const workdir = path.join(root, "workspace");
const claudeRoot = path.join(root, ".claude");
const projectDir = path.join(claudeRoot, "projects", "fixture-project");
const sessionId = "11111111-2222-4333-8444-555555555555";
await rm(root, { recursive: true, force: true });
await mkdir(path.join(workdir, "src"), { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(workdir, "src", "App.tsx"), "export {};\n", "utf8");

const sessionLines = [
  { type: "custom-title", customTitle: "Flash UI scaffold", sessionId },
  { type: "user", sessionId, cwd: workdir, message: { role: "user", content: "Build the first UI scaffold." } },
  { type: "assistant", sessionId, cwd: workdir, message: { role: "assistant", model: "deepseek-v4-flash", content: [{ type: "text", text: "The scaffold is ready, but state sync still needs review." }] } },
];
await writeFile(
  path.join(projectDir, `${sessionId}.jsonl`),
  `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  "utf8",
);
await writeFile(
  path.join(projectDir, "99999999-2222-4333-8444-555555555555.jsonl"),
  `${JSON.stringify({ type: "user", sessionId: "99999999-2222-4333-8444-555555555555", cwd: workdir, message: { role: "user", content: "Unknown skill: usage" } })}\n`,
  "utf8",
);

const testConfig = {
  ...config,
  dataDir: path.join(root, "relay"),
  hahaGlobalConfigDir: claudeRoot,
};
const sessions = await discoverHahaSessions(testConfig, workdir);
if (sessions.length !== 1 || sessions[0].sessionId !== sessionId) {
  throw new Error(`Expected one adoptable session, received ${JSON.stringify(sessions)}`);
}
if (sessions[0].model !== "deepseek-v4-flash" || !sessions[0].lastResponse.includes("state sync")) {
  throw new Error(`Session metadata was not parsed correctly: ${JSON.stringify(sessions[0])}`);
}

const store = new TaskStore(testConfig.dataDir);
await store.load();
const settings = new SettingsStore(testConfig.dataDir);
await settings.load();
const manager = new TaskManager(testConfig, store, settings);
let rejectedEmptyInstruction = false;
try {
  await manager.adopt(sessions[0], ["src/App.tsx"], "");
} catch (error) {
  rejectedEmptyInstruction = error instanceof Error && error.message.includes("instruction");
}
if (!rejectedEmptyInstruction) throw new Error("Adoption accepted an empty correction instruction");

console.log(JSON.stringify({
  ok: true,
  discovered: sessions.length,
  sessionId,
  rejectedEmptyInstruction,
}));
await rm(root, { recursive: true, force: true });
