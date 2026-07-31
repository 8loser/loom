import { spawn } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

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

interface PackageJson {
  scripts?: Scripts;
  /** npm/bun 是字串陣列，yarn v1 是 `{ packages: [...] }`。 */
  workspaces?: string[] | { packages?: string[] };
}

function readPackageJson(cwd: string): PackageJson | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** 讀專案 package.json 的完整 scripts。coder prompt 用它列出「有哪些現成指令」。 */
export function readScripts(cwd: string): Scripts | null {
  const pkg = readPackageJson(cwd);
  if (pkg === null) return null;
  return pkg.scripts ?? {};
}

/**
 * pnpm 的 workspace 清單不在 package.json 裡，得另外讀。
 *
 * ponytail: 手寫解析，不為了這一個欄位裝 YAML 依賴。認得的是 block 寫法
 * （`packages:` 之後每行一個 `- pattern`），撐不住的是 flow 寫法
 * （`packages: ['a', 'b']`）與巢狀結構。兩者在 pnpm-workspace.yaml 實務上
 * 幾乎不出現；真的遇到就是這裡回空陣列、當成不是 monorepo，設定頁的
 * 「測試階段會跑」會照實顯示沒東西可跑，不會靜默算過。
 */
function readPnpmWorkspaceGlobs(root: string): string[] {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) return [];
  const block = readFileSync(path, "utf8").split(/^packages:[ \t]*$/m)[1];
  if (block === undefined) return [];
  const globs: string[] = [];
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
    if (item === null) break; // 縮排結束，下一個 top-level key
    globs.push(item[1]);
  }
  return globs;
}

function readWorkspaceGlobs(root: string): string[] {
  const pnpm = readPnpmWorkspaceGlobs(root);
  if (pnpm.length > 0) return pnpm;
  const ws = readPackageJson(root)?.workspaces;
  if (Array.isArray(ws)) return ws;
  return ws?.packages ?? [];
}

/** 一個有 scripts 的子 package：`dir` 是相對 repo 根的路徑。 */
export interface WorkspacePackage {
  dir: string;
  scripts: Scripts;
}

/**
 * 展開 workspaces glob，回傳每個子 package 的 scripts。順序排過 -- 測試跑的
 * 先後會進 runs.summary，每次不一樣的話兩輪的輸出沒辦法對照。
 */
export function readWorkspacePackages(root: string): WorkspacePackage[] {
  const dirs = new Set<string>();
  for (const glob of readWorkspaceGlobs(root)) {
    if (glob.startsWith("!")) continue; // 負向 pattern：跳過，不當成要掃的目錄
    for (const hit of globSync(`${glob}/package.json`, {
      cwd: root,
      // 依賴自己帶的 package.json 不是這個 repo 的 workspace。`**` 這種
      // pattern 沒有這條就會把整棵 node_modules 掃進來。
      exclude: (path) => path.includes("node_modules"),
    })) {
      dirs.add(dirname(hit));
    }
  }
  return [...dirs]
    .sort()
    .map((dir) => ({ dir, scripts: readScripts(join(root, dir)) ?? {} }))
    .filter((pkg) => Object.keys(pkg.scripts).length > 0);
}

/** 一個階段要跑的一個指令：`dir` 是相對 repo 根的路徑，根層是空字串。 */
export interface ScriptTarget {
  dir: string;
  script: string;
}

function pickScript(scripts: Scripts, candidates: readonly string[]): string | null {
  return candidates.find((name) => typeof scripts[name] === "string") ?? null;
}

/**
 * 一個階段實際會跑哪幾個指令。
 *
 * 根層有就只跑根層：專案自己寫的 `pnpm -r test` 或 `turbo run test` 是明確
 * 意圖，loom 再往子 package 遞迴一次等於同一批測試跑兩遍。根層沒有才展開
 * workspaces -- 這時候子 package 的 script 是唯一的線索，不跑就是靜默算過。
 */
function pickTargets(
  scripts: Scripts,
  candidates: readonly string[],
  packages: readonly WorkspacePackage[],
): ScriptTarget[] {
  const own = pickScript(scripts, candidates);
  if (own !== null) return [{ dir: "", script: own }];
  return packages.flatMap((pkg) => {
    const script = pickScript(pkg.scripts, candidates);
    return script === null ? [] : [{ dir: pkg.dir, script }];
  });
}

function pickInstall(cwd: string): string[] | null {
  return LOCKFILE_INSTALL.find(([name]) => existsSync(join(cwd, name)))?.[1] ?? null;
}

export interface ResolvedScripts {
  /** 根層 package.json 的全部 scripts，設定頁整份列出來。 */
  scripts: Scripts;
  /** workspaces 展開出來的子 package，不是 monorepo 就是空陣列。 */
  packages: WorkspacePackage[];
  /** 每個階段實際會跑哪幾個指令，沒有對應的就是空陣列。 */
  stages: { typecheck: ScriptTarget[]; test: ScriptTarget[]; e2e: ScriptTarget[] };
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
  const packages = readWorkspacePackages(repoPath);
  return {
    scripts,
    packages,
    stages: {
      typecheck: pickTargets(scripts, SCRIPTS.typecheck, packages),
      test: pickTargets(scripts, SCRIPTS.test, packages),
      e2e: pickTargets(scripts, SCRIPTS.e2e, packages),
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
  /** monorepo 的子 package 在自己的目錄跑，其餘都是 worktree 根。 */
  dir = "",
): Promise<ScriptResult> {
  ctx.onEvent?.({ at: Date.now(), kind: "bash", text: label });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: join(ctx.worktreePath, dir),
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

/**
 * 子 package 一律用 `npm run` 在自己的目錄跑，不去猜套件管理器的遞迴語法
 * （`pnpm -r` / `yarn workspaces foreach` / `npm --workspaces`）。`npm run`
 * 只是讀那一份 package.json 的 scripts 再交給 sh，pnpm 那種 symlink 的
 * node_modules/.bin 一樣認得，而安裝早就在根層用對的套件管理器做完了。
 */
function runScript(ctx: TestRunContext, target: ScriptTarget, timeoutMs: number): Promise<ScriptResult> {
  const label = target.dir === "" ? `npm run ${target.script}` : `npm run ${target.script} (${target.dir})`;
  return runCommand(ctx, "npm", ["run", "--silent", target.script], label, timeoutMs, target.dir);
}

/**
 * 一個階段的 target 依序跑完，第一個失敗就停 -- 階段之間本來就是這個語意
 * （typecheck 紅了不跑 test），monorepo 只是把「一個階段」變成多個指令。
 *
 * 多 target 時每段 output 前面標出是哪個 package：`runs.summary` 裡三份
 * `npm ERR!` 疊在一起而不說是誰紅的，coder 下一輪得自己猜要改哪個目錄。
 */
async function runStage(
  ctx: TestRunContext,
  targets: readonly ScriptTarget[],
  scriptTimeoutMs: number,
  run: (ctx: TestRunContext, target: ScriptTarget, timeoutMs: number) => Promise<ScriptResult>,
): Promise<ScriptResult> {
  const output: string[] = [];
  for (const target of targets) {
    const result = await run(ctx, target, scriptTimeoutMs);
    output.push(target.dir === "" ? result.output : `[loom] ${target.dir}: npm run ${target.script}\n${result.output}`);
    if (!result.ok) return { ...result, output: output.join("\n") };
  }
  return { ok: true, output: output.join("\n") };
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
  function readTarget(ctx: TestRunContext): { scripts: Scripts; packages: WorkspacePackage[] } | null {
    if (!existsSync(ctx.worktreePath)) throw new Error(`worktree does not exist: ${ctx.worktreePath}`);
    const scripts = readScripts(ctx.worktreePath);
    if (scripts === null) return null;
    return { scripts, packages: readWorkspacePackages(ctx.worktreePath) };
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
    const target = readTarget(ctx);
    if (target === null) return nothingToRun("no readable package.json");
    const { scripts, packages } = target;

    const typecheckTargets = pickTargets(scripts, SCRIPTS.typecheck, packages);
    const testTargets = pickTargets(scripts, SCRIPTS.test, packages);
    // e2e 只有 issue front matter 宣告了才跑，所以「沒有可跑的東西」這句話要
    // 照這一輪的實際範圍講：專案有 e2e script 但這個 issue 不跑它的時候，說成
    // 「沒有 e2e script」是假的，而這句話會原封不動存進 runs.summary。
    const e2eTargets = ctx.e2e ? pickTargets(scripts, SCRIPTS.e2e, packages) : [];
    if (typecheckTargets.length === 0 && testTargets.length === 0 && e2eTargets.length === 0) {
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
    if (typecheckTargets.length > 0) {
      const result = collected(await runStage(ctx, typecheckTargets, scriptTimeoutMs, runScript));
      if (!result.ok) return classify(result);
    }

    if (testTargets.length === 0 && e2eTargets.length === 0) {
      return { pass: true, output: [...output, "[loom] typecheck only, no test or e2e script"].join("\n") };
    }

    if (testTargets.length > 0) {
      const unit = collected(await runStage(ctx, testTargets, scriptTimeoutMs, runScript));
      if (!unit.ok) return classify(unit);
    }

    if (e2eTargets.length === 0) return { pass: true, output: output.join("\n") };
    return classify(collected(await runStage(ctx, e2eTargets, scriptTimeoutMs, runWithOneRetry)));
  }

  async function runSpecE2E(ctx: TestRunContext): Promise<TestResult> {
    const target = readTarget(ctx);
    if (target === null) return nothingToRun("no readable package.json");

    const e2eTargets = pickTargets(target.scripts, SCRIPTS.e2e, target.packages);
    if (e2eTargets.length === 0) return nothingToRun("no e2e script in package.json");

    const begun = await beginRun(ctx);
    if (!Array.isArray(begun)) return begun;

    const result = await runStage(ctx, e2eTargets, scriptTimeoutMs, runWithOneRetry);
    return classify({ ...result, output: [...begun, result.output].join("\n") });
  }

  return { runIssueTests, runSpecE2E };
}

/**
 * DESIGN.md「e2e 紅了先原地重跑一次，兩次都紅才算 domain fail。不這樣做的話
 * 一次 flaky 就吃掉一格重試額度。unit test 不需要這層」-- 所以只有 e2e 走這條。
 */
async function runWithOneRetry(ctx: TestRunContext, target: ScriptTarget, scriptTimeoutMs: number): Promise<ScriptResult> {
  const first = await runScript(ctx, target, scriptTimeoutMs);
  if (first.ok || first.infra) return first;

  ctx.onEvent?.({ at: Date.now(), kind: "say", text: "e2e 紅了，原地重跑一次確認不是 flaky" });
  const second = await runScript(ctx, target, scriptTimeoutMs);
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
