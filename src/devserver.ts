import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { LiveEvent } from "./claude.ts";
import type { TestResult, TestRunContext, TestRunner } from "./orchestrator.ts";

// DESIGN.md「執行指令由 package.json 提供」：loom 只認這幾個固定名稱，PORT
// 由這裡放進環境變數，怎麼把它變成框架參數是 script 自己的事。找不到
// loom:* 就退回慣例名稱，這樣沒改過 package.json 的專案也跑得動。
const SCRIPTS = {
  setup: ["loom:setup"],
  typecheck: ["loom:typecheck", "typecheck"],
  dev: ["loom:dev", "dev"],
  test: ["loom:test", "test"],
  e2e: ["loom:e2e"],
} as const;

/**
 * 設定頁固定列出的名稱：每個階段的第一候選，也就是 `loom:*` 那些。慣例退回
 * 名稱（`typecheck`/`dev`/`test`）不列在這裡 -- 它們只在專案真的用了才有意義，
 * 固定列出來會讓設定頁上出現三行「未定義」的雜訊。專案實際定義了哪些由
 * readKnownScripts 回答。
 */
export const KNOWN_SCRIPT_NAMES: string[] = Object.values(SCRIPTS).map((names) => names[0]);

// 沒有 loom:setup 時依 lockfile 決定安裝指令（DESIGN.md「找不到 loom:* 就
// 退回慣例：dev、test、依 lockfile 決定安裝指令」）。跑的是套件管理器本身，
// 不是 npm script，所以跟其他階段走不同的執行路徑。
const LOCKFILE_INSTALL: [string, string[]][] = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci"]],
];

export interface DevServerOptions {
  /** 單一 script 的上限。dev server 不算在內，它是被動等健康檢查。 */
  scriptTimeoutMs?: number;
  /** 輪詢 http://127.0.0.1:$PORT/ 等 dev server 起來的上限。 */
  healthTimeoutMs?: number;
}

const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HEALTH_TIMEOUT_MS = 90 * 1000;

interface Scripts {
  [name: string]: string;
}

function readScripts(cwd: string): Scripts | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Scripts };
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

/** 設定頁用：專案 package.json 裡 loom 認得的那些 script。 */
export function readKnownScripts(repoPath: string): Record<string, string> {
  const scripts = readScripts(repoPath);
  if (!scripts) return {};
  return Object.fromEntries(KNOWN_SCRIPT_NAMES.filter((name) => name in scripts).map((name) => [name, scripts[name]]));
}

function pickScript(scripts: Scripts, candidates: readonly string[]): string | null {
  return candidates.find((name) => typeof scripts[name] === "string") ?? null;
}

/**
 * 從 workspace 的 port range 找一個現在沒人綁的 port。試綁再放掉會有 TOCTOU
 * 空窗，但 dev server 緊接著就綁上去，而且同一個 workspace 目前是序列跑測試
 * （見 orchestrator.ts 的 ponytail 註解），實務上撞不到。真的被搶走的話
 * dev server 起不來，健康檢查會逾時報 fail，不會靜默跑在錯的 port 上。
 */
export function allocatePort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let candidate = start;
    const tryNext = (): void => {
      if (candidate > end) {
        reject(new Error(`no free port in ${start}-${end}`));
        return;
      }
      const port = candidate++;
      const probe = createServer();
      probe.once("error", () => tryNext());
      probe.once("listening", () => probe.close(() => resolve(port)));
      probe.listen(port, "127.0.0.1");
    };
    tryNext();
  });
}

interface ScriptResult {
  ok: boolean;
  output: string;
  /** true 代表是被逾時砍掉的，不是指令自己回非零 -- 那一類直接 blocked。 */
  timedOut?: boolean;
}

/**
 * 跑一個指令到結束。detached 讓它自成一個 process group -- 專案的 script
 * 幾乎一定會再 spawn 別的東西（vite、playwright、docker），只 kill npm 自己
 * 會留下孤兒佔住 port，那正是 DESIGN.md 說要避免的症狀。
 */
function runCommand(
  cwd: string,
  cmd: string,
  args: string[],
  label: string,
  port: number,
  timeoutMs: number,
  onEvent?: (event: LiveEvent) => void,
): Promise<ScriptResult> {
  onEvent?.({ at: Date.now(), kind: "bash", text: label });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    let settled = false;
    const finish = (result: ScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish({ ok: false, timedOut: true, output: `${output}\n[loom] ${label} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => finish({ ok: false, output: `${output}\n[loom] spawn error: ${err.message}` }));
    child.on("close", (code) => finish({ ok: code === 0, output }));
  });
}

function runScript(
  cwd: string,
  script: string,
  port: number,
  timeoutMs: number,
  onEvent?: (event: LiveEvent) => void,
): Promise<ScriptResult> {
  return runCommand(cwd, "npm", ["run", "--silent", script], `npm run ${script}`, port, timeoutMs, onEvent);
}

/** SIGTERM 給 process group 一次收尾的機會，逾時再 SIGKILL。 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // 已經死了或不存在，沒事
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 正常路徑：SIGTERM 就收掉了
    }
  }, 5000).unref();
}

async function waitForHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 任何 HTTP 回應都算活著 -- 404 也代表 server 起來了，只是那個路徑沒東西。
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

/**
 * 起 dev server、等它健康、跑 runner 給的指令、無論如何殺掉整個 process
 * group。DESIGN.md「每次進 testing 都重起 server，不跨 issue 重用」-- 沒有
 * 快取、沒有重用，這裡每次都是全新的一輪。
 */
async function withDevServer(
  cwd: string,
  scripts: Scripts,
  ctx: TestRunContext,
  opts: Required<DevServerOptions>,
  body: () => Promise<ScriptResult>,
): Promise<ScriptResult> {
  const devScript = pickScript(scripts, SCRIPTS.dev);
  if (!devScript) {
    // 沒有 dev server 的專案（純 library）仍然可以跑單元測試。
    return body();
  }

  ctx.onEvent?.({ at: Date.now(), kind: "port", text: String(ctx.port) });
  ctx.onEvent?.({ at: Date.now(), kind: "bash", text: `npm run ${devScript}  (PORT=${ctx.port})` });
  const dev = spawn("npm", ["run", "--silent", devScript], {
    cwd,
    env: { ...process.env, PORT: String(ctx.port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let devOutput = "";
  dev.stdout.on("data", (chunk) => (devOutput += chunk));
  dev.stderr.on("data", (chunk) => (devOutput += chunk));

  try {
    if (!(await waitForHealthy(ctx.port, opts.healthTimeoutMs))) {
      return {
        ok: false,
        timedOut: true,
        output: `[loom] ${devScript} never answered on http://127.0.0.1:${ctx.port}/ within ${opts.healthTimeoutMs}ms\n${devOutput}`,
      };
    }
    return await body();
  } finally {
    killGroup(dev.pid);
  }
}

function nothingToRun(what: string): TestResult {
  return { pass: true, output: `[loom] ${what}, nothing to run` };
}

function infraFailure(output: string): TestResult {
  return { pass: false, failure: "infra", output };
}

/**
 * 真的跑專案自己的驗證指令，取代開發期間那個一律回 pass 的 stub。
 *
 * 「沒有可跑的東西」與「跑了而且過了」在回傳值上都是 pass，但 output 會寫
 * 明是哪一種，並且會存進 runs.summary。這是刻意的取捨：非 Node 專案、還沒
 * 加 `loom:*` script 的專案不該整條流水線卡死，但也不該讓人以為測試真的跑過。
 */
export function createDevServerTestRunner(options: DevServerOptions = {}): TestRunner {
  const opts: Required<DevServerOptions> = {
    scriptTimeoutMs: options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
    healthTimeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  };

  /** loom:setup，沒有的話依 lockfile 決定安裝指令；兩者都沒有就跳過。 */
  async function setup(cwd: string, scripts: Scripts, ctx: TestRunContext): Promise<ScriptResult | null> {
    const script = pickScript(scripts, SCRIPTS.setup);
    if (script) return runScript(cwd, script, ctx.port, opts.scriptTimeoutMs, ctx.onEvent);

    const lockfile = LOCKFILE_INSTALL.find(([name]) => existsSync(join(cwd, name)));
    if (!lockfile) return null;
    const [, [cmd, ...args]] = lockfile;
    return runCommand(cwd, cmd, args, [cmd, ...args].join(" "), ctx.port, opts.scriptTimeoutMs, ctx.onEvent);
  }

  async function runIssueTests(ctx: TestRunContext): Promise<TestResult> {
    const cwd = ctx.worktreePath;
    // worktree 不在是環境壞了（git worktree add 失敗、被人手動刪掉），不是
    // 「這個專案沒有測試」-- 兩者都走 pass 的話，issue 會在完全沒有程式碼可
    // 測的情況下變成 done。拋出去讓排程器記錄並停住，人要介入。
    if (!existsSync(cwd)) throw new Error(`worktree does not exist: ${cwd}`);

    const scripts = readScripts(cwd);
    if (scripts === null) return nothingToRun("no readable package.json");

    const typecheckScript = pickScript(scripts, SCRIPTS.typecheck);
    const testScript = pickScript(scripts, SCRIPTS.test);
    const e2eScript = ctx.e2e ? pickScript(scripts, SCRIPTS.e2e) : null;
    if (!typecheckScript && !testScript && !e2eScript) {
      return nothingToRun("no typecheck/test/e2e script in package.json");
    }

    const setupResult = await setup(cwd, scripts, ctx);
    if (setupResult && !setupResult.ok) {
      return infraFailure(`[loom] setup failed\n${setupResult.output}`);
    }

    // 每一階段的 output 都累積，成功的階段也算：runs.summary 存的是「這一輪
    // 跑了什麼」，而 coder 下一輪的 prompt 帶的就是這份（DESIGN.md「失敗時的
    // 資訊傳遞」）。只留失敗那段的話，紅在哪一階段、前面幾段有沒有警告都看不到。
    const output: string[] = [];
    const collected = (result: ScriptResult): ScriptResult => {
      output.push(result.output);
      return { ...result, output: output.join("\n") };
    };

    // typecheck 不需要 dev server，先跑：編譯不過就沒必要花幾十秒起 server。
    if (typecheckScript) {
      const result = collected(await runScript(cwd, typecheckScript, ctx.port, opts.scriptTimeoutMs, ctx.onEvent));
      if (result.timedOut) return infraFailure(result.output);
      if (!result.ok) return { pass: false, failure: "domain", output: result.output };
    }

    if (!testScript && !e2eScript) {
      return { pass: true, output: [...output, "[loom] typecheck only, no test or e2e script"].join("\n") };
    }

    const result = await withDevServer(cwd, scripts, ctx, opts, async () => {
      if (testScript) {
        const unit = collected(await runScript(cwd, testScript, ctx.port, opts.scriptTimeoutMs, ctx.onEvent));
        if (!unit.ok) return unit;
      }
      if (e2eScript) return collected(await runWithOneRetry(cwd, e2eScript, ctx, opts));
      return { ok: true, output: output.join("\n") };
    });

    if (result.timedOut) return infraFailure(result.output);
    return { pass: result.ok, output: result.output, failure: result.ok ? undefined : "domain" };
  }

  async function runSpecE2E(ctx: TestRunContext): Promise<TestResult> {
    const cwd = ctx.worktreePath;
    if (!existsSync(cwd)) throw new Error(`worktree does not exist: ${cwd}`);

    const scripts = readScripts(cwd);
    if (scripts === null) return nothingToRun("no readable package.json");

    const e2eScript = pickScript(scripts, SCRIPTS.e2e);
    if (!e2eScript) return nothingToRun("no e2e script in package.json");

    const setupResult = await setup(cwd, scripts, ctx);
    if (setupResult && !setupResult.ok) {
      return infraFailure(`[loom] setup failed\n${setupResult.output}`);
    }

    const result = await withDevServer(cwd, scripts, ctx, opts, () => runWithOneRetry(cwd, e2eScript, ctx, opts));
    if (result.timedOut) return infraFailure(result.output);
    return { pass: result.ok, output: result.output, failure: result.ok ? undefined : "domain" };
  }

  return { runIssueTests, runSpecE2E };
}

/**
 * DESIGN.md「e2e 紅了先原地重跑一次，兩次都紅才算 domain fail。不這樣做的話
 * 一次 flaky 就吃掉一格重試額度。unit test 不需要這層」-- 所以只有 e2e 走
 * 這條，而且是原地重跑（同一個 dev server，不重起）。
 */
async function runWithOneRetry(
  cwd: string,
  script: string,
  ctx: TestRunContext,
  opts: Required<DevServerOptions>,
): Promise<ScriptResult> {
  const first = await runScript(cwd, script, ctx.port, opts.scriptTimeoutMs, ctx.onEvent);
  if (first.ok || first.timedOut) return first;

  ctx.onEvent?.({ at: Date.now(), kind: "say", text: "e2e 紅了，原地重跑一次確認不是 flaky" });
  const second = await runScript(cwd, script, ctx.port, opts.scriptTimeoutMs, ctx.onEvent);
  if (second.ok) {
    return { ok: true, output: `${first.output}\n[loom] first e2e run failed, retry passed (treated as flaky)` };
  }
  return { ok: false, output: `${first.output}\n[loom] retried once, failed again:\n${second.output}` };
}
