const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const port = 17327;
const relayUrl = `http://127.0.0.1:${port}`;

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
  unread: true,
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
  ],
  messages: [
    { id: "m1", role: "planner", agent: "codex", model: "gpt-5.6-sol", timestamp: now, content: "Add model selector states without changing routes.", kind: "instruction" },
    { id: "m2", role: "executor", agent: "claude-haha", model: "deepseek-v4-flash", timestamp: now, content: "Reading the existing selector and implementing the bounded states.", kind: "output" }
  ]
};

const settings = {
  plannerAgent: "codex",
  plannerModel: "gpt-5.6-sol",
  executorAgent: "claude-haha",
  executorModel: "deepseek-v4-flash",
  executorEffort: "medium",
  agents: [
    { id: "codex", label: "Codex", role: "planner", transport: "host", enabled: true, models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" },
    { id: "claude-haha", label: "Claude Code Haha", role: "executor", transport: "haha-sidecar", enabled: true, models: ["deepseek-v4-flash", "deepseek-v4-pro"], defaultModel: "deepseek-v4-flash" },
    { id: "opencode", label: "OpenCode", role: "both", transport: "opencode-cli", enabled: true, models: [], defaultModel: "" }
  ]
};

const config = {
  version: "0.6.0",
  host: "127.0.0.1",
  port: 17322,
  hahaRoot: "D:\\Claude Code Haha",
  hahaModel: "deepseek-v4-flash",
  hahaEffort: "medium",
  tokenMonitorUrl: "http://127.0.0.1:17321",
  tokenMonitorProjectLabel: "SolFlashRelay",
  hahaShareDesktopState: true
};

const hahaSessions = [{
  sessionId: "33333333-4444-4555-8666-777777777777",
  title: "example · Flash UI scaffold",
  workdir: "C:/workspace/example",
  model: "deepseek-v4-flash",
  updatedAt: now,
  lastPrompt: "Build the first UI scaffold.",
  lastResponse: "The scaffold is ready, but state synchronization and retry handling still need review.",
  changedFiles: ["src/pages/Settings.tsx", "src/components/ModelSelector.tsx"],
}];

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
  providerLimits: [{ provider: "deepseek", label: "DeepSeek 中转站", used: 12.7, limit: 50, remaining: 37.3, percentage: 25.4, unit: "usd", resetAt: null, plan: "月度余额" }],
  updatedAt: now
};

async function capture(browser, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.route("**/api/tasks", (route) => route.fulfill({ json: [task] }));
  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: settings }));
  await page.route("**/api/token-monitor**", (route) => route.fulfill({ json: monitor }));
  await page.route("**/api/haha-sessions**", (route) => route.fulfill({ json: hahaSessions }));
  await page.goto(relayUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".dashboard-grid");
  await page.screenshot({ path: path.join(".relay-data", `ui-${name}.png`), fullPage: true });
  let motion;
  if (name === "desktop") {
    const indicator = page.locator(".segment-indicator");
    const before = await indicator.evaluate((element) => getComputedStyle(element).transform);
    await page.getByRole("button", { name: "本周" }).click();
    await page.waitForTimeout(210);
    const during = await indicator.evaluate((element) => getComputedStyle(element).transform);
    await page.waitForTimeout(300);
    const after = await indicator.evaluate((element) => getComputedStyle(element).transform);
    const contentAnimation = await page.locator(".token-period-content").evaluate((element) =>
      getComputedStyle(element).animationName,
    );
    if (before === during || during === after || before === after) {
      throw new Error(`Token period indicator did not animate continuously: ${before} -> ${during} -> ${after}`);
    }
    if (contentAnimation === "none") throw new Error("Token period content animation is missing");
    motion = { before, during, after, contentAnimation };
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(".relay-data", "ui-period-week.png"), fullPage: true });
    await page.getByTitle("Agent 与模型设置").click();
    await page.waitForSelector(".settings-dialog");
    await page.waitForTimeout(350);
    const executorSettings = page.locator("fieldset").filter({ hasText: "执行端" });
    const executorSelects = executorSettings.locator("select");
    const modelOptions = await executorSelects.nth(1).locator("option").allTextContents();
    if (!modelOptions.includes("deepseek-v4-flash") || !modelOptions.includes("deepseek-v4-pro")) {
      throw new Error(`Executor model selector is incomplete: ${modelOptions.join(", ")}`);
    }
    await page.screenshot({ path: path.join(".relay-data", "ui-settings.png") });
    await executorSelects.nth(1).selectOption("deepseek-v4-pro");
    await executorSelects.nth(2).selectOption("high");
    await executorSelects.nth(1).selectOption("__custom");
    const customModel = executorSettings.locator(".model-field input");
    await customModel.fill("luna-code-preview");
    if ((await customModel.inputValue()) !== "luna-code-preview") throw new Error("Custom intermediary model ID was not accepted");
    await page.getByTitle("关闭").click();
    await page.getByTitle("接管已有 Haha 对话").click();
    await page.waitForSelector(".adopt-dialog");
    await page.waitForSelector(".adopt-session-list button.selected");
    const adoptedFiles = await page.locator(".adopt-fields textarea").first().inputValue();
    if (!adoptedFiles.includes("src/pages/Settings.tsx")) {
      throw new Error(`Adopt dialog did not suggest changed files: ${adoptedFiles}`);
    }
    await page.locator(".adopt-fields textarea").nth(1).fill("Review the existing scaffold and fix state synchronization only.");
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(".relay-data", "ui-adopt-haha.png") });
    await page.getByTitle("关闭").click();
  } else if (name === "mobile") {
    await page.getByTitle("接管已有 Haha 对话").click();
    await page.waitForSelector(".adopt-dialog");
    await page.waitForSelector(".adopt-session-list button.selected");
    await page.waitForTimeout(350);
    const dialogOverflow = await page.locator(".adopt-dialog").evaluate((element) =>
      element.scrollWidth > element.clientWidth + 1,
    );
    if (dialogOverflow) throw new Error("Adopt dialog has horizontal overflow on mobile");
    await page.screenshot({ path: path.join(".relay-data", "ui-adopt-haha-mobile.png"), fullPage: true });
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
  const daemon = spawn(process.execPath, [path.join("dist", "server", "daemon.js")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, RELAY_PORT: String(port), RELAY_DATA_DIR: path.resolve(".relay-data", "ui-test") },
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${relayUrl}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`UI test daemon did not start at ${relayUrl}`);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const desktop = await capture(browser, "desktop", { width: 1440, height: 900 });
    const mobile = await capture(browser, "mobile", { width: 390, height: 844 });
    console.log(JSON.stringify({ ok: true, desktop, mobile }));
  } finally {
    await browser.close();
    daemon.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
