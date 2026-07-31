import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { LiveEvent } from "./claude.ts";
import type { TestResult, TestRunContext, TestRunner } from "./orchestrator.ts";

/**
 * DESIGN.md「執行指令由 package.json 提供」：loom 認的是專案本來就會有的
 * 慣例名稱，不要求任何專案為了 loom 新增 script。每個階段可以有多個候選，
 * 取第一個存在的。
 *
 * 這裡沒有 dev 這一階段：需要 server 的測試由測試指令自己起（Playwright 的
 * `webServer` 就是做這件事，而且它自己負責收掉）。loom 只保證每一輪的 `PORT`
 * 唯一並放進環境變數，怎麼用是專案的事。
 */
// ponytail: 只比對名稱，不看 script 內容。專案的 `test` 如果是 watch mode
// （`vitest` 不加 `run`）就會一路跑到 scriptTimeoutMs 才被砍成 infra failure。
// 症狀看得見不是假綠燈，而且 CI 本來也跑不了 watch mode。真要擋的話是在
// resolveScripts 裡認出 watch 的旗標並在設定頁標警告，不是在這裡改執行方式。
const SCRIPTS = {
  typecheck: ["typecheck"],
  test: ["test"],
  e2e: ["e2e", "test:e2e"],
} as const;

// 安裝一律由 lockfile 決定：agent 可能加了新依賴，而每個套件管理器的
// frozen install 指令是固定的，不需要專案再宣告一次。
const LOCKFILE_INSTALL: [string, string[]][] = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci"]],
];

export interface TestRunnerOptions {
  /** 單一 script 的上限。 */
  scriptTimeoutMs?: number;
}

const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

interface Scripts {
  [name: string]: string;
}

/** 讀專案 package.json 的完整 scripts。coder prompt 用它列出「有哪些現成指令」。 */
export function readScripts(cwd: string): Scripts | null {
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

function pickInstall(cwd: string): string[] | null {
  return LOCKFILE_INSTALL.find(([name]) => existsSync(join(cwd, name)))?.[1] ?? null;
}

export interface ResolvedScripts {
  /** 專案 package.json 的全部 scripts，設定頁整份列出來。 */
  scripts: Scripts;
  /** 每個階段實際會跑哪個 script，沒有對應的就是 null。 */
  stages: { typecheck: string | null; test: string | null; e2e: string | null };
  /** lockfile 選出來的安裝指令，沒有 lockfile 就是 null。 */
  install: string | null;
}

/**
 * 設定頁用：把「專案有哪些指令」與「loom 這一輪會拿哪幾個去跑」一起回答。
 * 判斷留在這個檔案，設定頁只負責顯示 -- 兩邊各寫一份的話，改了候選名稱而
 * 設定頁沒跟上，是不會有人發現的那種偏差。
 */
export function resolveScripts(repoPath: string): ResolvedScripts {
  const scripts = readScripts(repoPath) ?? {};
  return {
    scripts,
    stages: {
      typecheck: pickScript(scripts, SCRIPTS.typecheck),
      test: pickScript(scripts, SCRIPTS.test),
      e2e: pickScript(scripts, SCRIPTS.e2e),
    },
    install: pickInstall(repoPath)?.join(" ") ?? null,
  };
}

/**
 * 從 workspace 的 port range 找一個現在沒人綁的 port，放進測試指令的環境變數。
 *
 * ponytail: 試綁再放掉，中間有 TOCTOU 空窗，而且從放掉到測試指令自己去綁的
 * 這段比 loom 自己起 server 的時候更長。同一個 workspace 目前是序列跑測試
 * （見 orchestrator.ts 的 ponytail 註解），實務上撞不到。被搶走之後會怎樣由
 * 專案的 server 決定 -- 綁不上就報錯（`strictPort`），也可能自己換一個 port
 * 而測試連到別人的 server。要把這個空窗關掉就得改成 loom 綁著 socket 傳給
 * 子行程，那要求每個框架都支援 fd 繼承，換不到現在的成本。
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
  /**
   * 這次沒過是環境的問題，不是測試真的紅了：被逾時砍掉，或根本 spawn 不起來
   * （npm 不在 PATH、worktree 權限壞掉）。DESIGN.md「失敗與重試」把這一類直接
   * 判 blocked，跟 domain 失敗吃不同的額度 -- 同樣的環境再跑一次結果一樣，
   * 不該花掉 coder 改 code 的機會。
   */
  infra?: boolean;
}

/**
 * 跑一個指令到結束。detached 讓它自成一個 process group -- 專案的 script
 * 幾乎一定會再 spawn 別的東西（vite、playwright、docker），只 kill npm 自己
 * 會留下孤兒佔住 port，那正是 DESIGN.md 說要避免的症狀。
 */
function runCommand(
  ctx: TestRunContext,
  cmd: string,
  args: string[],
  label: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  ctx.onEvent?.({ at: Date.now(), kind: "bash", text: label });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ctx.worktreePath,
      env: { ...process.env, PORT: String(ctx.port) },
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
      finish({ ok: false, infra: true, output: `${output}\n[loom] ${label} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => finish({ ok: false, infra: true, output: `${output}\n[loom] spawn error: ${err.message}` }));
    child.on("close", (code) => finish({ ok: code === 0, output }));
  });
}

function runScript(ctx: TestRunContext, script: string, timeoutMs: number): Promise<ScriptResult> {
  return runCommand(ctx, "npm", ["run", "--silent", script], `npm run ${script}`, timeoutMs);
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

function nothingToRun(what: string): TestResult {
  return { pass: true, output: `[loom] ${what}, nothing to run` };
}

function infraFailure(output: string): TestResult {
  return { pass: false, failure: "infra", output };
}

/**
 * 一個階段的結果換算成 DESIGN.md「失敗與重試」的三種回傳值。三個階段共用同一
 * 份判斷 -- 各自寫一次的話，漏掉 infra 那一支的症狀是環境故障被算成測試紅了，
 * 吃掉 coder 的重試額度而且要等第三次觸發三階段清除才看得出來。
 */
function classify(result: ScriptResult): TestResult {
  if (result.infra) return infraFailure(result.output);
  return { pass: result.ok, output: result.output, failure: result.ok ? undefined : "domain" };
}

/**
 * 跑專案自己的驗證指令。
 *
 * 「沒有可跑的東西」與「跑了而且過了」在回傳值上都是 pass，但 output 會寫
 * 明是哪一種，並且會存進 runs.summary。這是刻意的取捨：非 Node 專案不該讓
 * 整條流水線卡死，但也不該讓人以為測試真的跑過。
 */
export function createTestRunner(options: TestRunnerOptions = {}): TestRunner {
  const scriptTimeoutMs = options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  /**
   * 讀出這個 worktree 的 scripts。worktree 不在是環境壞了（git worktree add
   * 失敗、被人手動刪掉），不是「這個專案沒有測試」-- 兩者都走 pass 的話，issue
   * 會在完全沒有程式碼可測的情況下變成 done。拋出去讓排程器記錄並停住，人要介入。
   */
  function readTarget(ctx: TestRunContext): Scripts | null {
    if (!existsSync(ctx.worktreePath)) throw new Error(`worktree does not exist: ${ctx.worktreePath}`);
    return readScripts(ctx.worktreePath);
  }

  /**
   * 確定有東西要跑之後的開場：把這一輪的 PORT 交出去、依 lockfile 裝依賴。
   * 回傳 TestResult 代表安裝就失敗了，呼叫端直接把它交出去；否則回傳已經跑過
   * 的階段 output。
   */
  async function beginRun(ctx: TestRunContext): Promise<TestResult | string[]> {
    // 看板的「連線埠」欄讀這個事件。指令拿到的 PORT 就是它，要不要用它起一個
    // server 是指令自己的事。
    ctx.onEvent?.({ at: Date.now(), kind: "port", text: String(ctx.port) });

    const install = pickInstall(ctx.worktreePath);
    if (!install) return [];
    const [cmd, ...args] = install;
    const result = await runCommand(ctx, cmd, args, install.join(" "), scriptTimeoutMs);
    if (!result.ok) return infraFailure(`[loom] setup failed\n${result.output}`);
    return [result.output];
  }

  async function runIssueTests(ctx: TestRunContext): Promise<TestResult> {
    const scripts = readTarget(ctx);
    if (scripts === null) return nothingToRun("no readable package.json");

    const typecheckScript = pickScript(scripts, SCRIPTS.typecheck);
    const testScript = pickScript(scripts, SCRIPTS.test);
    // e2e 只有 issue front matter 宣告了才跑，所以「沒有可跑的東西」這句話要
    // 照這一輪的實際範圍講：專案有 e2e script 但這個 issue 不跑它的時候，說成
    // 「沒有 e2e script」是假的，而這句話會原封不動存進 runs.summary。
    const e2eScript = ctx.e2e ? pickScript(scripts, SCRIPTS.e2e) : null;
    if (!typecheckScript && !testScript && !e2eScript) {
      return nothingToRun(`no ${ctx.e2e ? "typecheck/test/e2e" : "typecheck/test"} script in package.json`);
    }

    const begun = await beginRun(ctx);
    if (!Array.isArray(begun)) return begun;

    // 每一階段的 output 都累積，成功的階段也算：runs.summary 存的是「這一輪
    // 跑了什麼」，而 coder 下一輪的 prompt 帶的就是這份（DESIGN.md「失敗時的
    // 資訊傳遞」）。只留失敗那段的話，紅在哪一階段、前面幾段有沒有警告都看不到。
    const output = begun;
    const collected = (result: ScriptResult): ScriptResult => {
      output.push(result.output);
      return { ...result, output: output.join("\n") };
    };

    // typecheck 先跑：編譯不過就沒必要花時間跑後面兩段。
    if (typecheckScript) {
      const result = collected(await runScript(ctx, typecheckScript, scriptTimeoutMs));
      if (!result.ok) return classify(result);
    }

    if (!testScript && !e2eScript) {
      return { pass: true, output: [...output, "[loom] typecheck only, no test or e2e script"].join("\n") };
    }

    if (testScript) {
      const unit = collected(await runScript(ctx, testScript, scriptTimeoutMs));
      if (!unit.ok) return classify(unit);
    }

    if (!e2eScript) return { pass: true, output: output.join("\n") };
    return classify(collected(await runWithOneRetry(ctx, e2eScript, scriptTimeoutMs)));
  }

  async function runSpecE2E(ctx: TestRunContext): Promise<TestResult> {
    const scripts = readTarget(ctx);
    if (scripts === null) return nothingToRun("no readable package.json");

    const e2eScript = pickScript(scripts, SCRIPTS.e2e);
    if (!e2eScript) return nothingToRun("no e2e script in package.json");

    const begun = await beginRun(ctx);
    if (!Array.isArray(begun)) return begun;

    const result = await runWithOneRetry(ctx, e2eScript, scriptTimeoutMs);
    return classify({ ...result, output: [...begun, result.output].join("\n") });
  }

  return { runIssueTests, runSpecE2E };
}

/**
 * DESIGN.md「e2e 紅了先原地重跑一次，兩次都紅才算 domain fail。不這樣做的話
 * 一次 flaky 就吃掉一格重試額度。unit test 不需要這層」-- 所以只有 e2e 走這條。
 */
async function runWithOneRetry(ctx: TestRunContext, script: string, scriptTimeoutMs: number): Promise<ScriptResult> {
  const first = await runScript(ctx, script, scriptTimeoutMs);
  if (first.ok || first.infra) return first;

  ctx.onEvent?.({ at: Date.now(), kind: "say", text: "e2e 紅了，原地重跑一次確認不是 flaky" });
  const second = await runScript(ctx, script, scriptTimeoutMs);
  if (second.ok) {
    return {
      ok: true,
      output: `${first.output}\n[loom] first e2e run failed, retry passed (treated as flaky):\n${second.output}`,
    };
  }
  // 重跑掛住是環境問題，不是「測試又紅了一次」-- infra 要跟著傳出去，否則一次
  // 卡死的重跑會被算成 domain failure，吃掉 coder 改 code 的額度。
  return {
    ok: false,
    infra: second.infra,
    output: `${first.output}\n[loom] retried once, failed again:\n${second.output}`,
  };
}
