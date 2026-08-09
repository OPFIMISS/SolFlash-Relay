const { chromium } = require("playwright");
const path = require("node:path");

const now = new Date().toISOString();
const task = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  request: {
    title: "Implement model selector states",
    objective: "Add loading, selected, retry, and keyboard states to the existing settings model selector.",
    workdir: "C:/workspace/example",
    allowedFiles: ["src/pages/Settings.tsx", "src/components/ModelSelector.tsx", "src/api/models.ts"],
    contextFiles: ["src/components/Button.tsx"],
    constraints: ["Use existing components", "Do not change routes"],
    acceptanceCommands: ["npm run typecheck", "npm test"],
    plannerAgent: "codex",
    plannerModel: "gpt-5.6-sol",
    executorAgent: "claude-haha",
    model: "deepseek-v4-flash",
    effort: "medium"
  },
  status: "running",
  createdAt: now,
  startedAt: now,
  finishedAt: null,
  updatedAt: now,
  summary: "",
  error: null,
  changedFiles: ["src/components/ModelSelector.tsx", "src/api/models.ts"],
  scopeWarnings: [],
  projectName: "example",
  requestedModel: "deepseek-v4-flash",
  effectiveModel: "deepseek-v4-flash",
  modelWarning: null,
  usage: {
    inputTokens: 28400,
    outputTokens: 1850,
    cacheReadTokens: 19000,
    cacheCreationTokens: 0,
    costUsd: 0.0874,
    model: "deepseek-v4-flash"
  },
  events: [
    { id: "e1", taskId: "11111111-1111-4111-8111-111111111111", kind: "task.created", timestamp: now, message: "Task created: Implement model selector states" },
    { id: "e2", taskId: "11111111-1111-4111-8111-111111111111", kind: "task.started", timestamp: now, message: "Started Haha Flash." },
    { id: "e3", taskId: "11111111-1111-4111-8111-111111111111", kind: "task.tool", timestamp: now, message: "Flash called Read" },
    { id: "e4", taskId: "11111111-1111-4111-8111-111111111111", kind: "task.tool", timestamp: now, message: "Flash called Edit" },
    { id: "e5", taskId: "11111111-1111-4111-8111-111111111111", kind: "task.output", timestamp: now, message: "Implemented loading and retry states. Verifying keyboard navigation before completion." }
  ]
};

const settings = {
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: "claude-haha",
  executorModel: "deepseek-v4-flash",
  agents: [
    { id: "codex", label: "Codex", role: "planner", transport: "host", enabled: true, models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" },
    { id: "claude-haha", label: "Claude Code Haha", role: "executor", transport: "haha-sidecar", enabled: true, models: ["deepseek-v4-flash", "deepseek-v4-pro"], defaultModel: "deepseek-v4-flash" },
    { id: "opencode", label: "OpenCode", role: "both", transport: "opencode-cli", enabled: true, models: [], defaultModel: "" }
  ]
};

const config = {
  host: "127.0.0.1",
  port: 17322,
  hahaRoot: "D:\\Claude Code Haha",
  hahaModel: "deepseek-v4-flash",
  hahaEffort: "medium",
  tokenMonitorUrl: "http://127.0.0.1:17321",
  tokenMonitorProjectLabel: "SolFlashRelay"
};

const monitor = {
  connected: true,
  source: "http://127.0.0.1:17321",
  error: null,
  projectLabel: "SolFlashRelay",
  totalTokens: 186420,
  inputTokens: 121500,
  outputTokens: 23800,
  cacheReadTokens: 38900,
  cacheCreationTokens: 2220,
  totalCostUsd: 1.2846,
  sessions: 9,
  byClient: { codex: 128000, claude: 58420 },
  byModel: { "gpt-5.6-sol": 128000, "deepseek-v4-flash": 58420 },
  updatedAt: now
};

async function capture(browser, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.route("**/api/tasks", (route) => route.fulfill({ json: [task] }));
  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: settings }));
  await page.route("**/api/token-monitor**", (route) => route.fulfill({ json: monitor }));
  await page.goto("http://127.0.0.1:17322", { waitUntil: "networkidle" });
  await page.waitForSelector(".dashboard-grid");
  await page.screenshot({ path: path.join(".relay-data", `ui-${name}.png`), fullPage: true });
  let motion;
  if (name === "desktop") {
    const before = await page.locator(".segmented-control").evaluate((element) =>
      getComputedStyle(element, "::before").transform,
    );
    await page.getByRole("button", { name: "本周" }).click();
    await page.waitForTimeout(420);
    const after = await page.locator(".segmented-control").evaluate((element) =>
      getComputedStyle(element, "::before").transform,
    );
    const contentAnimation = await page.locator(".token-period-content").evaluate((element) =>
      getComputedStyle(element).animationName,
    );
    if (before === after) throw new Error("Token period indicator did not move");
    if (contentAnimation === "none") throw new Error("Token period content animation is missing");
    motion = { before, after, contentAnimation };
    await page.screenshot({ path: path.join(".relay-data", "ui-period-week.png"), fullPage: true });
    await page.getByTitle("Agent 与模型设置").click();
    await page.waitForSelector(".settings-dialog");
    await page.screenshot({ path: path.join(".relay-data", "ui-settings.png"), fullPage: true });
    await page.getByTitle("关闭").click();
  }

  const audit = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = [...document.querySelectorAll("button, .metric, .summary-value, .agent-node")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({ className: element.className, text: element.textContent?.trim().slice(0, 80) }));
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > viewportWidth + 1,
      offenders,
    };
  });
  await context.close();
  return { ...audit, motion };
}

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const desktop = await capture(browser, "desktop", { width: 1440, height: 900 });
    const mobile = await capture(browser, "mobile", { width: 390, height: 844 });
    console.log(JSON.stringify({ ok: true, desktop, mobile }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
