import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentDefinition, RelaySettings } from "../shared/types.js";

const builtInAgents: AgentDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    role: "planner",
    transport: "host",
    enabled: true,
    models: ["gpt-5.6-sol", "gpt-5.6-terra"],
    defaultModel: "gpt-5.6-sol",
  },
  {
    id: "claude-haha",
    label: "Claude Code Haha",
    role: "executor",
    transport: "haha-sidecar",
    enabled: true,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-v4-flash",
  },
  {
    id: "claude-code",
    label: "Claude Code CLI",
    role: "both",
    transport: "claude-cli",
    enabled: true,
    command: "claude",
    models: ["haiku", "sonnet", "opus"],
    defaultModel: "sonnet",
  },
  {
    id: "opencode",
    label: "OpenCode",
    role: "both",
    transport: "opencode-cli",
    enabled: true,
    command: "opencode",
    models: [],
    defaultModel: "",
  },
  {
    id: "reasonix",
    label: "Reasonix",
    role: "both",
    transport: "reasonix-cli",
    enabled: true,
    command: "reasonix",
    models: [],
    defaultModel: "",
  },
];

const defaults = (): RelaySettings => ({
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: "claude-haha",
  executorModel: "deepseek-v4-flash",
  agents: structuredClone(builtInAgents),
});

interface PersistedSettings {
  version: 1;
  settings: RelaySettings;
}

export class SettingsStore {
  readonly #filePath: string;
  #settings = defaults();

  constructor(dataDir: string) {
    this.#filePath = path.join(dataDir, "settings.json");
  }

  async load() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const parsed = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as PersistedSettings;
      this.#settings = normalizeSettings(parsed.settings);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save(this.#settings);
    }
  }

  get() {
    return structuredClone(this.#settings);
  }

  async save(next: RelaySettings) {
    this.#settings = normalizeSettings(next);
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, settings: this.#settings }, null, 2),
      "utf8",
    );
    await rename(temporary, this.#filePath);
    return this.get();
  }

  async upsertAgent(agent: AgentDefinition) {
    const next = this.get();
    const index = next.agents.findIndex((item) => item.id === agent.id);
    if (index >= 0) next.agents[index] = agent;
    else next.agents.push(agent);
    return this.save(next);
  }
}

const normalizeSettings = (input: RelaySettings): RelaySettings => {
  const custom = (input?.agents ?? []).filter(
    (agent) => !builtInAgents.some((builtIn) => builtIn.id === agent.id),
  );
  const overriddenBuiltIns = builtInAgents.map((builtIn) => ({
    ...builtIn,
    ...(input?.agents ?? []).find((agent) => agent.id === builtIn.id),
    id: builtIn.id,
    transport: builtIn.transport,
  }));
  const agents = [...overriddenBuiltIns, ...custom].filter(
    (agent) => agent.id?.trim() && agent.label?.trim(),
  );
  const fallback = defaults();
  return {
    plannerAgent: input?.plannerAgent || fallback.plannerAgent,
    plannerModel: input?.plannerModel ?? fallback.plannerModel,
    executorAgent: input?.executorAgent || fallback.executorAgent,
    executorModel: input?.executorModel ?? fallback.executorModel,
    agents,
  };
};
