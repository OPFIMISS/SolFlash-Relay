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
const nestedSessionId = "22222222-3333-4444-8555-666666666666";
const untitledSessionId = "33333333-4444-4555-8666-777777777777";
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
const nestedSessionLines = [
  {
    type: "session-meta",
    workDir: workdir,
    repository: { requestedWorkDir: workdir, repoRoot: workdir },
    runtimeModelId: "deepseek-v4-flash",
  },
  { type: "user", sessionId: nestedSessionId, cwd: workdir, message: { role: "user", content: "Fix frame timing and rerun the GC test." } },
  { type: "ai-title", aiTitle: "Fix frame timing and retest GC pressure" },
  { type: "assistant", sessionId: nestedSessionId, cwd: path.join(workdir, "src"), message: { role: "assistant", model: "deepseek-v4-flash", content: "The correction is complete." } },
  { type: "user", sessionId: nestedSessionId, cwd: path.join(workdir, "src"), message: { role: "user", content: "<task-notification><task-id>internal</task-id></task-notification>" } },
];
await writeFile(
  path.join(projectDir, `${nestedSessionId}.jsonl`),
  `${nestedSessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  "utf8",
);
const untitledSessionLines = [
  { type: "session-meta", workDir: workdir, runtimeModelId: "deepseek-v4-flash" },
  { type: "user", sessionId: untitledSessionId, cwd: workdir, message: { role: "user", content: "Read the Wishflower project and update it." } },
  { type: "assistant", sessionId: untitledSessionId, cwd: workdir, message: { role: "assistant", model: "deepseek-v4-flash", content: "Initial update complete." } },
  { type: "user", sessionId: untitledSessionId, cwd: workdir, message: { role: "user", content: "Add recipe chain tracking without unrelated refactors." } },
];
await writeFile(
  path.join(projectDir, `${untitledSessionId}.jsonl`),
  `${untitledSessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
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
if (sessions.length !== 3 || !sessions.some((session) => session.sessionId === sessionId)) {
  throw new Error(`Expected three adoptable sessions, received ${JSON.stringify(sessions)}`);
}
const primarySession = sessions.find((session) => session.sessionId === sessionId)!;
const nestedSession = sessions.find((session) => session.sessionId === nestedSessionId);
const untitledSession = sessions.find((session) => session.sessionId === untitledSessionId);
if (primarySession.model !== "deepseek-v4-flash" || !primarySession.lastResponse.includes("state sync")) {
  throw new Error(`Session metadata was not parsed correctly: ${JSON.stringify(primarySession)}`);
}
if (
  !nestedSession
  || nestedSession.workdir !== workdir
  || nestedSession.title !== "Fix frame timing and retest GC pressure"
  || nestedSession.lastPrompt !== "Fix frame timing and rerun the GC test."
) {
  throw new Error(`Nested session metadata was not parsed correctly: ${JSON.stringify(nestedSession)}`);
}
if (
  !untitledSession
  || untitledSession.title !== "Read the Wishflower project and update it."
  || untitledSession.lastPrompt !== "Add recipe chain tracking without unrelated refactors."
) {
  throw new Error(`Untitled session prompts were not parsed correctly: ${JSON.stringify(untitledSession)}`);
}

const store = new TaskStore(testConfig.dataDir);
await store.load();
const settings = new SettingsStore(testConfig.dataDir);
await settings.load();
const manager = new TaskManager(testConfig, store, settings);
let rejectedEmptyInstruction = false;
try {
  await manager.adopt(primarySession, ["src/App.tsx"], "");
} catch (error) {
  rejectedEmptyInstruction = error instanceof Error && error.message.includes("instruction");
}
if (!rejectedEmptyInstruction) throw new Error("Adoption accepted an empty correction instruction");

console.log(JSON.stringify({
  ok: true,
  discovered: sessions.length,
  sessionId,
  nestedSessionId,
  untitledSessionId,
  rejectedEmptyInstruction,
}));
await rm(root, { recursive: true, force: true });
