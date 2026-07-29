import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { LiveEvent } from "./claude.ts";
import type { TestResult, TestRunContext, TestRunner } from "./orchestrator.ts";

// DESIGN.md「執行指令由 package.json 提供」：loom 只認這四個固定名稱，PORT
// 由這裡放進環境變數，怎麼把它變成框架參數是 script 自己的事。找不到
// loom:* 就退回慣例名稱，這樣沒改過 package.json 的專案也跑得動。
const SCRIPTS = {
  setup: ["loom:setup"],
  dev: ["loom:dev", "dev"],
  test: ["loom:test", "test"],
  e2e: ["loom:e2e"],
} as const;

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
}

/**
 * 跑一個 npm script 到結束。detached 讓它自成一個 process group -- 專案的
 * script 幾乎一定會再 spawn 別的東西（vite、playwright、docker），只 kill
 * npm 自己會留下孤兒佔住 port，那正是 DESIGN.md 說要避免的症狀。
 */
function runScript(
  cwd: string,
  script: string,
  port: number,
  timeoutMs: number,
  onEvent?: (event: LiveEvent) => void,
): Promise<ScriptResult> {
  onEvent?.({ at: Date.now(), kind: "bash", text: `npm run ${script}` });
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", script], {
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
      finish({ ok: false, output: `${output}\n[loom] ${script} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => finish({ ok: false, output: `${output}\n[loom] spawn error: ${err.message}` }));
    child.on("close", (code) => finish({ ok: code === 0, output }));
  });
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
        output: `[loom] ${devScript} never answered on http://127.0.0.1:${ctx.port}/ within ${opts.healthTimeoutMs}ms\n${devOutput}`,
      };
    }
    return await body();
  } finally {
    killGroup(dev.pid);
  }
}

/**
 * 真的跑專案自己的測試指令，取代開發期間那個一律回 pass 的 stub。
 *
 * 「沒有可跑的東西」與「跑了而且過了」在回傳值上都是 pass，但 output 會寫
 * 明是哪一種，並且會存進 runs.summary。這是刻意的取捨：非 Node 專案、還沒
 * 加 loom:* script 的專案不該整條流水線卡死，但也不該讓人以為測試真的跑過。
 */
export function createDevServerTestRunner(options: DevServerOptions = {}): TestRunner {
  const opts: Required<DevServerOptions> = {
    scriptTimeoutMs: options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
    healthTimeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  };

  async function run(ctx: TestRunContext, kind: "test" | "e2e"): Promise<TestResult> {
    const cwd = ctx.worktreePath;
    // worktree 不在是環境壞了（git worktree add 失敗、被人手動刪掉），不是
    // 「這個專案沒有測試」-- 兩者都走 pass 的話，issue 會在完全沒有程式碼可
    // 測的情況下變成 done。拋出去讓排程器記錄並停住，人要介入。
    if (!existsSync(cwd)) {
      throw new Error(`worktree does not exist: ${cwd}`);
    }
    const scripts = readScripts(cwd);
    if (scripts === null) {
      return { pass: true, output: "[loom] no readable package.json, nothing to run" };
    }

    const target = pickScript(scripts, kind === "test" ? SCRIPTS.test : SCRIPTS.e2e);
    if (!target) {
      return { pass: true, output: `[loom] no ${kind} script in package.json, nothing to run` };
    }

    const setup = pickScript(scripts, SCRIPTS.setup);
    if (setup) {
      const result = await runScript(cwd, setup, ctx.port, opts.scriptTimeoutMs, ctx.onEvent);
      if (!result.ok) return { pass: false, output: `[loom] ${setup} failed\n${result.output}` };
    }

    const result = await withDevServer(cwd, scripts, ctx, opts, () =>
      runScript(cwd, target, ctx.port, opts.scriptTimeoutMs, ctx.onEvent),
    );
    return { pass: result.ok, output: result.output };
  }

  return {
    runIssueTests: (ctx) => run(ctx, "test"),
    runSpecE2E: (ctx) => run(ctx, "e2e"),
  };
}
