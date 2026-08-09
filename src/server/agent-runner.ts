import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentDefinition, RelayTask } from "../shared/types.js";
import type { RelayConfig } from "./config.js";

export interface AgentRunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string | null;
  outputFormat: "stream-json" | "jsonl" | "text";
  requestedModel: string;
  cliModel: string;
}

export const buildAgentRun = async (
  relayConfig: RelayConfig,
  agent: AgentDefinition,
  task: RelayTask,
  prompt: string,
  resume: boolean,
): Promise<AgentRunSpec> => {
  const requestedModel = task.requestedModel || agent.defaultModel;
  if (agent.transport === "haha-sidecar") {
    return buildHahaRun(relayConfig, task, prompt, resume, requestedModel);
  }
  if (agent.transport === "claude-cli") {
    const permissionArgs = relayConfig.hahaAllowShell
      ? ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]
      : ["--permission-mode", "acceptEdits"];
    const sessionArgs = resume
      ? ["--resume", task.sessionId]
      : ["--session-id", task.sessionId];
    return {
      command: agent.command || "claude",
      args: [
        "--print",
        "--verbose",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--model",
        requestedModel,
        "--effort",
        task.request.effort ?? relayConfig.hahaEffort,
        "--name",
        sessionName(task),
        ...sessionArgs,
        ...permissionArgs,
      ],
      cwd: task.request.workdir,
      env: process.env,
      prompt,
      outputFormat: "stream-json",
      requestedModel,
      cliModel: requestedModel,
    };
  }
  if (agent.transport === "opencode-cli") {
    const args = ["run", "--format", "json", "--dir", task.request.workdir];
    if (requestedModel) args.push("--model", requestedModel);
    if (resume) args.push("--session", task.sessionId);
    else args.push("--title", sessionName(task));
    args.push(prompt);
    return {
      command: agent.command || "opencode",
      args,
      cwd: task.request.workdir,
      env: process.env,
      prompt: null,
      outputFormat: "jsonl",
      requestedModel,
      cliModel: requestedModel,
    };
  }
  if (agent.transport === "reasonix-cli") {
    const args = ["-y"];
    if (requestedModel) args.push("--model", requestedModel);
    if (resume) args.push("--resume", task.sessionId);
    args.push(prompt);
    return {
      command: agent.command || "reasonix",
      args,
      cwd: task.request.workdir,
      env: process.env,
      prompt: null,
      outputFormat: "text",
      requestedModel,
      cliModel: requestedModel,
    };
  }
  if (agent.transport === "custom-cli") {
    const variables = {
      prompt,
      workdir: task.request.workdir,
      sessionId: task.sessionId,
      model: requestedModel,
      title: sessionName(task),
    };
    const source = resume ? agent.resumeArgs ?? agent.args ?? [] : agent.args ?? [];
    const args = source.map((value) => substitute(value, variables));
    const promptTransport = agent.promptTransport ?? "stdin";
    if (promptTransport === "argument" && !source.some((value) => value.includes("{prompt}"))) {
      args.push(prompt);
    }
    return {
      command: agent.command || agent.id,
      args,
      cwd: task.request.workdir,
      env: process.env,
      prompt: promptTransport === "stdin" ? prompt : null,
      outputFormat: agent.outputFormat ?? "text",
      requestedModel,
      cliModel: requestedModel,
    };
  }
  throw new Error(`Agent ${agent.id} cannot execute tasks (transport: ${agent.transport}).`);
};

export const discoverHahaModels = async (relayConfig: RelayConfig) => {
  try {
    const raw = await readFile(
      path.join(relayConfig.hahaGlobalConfigDir, "cc-haha", "providers.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      activeId?: string;
      providers?: Array<{ id?: string; models?: Record<string, string> }>;
    };
    const provider = parsed.providers?.find((item) => item.id === parsed.activeId);
    return [...new Set(Object.values(provider?.models ?? {}).filter(Boolean))];
  } catch {
    return [];
  }
};

const buildHahaRun = async (
  relayConfig: RelayConfig,
  task: RelayTask,
  prompt: string,
  resume: boolean,
  requestedModel: string,
): Promise<AgentRunSpec> => {
  const sidecar = path.join(
    relayConfig.hahaRoot,
    "resources",
    "app.asar.unpacked",
    "src-tauri",
    "binaries",
    "claude-sidecar-x86_64-pc-windows-msvc.exe",
  );
  const appRoot = path.join(relayConfig.hahaRoot, "resources", "app.asar");
  await access(sidecar);
  const configDir = await prepareHahaConfig(relayConfig);
  const cliModel = await resolveHahaModel(relayConfig, requestedModel);
  const tools = relayConfig.hahaAllowShell
    ? "Read,Edit,Write,Glob,Grep,Bash"
    : "Read,Edit,Write,Glob,Grep";
  const permissionArgs = relayConfig.hahaAllowShell
    ? ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]
    : ["--permission-mode", "acceptEdits"];
  const sessionArgs = resume
    ? ["--resume", task.sessionId]
    : ["--session-id", task.sessionId];
  return {
    command: sidecar,
    args: [
      "cli",
      "--app-root",
      appRoot,
      "--print",
      "--verbose",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--no-computer-use",
      "--model",
      cliModel,
      "--effort",
      task.request.effort ?? relayConfig.hahaEffort,
      "--tools",
      tools,
      "--name",
      sessionName(task),
      ...sessionArgs,
      ...permissionArgs,
    ],
    cwd: task.request.workdir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    prompt,
    outputFormat: "stream-json",
    requestedModel,
    cliModel,
  };
};

const prepareHahaConfig = async (relayConfig: RelayConfig) => {
  if (relayConfig.hahaShareDesktopState) {
    await access(path.join(relayConfig.hahaGlobalConfigDir, "cc-haha", "providers.json"));
    return relayConfig.hahaGlobalConfigDir;
  }
  const source = path.join(relayConfig.hahaGlobalConfigDir, "cc-haha");
  const target = path.join(relayConfig.hahaStateDir, "cc-haha");
  await mkdir(target, { recursive: true });
  for (const name of ["providers.json", "settings.json", "desktop-ui.json"]) {
    try {
      await copyFile(path.join(source, name), path.join(target, name));
    } catch (error) {
      if (name !== "desktop-ui.json") throw error;
    }
  }
  return relayConfig.hahaStateDir;
};

const resolveHahaModel = async (
  relayConfig: RelayConfig,
  requestedModel: string,
) => {
  try {
    const raw = await readFile(
      path.join(relayConfig.hahaGlobalConfigDir, "cc-haha", "providers.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      activeId?: string;
      providers?: Array<{ id?: string; models?: Record<string, string> }>;
    };
    const provider = parsed.providers?.find((item) => item.id === parsed.activeId);
    const entries = Object.entries(provider?.models ?? {});
    if (entries.some(([alias]) => alias === requestedModel)) return requestedModel;
    const match = entries.find(([, model]) => model === requestedModel);
    if (!match) return requestedModel;
    const [alias] = match;
    if (alias === "main") {
      return entries.find(([candidate, model]) => candidate !== "main" && model === requestedModel)?.[0]
        ?? requestedModel;
    }
    return alias;
  } catch {
    return requestedModel;
  }
};

const sessionName = (task: RelayTask) =>
  `${task.projectName} · ${task.request.title}`.slice(0, 96);

const substitute = (value: string, variables: Record<string, string>) =>
  value.replace(/\{(prompt|workdir|sessionId|model|title)\}/g, (_match, key) => variables[key] ?? "");
