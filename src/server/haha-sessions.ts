import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { HahaSessionSummary } from "../shared/types.js";
import type { RelayConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;

type JsonLine = Record<string, unknown> & {
  type?: string;
  customTitle?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  lastPrompt?: string;
  message?: unknown;
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
  const info = await stat(filePath);
  const head = await readSlice(filePath, 0, Math.min(info.size, HEAD_BYTES));
  const tailOffset = Math.max(0, info.size - TAIL_BYTES);
  const tail = tailOffset > 0 ? await readSlice(filePath, tailOffset, TAIL_BYTES) : "";
  const lines = [...parseLines(head), ...parseLines(tail, tailOffset > 0)];
  let sessionId = path.basename(filePath, ".jsonl");
  let title = "";
  let workdir = "";
  let model = "";
  let lastPrompt = "";
  let lastResponse = "";

  for (const entry of lines) {
    sessionId = asString(entry.sessionId) || sessionId;
    title = entry.type === "custom-title" ? asString(entry.customTitle) || title : title;
    workdir = asString(entry.cwd) || workdir;
    if (entry.type === "last-prompt") lastPrompt = asString(entry.lastPrompt) || lastPrompt;
    const message = asRecord(entry.message);
    const role = asString(message.role);
    if (role === "assistant") {
      model = asString(message.model) || model;
      lastResponse = textContent(message.content) || lastResponse;
    } else if (role === "user") {
      lastPrompt = textContent(message.content) || lastPrompt;
    }
  }

  if (!workdir || !sessionId) return null;
  return {
    sessionId,
    title: title || summarize(lastPrompt) || `Haha ${sessionId.slice(0, 8)}`,
    workdir,
    model: model || "unknown",
    updatedAt: updatedAt.toISOString(),
    lastPrompt: summarize(lastPrompt, 500),
    lastResponse: summarize(lastResponse, 1000),
    changedFiles,
  };
};

const readSlice = async (filePath: string, position: number, length: number) => {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};

const parseLines = (text: string, discardFirst = false): JsonLine[] => {
  const lines = text.split(/\r?\n/);
  if (discardFirst) lines.shift();
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as JsonLine];
    } catch {
      return [];
    }
  });
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

const summarize = (value: string, limit = 120) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const asString = (value: unknown) => typeof value === "string" ? value : "";
const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
