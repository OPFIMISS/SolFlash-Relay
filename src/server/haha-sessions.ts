import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type { HahaSessionSummary } from "../shared/types.js";
import type { RelayConfig } from "./config.js";

const execFileAsync = promisify(execFile);
type JsonLine = Record<string, unknown> & {
  type?: string;
  customTitle?: string;
  aiTitle?: string;
  sessionId?: string;
  cwd?: string;
  workDir?: string;
  timestamp?: string;
  lastPrompt?: string;
  message?: unknown;
  repository?: unknown;
};

export const discoverHahaSessions = async (
  relayConfig: RelayConfig,
  workdir?: string,
): Promise<HahaSessionSummary[]> => {
  const projectsRoot = path.join(relayConfig.hahaGlobalConfigDir, "projects");
  const wanted = workdir ? normalizePath(path.resolve(workdir)) : "";
  const candidates: Array<{ filePath: string; updatedAt: Date }> = [];

  try {
    for (const project of await readdir(projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projectsRoot, project.name);
      for (const file of await readdir(projectDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const filePath = path.join(projectDir, file.name);
        const info = await stat(filePath);
        candidates.push({ filePath, updatedAt: info.mtime });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const changedFiles = wanted ? await discoverChangedFiles(path.resolve(workdir!)) : [];
  const sessions: HahaSessionSummary[] = [];
  const ordered = candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  for (const candidate of wanted ? ordered : ordered.slice(0, 250)) {
    const session = await readSession(candidate.filePath, candidate.updatedAt, changedFiles);
    if (!session || isUsageProbe(session)) continue;
    if (wanted && normalizePath(path.resolve(session.workdir)) !== wanted) continue;
    sessions.push(session);
    if (sessions.length >= 80) break;
  }
  return sessions;
};

const readSession = async (
  filePath: string,
  updatedAt: Date,
  changedFiles: string[],
): Promise<HahaSessionSummary | null> => {
  let sessionId = path.basename(filePath, ".jsonl");
  let customTitle = "";
  let aiTitle = "";
  let sessionWorkdir = "";
  let messageWorkdir = "";
  let model = "";
  let firstPrompt = "";
  let lastPrompt = "";
  let lastResponse = "";

  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;
    sessionId = asString(entry.sessionId) || sessionId;
    customTitle = entry.type === "custom-title" ? asString(entry.customTitle) || customTitle : customTitle;
    aiTitle = entry.type === "ai-title" ? asString(entry.aiTitle) || aiTitle : aiTitle;
    if (entry.type === "session-meta") {
      const repository = asRecord(entry.repository);
      sessionWorkdir = asString(entry.workDir)
        || asString(repository.requestedWorkDir)
        || asString(repository.repoRoot)
        || sessionWorkdir;
      model = asString(entry.runtimeModelId) || model;
    }
    messageWorkdir = asString(entry.cwd) || messageWorkdir;
    if (entry.type === "last-prompt") {
      const prompt = asString(entry.lastPrompt);
      if (!isInternalPrompt(prompt)) {
        firstPrompt ||= prompt;
        lastPrompt = prompt || lastPrompt;
      }
    }
    const message = asRecord(entry.message);
    const role = asString(message.role);
    if (role === "assistant") {
      model = asString(message.model) || model;
      lastResponse = textContent(message.content) || lastResponse;
    } else if (role === "user") {
      const prompt = textContent(message.content);
      if (!isInternalPrompt(prompt)) {
        firstPrompt ||= prompt;
        lastPrompt = prompt || lastPrompt;
      }
    }
  }

  const workdir = sessionWorkdir || messageWorkdir;
  if (!workdir || !sessionId) return null;
  return {
    sessionId,
    title: customTitle || aiTitle || summarize(firstPrompt) || `Haha ${sessionId.slice(0, 8)}`,
    workdir,
    model: model || "unknown",
    updatedAt: updatedAt.toISOString(),
    lastPrompt: summarize(lastPrompt, 500),
    lastResponse: summarize(lastResponse, 1000),
    changedFiles,
  };
};

const parseLine = (line: string): JsonLine | null => {
  try {
    return JSON.parse(line) as JsonLine;
  } catch {
    return null;
  }
};

const discoverChangedFiles = async (workdir: string) => {
  try {
    const commands = [
      ["diff", "--name-only"],
      ["diff", "--cached", "--name-only"],
      ["ls-files", "--others", "--exclude-standard"],
    ];
    const results = await Promise.all(commands.map((args) =>
      execFileAsync("git", ["-C", workdir, ...args], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ));
    return [...new Set(results.flatMap(({ stdout }) => stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)))];
  } catch {
    return [];
  }
};

const textContent = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const block = asRecord(item);
      return asString(block.text) || (block.type === "tool_result" ? "" : asString(block.content));
    })
    .filter(Boolean)
    .join("\n")
    .trim();
};

const isUsageProbe = (session: HahaSessionSummary) => {
  const text = `${session.title}\n${session.lastPrompt}`.toLowerCase();
  return text.includes("unknown skill: usage") || /^\s*\/usage\s*$/i.test(session.lastPrompt);
};

const isInternalPrompt = (value: string) => /^\s*<task-notification(?:\s|>)/i.test(value);

const summarize = (value: string, limit = 120) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const asString = (value: unknown) => typeof value === "string" ? value : "";
const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
