import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { allocatePort, createTestRunner, resolveScripts } from "./testrunner.ts";
import type { LiveEvent } from "./claude.ts";

const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "testrunner-test");
mkdirSync(scratchRoot, { recursive: true });

/** 寫一個只有 scripts 的 package.json，內容全用 node -e 免得依賴外部工具。 */
function repoWith(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(scratchRoot, "repo-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true, scripts }, null, 2));
  return dir;
}

/** 根層 package.json 加幾個子 package，用來測 workspaces 展開。 */
function monorepoWith(root: object, packages: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(scratchRoot, "mono-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", private: true, ...root }, null, 2));
  for (const [sub, scripts] of Object.entries(packages)) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, "package.json"), JSON.stringify({ name: sub.replace("/", "-"), scripts }, null, 2));
  }
  return dir;
}

function ctxFor(dir: string, port: number, events: LiveEvent[] = []) {
  return { worktreePath: dir, port, onEvent: (e: LiveEvent) => events.push(e) };
}

test("allocatePort: returns a port in range, and skips one that's already bound", async () => {
  const held = createServer();
  await new Promise<void>((resolve) => held.listen(4310, "127.0.0.1", resolve));
  try {
    const port = await allocatePort(4310, 4312);
    assert.notEqual(port, 4310, "4310 is taken, allocatePort must move on");
    assert.ok(port >= 4310 && port <= 4312, `a port outside the workspace's range would collide with another workspace: ${port}`);
  } finally {
    await new Promise((resolve) => held.close(resolve));
  }
});

test("allocatePort: rejects when every port in the range is taken", async () => {
  const held = createServer();
  await new Promise<void>((resolve) => held.listen(4313, "127.0.0.1", resolve));
  try {
    await assert.rejects(() => allocatePort(4313, 4313), /no free port/);
  } finally {
    await new Promise((resolve) => held.close(resolve));
  }
});

test("a missing worktree throws instead of passing -- an issue must never go done with no code to test", async () => {
  const gone = join(scratchRoot, "definitely-not-created");
  await assert.rejects(
    () => createTestRunner().runIssueTests(ctxFor(gone, 4330)),
    /worktree does not exist/,
    "this is the difference between 'the project has no tests' and 'there is nothing here at all'",
  );
});

test("no package.json and no test script both report pass with output saying nothing ran, not a silent green", async () => {
  const runner = createTestRunner();

  const empty = mkdtempSync(join(scratchRoot, "bare-"));
  const noPkg = await runner.runIssueTests(ctxFor(empty, 4320));
  assert.equal(noPkg.pass, true, "a project loom can't introspect must not deadlock the pipeline");
  assert.match(noPkg.output, /no readable package\.json/, "but the reason is recorded, not silent");

  const noScript = await runner.runIssueTests(ctxFor(repoWith({ build: "true" }), 4321));
  assert.equal(noScript.pass, true);
  assert.match(noScript.output, /no typecheck\/test script/);

  const noE2E = await runner.runSpecE2E(ctxFor(repoWith({ test: "true" }), 4322));
  assert.equal(noE2E.pass, true);
  assert.match(noE2E.output, /no e2e script/);
});

test("a passing test script runs for real and its stdout is captured", async () => {
  const dir = repoWith({ test: `node -e "console.log('42 tests passed')"` });
  const events: LiveEvent[] = [];
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4323, events));

  assert.equal(result.pass, true);
  assert.match(result.output, /42 tests passed/, "the project's own output is what lands in runs.summary");
  assert.deepEqual(
    events.filter((e) => e.kind === "bash").map((e) => e.text),
    ["npm run test"],
    "the command shows up on the board's live feed",
  );
});

test("a failing test script is a fail, and its output survives for the coder's next attempt", async () => {
  const dir = repoWith({ test: `node -e "console.error('expected 1 to be 2'); process.exit(1)"` });
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4324));

  assert.equal(result.pass, false, "non-zero exit is the whole point");
  assert.match(result.output, /expected 1 to be 2/);
});

// loom 不再起 dev server：要 server 的測試自己起（Playwright 的 webServer），
// loom 只保證這一輪的 PORT 唯一並交出去。
test("PORT is injected into the script's environment and reported to the board", async () => {
  const dir = repoWith({ test: `node -e "console.log('PORT=' + process.env.PORT)"` });
  const events: LiveEvent[] = [];
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4326, events));

  assert.equal(result.pass, true);
  assert.match(result.output, /PORT=4326/, "DESIGN.md: loom only guarantees PORT, the script decides what to do with it");
  assert.equal(events.find((e) => e.kind === "port")?.text, "4326", "the board's 連線埠 field reads this event");
});

test("a script that hangs is killed at the timeout rather than blocking the scheduler", async () => {
  const dir = repoWith({ test: `node -e "setTimeout(()=>{}, 60000)"` });
  const result = await createTestRunner({ scriptTimeoutMs: 1200 }).runIssueTests(ctxFor(dir, 4329));

  assert.equal(result.pass, false);
  assert.match(result.output, /timed out/);
});

// DESIGN.md「失敗與重試」的表格分兩類：測試真的紅了是 domain（退回 implementing
// 讓 coder 再改一次），環境問題是 infra（直接 blocked）。orchestrator 靠 failure
// 欄位分流，混在一起的話一次基礎設施故障會吃掉 coder 的三次改 code 機會，而且
// 第三次會觸發三階段清除把已完成的工作全部丟掉。
test("timeouts are infra failures, a red test is a domain failure", async () => {
  const runner = createTestRunner({ scriptTimeoutMs: 1200 });

  const redTest = await runner.runIssueTests(ctxFor(repoWith({ test: `node -e "process.exit(1)"` }), 4331));
  assert.equal(redTest.failure, "domain", "a genuinely failing test is the coder's problem");

  const hung = await runner.runIssueTests(ctxFor(repoWith({ test: `node -e "setTimeout(()=>{}, 60000)"` }), 4333));
  assert.equal(hung.failure, "infra", "the same workload will time out the same way, retrying is pointless");

  const hungTypecheck = await runner.runIssueTests(
    ctxFor(repoWith({ typecheck: `node -e "setTimeout(()=>{}, 60000)"`, test: "true" }), 4334),
  );
  assert.equal(hungTypecheck.failure, "infra", "every stage classifies the same way, not just the test stage");
});

// 逾時只是 infra 的一種。指令根本 spawn 不起來（npm 不在 PATH、worktree 權限
// 壞掉）同樣是環境問題，判成 domain 的話 coder 會被派去修一個不存在的 bug。
test("a command that cannot even be spawned is an infra failure, not a red test", async () => {
  const dir = repoWith({ test: "true" });
  const realPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(scratchRoot, "empty-path-"));
  try {
    const result = await createTestRunner().runIssueTests(ctxFor(dir, 4347));
    assert.equal(result.pass, false);
    assert.equal(result.failure, "infra", "npm missing is the machine's problem, not the coder's");
    assert.match(result.output, /spawn error/);
  } finally {
    process.env.PATH = realPath;
  }
});

// DESIGN.md「失敗與重試」把安裝失敗列為 infra 的第一個成因。裝不起來的話後面
// 每個階段都會用一棵半殘的依賴樹跑，紅了也不是 coder 的錯。
test("a failing install is an infra failure and short-circuits both entry points", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "test-ran.txt");
  const scripts = { test: `node -e "require('fs').writeFileSync('${marker}', 'x')"`, e2e: "true" };
  const runner = createTestRunner({ scriptTimeoutMs: 60_000 });

  const dir = repoWith(scripts);
  writeFileSync(join(dir, "package-lock.json"), "not json at all");
  const issue = await runner.runIssueTests(ctxFor(dir, 4348));
  assert.equal(issue.failure, "infra", "npm ci against a broken lockfile is an environment fault");
  assert.match(issue.output, /setup failed/);
  assert.equal(existsSync(marker), false, "a broken install must not let tests run against a half-installed tree");

  const specDir = repoWith(scripts);
  writeFileSync(join(specDir, "package-lock.json"), "not json at all");
  const spec = await runner.runSpecE2E(ctxFor(specDir, 4349));
  assert.equal(spec.failure, "infra", "the spec-level e2e path classifies install failure the same way");
});

test("typecheck runs first, and a type error fails without ever running the tests", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "tests-ran.txt");
  const dir = repoWith({
    typecheck: `node -e "process.exit(2)"`,
    test: `node -e "require('fs').writeFileSync('${marker}', 'x')"`,
  });
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4335));

  assert.equal(result.pass, false);
  assert.equal(result.failure, "domain", "a type error is the coder's problem, not infrastructure");
  assert.equal(existsSync(marker), false, "no point running tests for code that won't compile");
});

// runs.summary 存這份，coder 下一輪的 prompt 也帶這份（DESIGN.md「失敗時的
// 資訊傳遞」）。每個跑過的階段都要留下痕跡，否則紅在哪一階段看不出來。
test("output accumulates across every stage that ran, not just the last or the failing one", async () => {
  const dir = repoWith({
    typecheck: `node -e "console.log('TYPES OK')"`,
    test: `node -e "console.log('UNIT OK')"`,
    e2e: `node -e "console.log('E2E OK')"`,
  });
  const result = await createTestRunner().runIssueTests({ ...ctxFor(dir, 4344), e2e: true });

  assert.equal(result.pass, true);
  for (const stage of ["TYPES OK", "UNIT OK", "E2E OK"]) {
    assert.ok(result.output.includes(stage), `lost the ${stage} stage from the summary: ${JSON.stringify(result.output)}`);
  }
});

test("when a later stage fails, the earlier stages' output is still there to show what did pass", async () => {
  const dir = repoWith({
    typecheck: `node -e "console.log('TYPES OK')"`,
    test: `node -e "console.error('UNIT RED'); process.exit(1)"`,
  });
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4345));

  assert.equal(result.failure, "domain");
  assert.ok(result.output.includes("TYPES OK"), "the coder needs to see typecheck passed before the tests went red");
  assert.ok(result.output.includes("UNIT RED"));
});

test("typecheck can be the only thing that runs", async () => {
  const dir = repoWith({ typecheck: `node -e "console.log('types ok')"` });
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4336));

  assert.equal(result.pass, true);
  assert.match(result.output, /typecheck only/);
});

// DESIGN.md「issue front matter 宣告 e2e: true 的：該 issue 也跑一次 e2e」。
test("an issue only runs e2e when its front matter asked for it", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "e2e-ran.txt");
  const scripts = {
    test: "true",
    e2e: `node -e "require('fs').writeFileSync('${marker}', 'x')"`,
  };

  await createTestRunner().runIssueTests(ctxFor(repoWith(scripts), 4337));
  assert.equal(existsSync(marker), false, "a plain issue must not pay for an e2e run");

  const withE2E = { ...ctxFor(repoWith(scripts), 4338), e2e: true };
  const result = await createTestRunner().runIssueTests(withE2E);
  assert.equal(result.pass, true);
  assert.equal(existsSync(marker), true, "an issue flagged e2e:true runs it");
});

// `e2e` 是第一候選，`test:e2e` 是 npm 慣用的命名空間寫法，兩種都很常見。
test("test:e2e is recognised as the e2e stage when there is no plain e2e script", async () => {
  const dir = repoWith({ "test:e2e": `node -e "console.log('NAMESPACED E2E')"` });
  const result = await createTestRunner().runSpecE2E(ctxFor(dir, 4346));

  assert.equal(result.pass, true);
  assert.match(result.output, /NAMESPACED E2E/);
});

// DESIGN.md「e2e 紅了先原地重跑一次，兩次都紅才算 domain fail。不這樣做的話
// 一次 flaky 就吃掉一格重試額度。unit test 不需要這層」。
test("a flaky e2e passes on its automatic second run; unit tests get no such retry", async () => {
  const counter = join(mkdtempSync(join(scratchRoot, "counter-")), "runs.txt");
  const countingScript = (failUntil: number) =>
    `node -e "const f=require('fs');const n=(f.existsSync('${counter}')?+f.readFileSync('${counter}','utf8'):0)+1;f.writeFileSync('${counter}',String(n));console.log('run '+n);process.exit(n<=${failUntil}?1:0)"`;

  const flaky = { ...ctxFor(repoWith({ e2e: countingScript(1) }), 4339), e2e: true };
  const result = await createTestRunner().runIssueTests(flaky);
  assert.equal(result.pass, true, "first run red, retry green, so it was flaky and must not cost a retry slot");
  assert.match(result.output, /treated as flaky/);

  // unit test 沒有這層：紅一次就是紅。
  const unitCounter = join(mkdtempSync(join(scratchRoot, "counter-")), "unit.txt");
  const unit = await createTestRunner().runIssueTests(
    ctxFor(
      repoWith({
        test: `node -e "const f=require('fs');const n=(f.existsSync('${unitCounter}')?+f.readFileSync('${unitCounter}','utf8'):0)+1;f.writeFileSync('${unitCounter}',String(n));process.exit(1)"`,
      }),
      4340,
    ),
  );
  assert.equal(unit.pass, false);
  assert.equal(
    Number(readFileSync(unitCounter, "utf8")),
    1,
    "unit tests are deterministic, retrying them just hides a real failure",
  );
});

// 重跑本身掛住是環境問題。判成 domain 的話一次卡死的重跑會吃掉一格改 code 的
// 額度，而 coder 收到的是一份沒有任何測試失敗訊息的「測試紅了」。
test("an e2e retry that hangs is an infra failure, not a second red run", async () => {
  const counter = join(mkdtempSync(join(scratchRoot, "counter-")), "runs.txt");
  // 第一次紅，第二次掛住不退出。
  const script = `node -e "const f=require('fs');const n=(f.existsSync('${counter}')?+f.readFileSync('${counter}','utf8'):0)+1;f.writeFileSync('${counter}',String(n));if(n>1){setTimeout(()=>{},60000)}else{console.error('first run red');process.exit(1)}"`;
  const ctx = { ...ctxFor(repoWith({ e2e: script }), 4350), e2e: true };
  const result = await createTestRunner({ scriptTimeoutMs: 1200 }).runIssueTests(ctx);

  assert.equal(result.pass, false);
  assert.equal(result.failure, "infra", "a hung retry is the environment, not the coder");
  assert.match(result.output, /timed out/);
});

// DESIGN.md「成功的階段也算」-- 安裝跑過就該在 summary 裡看得到，否則「裝了什麼
// 版本」這個線索在依賴相關的失敗上就沒了。
test("a successful install leaves its output in the summary alongside the test stages", async () => {
  const dir = repoWith({ test: `node -e "console.log('UNIT OK')"` });
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "probe", lockfileVersion: 3, packages: {} }));
  const result = await createTestRunner({ scriptTimeoutMs: 60_000 }).runIssueTests(ctxFor(dir, 4351));

  assert.equal(result.pass, true);
  assert.match(result.output, /UNIT OK/);
  assert.ok(
    result.output.split("UNIT OK")[0].trim().length > 0,
    `the install stage ran but left nothing in the summary: ${JSON.stringify(result.output)}`,
  );
});

// e2e 只有 issue 宣告了才跑，所以「沒東西可跑」這句話要照這一輪的實際範圍講 --
// 它會原封不動存進 runs.summary，寫成「沒有 e2e script」是假的。
test("the nothing-to-run message does not claim an e2e script is missing when the issue never asked for one", async () => {
  const dir = repoWith({ e2e: "true", build: "true" });
  const plain = await createTestRunner().runIssueTests(ctxFor(dir, 4352));

  assert.equal(plain.pass, true);
  assert.match(plain.output, /no typecheck\/test script/);
  assert.doesNotMatch(plain.output, /e2e/, "this issue was never going to run e2e, so its absence is not the reason");
});

// 安裝指令沒有 script 可以宣告，一律由 lockfile 決定。
test("the install command comes from whichever lockfile is present, and is skipped when there is none", async () => {
  const dir = repoWith({ test: "true" });
  writeFileSync(join(dir, "package-lock.json"), "{}");
  const events: LiveEvent[] = [];
  await createTestRunner({ scriptTimeoutMs: 60_000 }).runIssueTests(ctxFor(dir, 4341, events));

  assert.ok(
    events.some((e) => e.text === "npm ci"),
    `package-lock.json should select npm ci, got: ${JSON.stringify(events.map((e) => e.text))}`,
  );

  const pnpmDir = repoWith({ test: "true" });
  writeFileSync(join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n");
  const pnpmEvents: LiveEvent[] = [];
  await createTestRunner({ scriptTimeoutMs: 30_000 }).runIssueTests(ctxFor(pnpmDir, 4342, pnpmEvents));
  assert.ok(
    pnpmEvents.some((e) => e.text.startsWith("pnpm install")),
    `pnpm-lock.yaml should select pnpm install, got: ${JSON.stringify(pnpmEvents.map((e) => e.text))}`,
  );

  const noLockfile = repoWith({ test: "true" });
  const bareEvents: LiveEvent[] = [];
  await createTestRunner().runIssueTests(ctxFor(noLockfile, 4343, bareEvents));
  assert.deepEqual(
    bareEvents.filter((e) => e.kind === "bash").map((e) => e.text),
    ["npm run test"],
    "no lockfile means no install step at all",
  );
});

// monorepo 的執行面：每個有該 script 的 package 都要真的跑到，而且要在自己的
// 目錄跑（`npm run` 讀的是那一份 package.json）。
test("each workspace package runs in its own directory, in a stable order", async () => {
  const dir = monorepoWith({ workspaces: ["apps/*"] }, {
    "apps/web": { test: `node -e "console.log('ran in ' + process.cwd())"` },
    "apps/api": { test: `node -e "console.log('ran in ' + process.cwd())"` },
  });
  const events: LiveEvent[] = [];
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4353, events));

  assert.equal(result.pass, true);
  assert.match(result.output, /ran in .*apps\/api/, "the api package's script ran with its own directory as cwd");
  assert.match(result.output, /ran in .*apps\/web/, "and so did the web package's -- not just the first one found");
  assert.deepEqual(
    events.filter((e) => e.kind === "bash").map((e) => e.text),
    ["npm run test (apps/api)", "npm run test (apps/web)"],
    "the board's live feed says which package each command belongs to",
  );
});

// runs.summary 是 coder 下一輪 prompt 帶的東西。三份 npm ERR! 疊在一起而不說是
// 誰紅的，coder 得自己猜要改哪個目錄。
test("a red workspace package names itself in the summary, and stops the stage", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "web-ran.txt");
  const dir = monorepoWith({ workspaces: ["apps/*"] }, {
    "apps/api": { test: `node -e "console.error('API RED'); process.exit(1)"` },
    "apps/web": { test: `node -e "require('fs').writeFileSync('${marker}', 'x')"` },
  });
  const result = await createTestRunner().runIssueTests(ctxFor(dir, 4354));

  assert.equal(result.failure, "domain", "a red test in a sub-package is still the coder's problem");
  assert.match(result.output, /API RED/);
  assert.match(result.output, /apps\/api/, "without the package name the coder cannot tell which one to fix");
  assert.equal(existsSync(marker), false, "the stage stops at the first red package, like every other stage");
});

// 設定頁顯示的是這份，判斷不在 ui.html 裡重寫一次。
test("resolveScripts reports the project's scripts alongside which one each stage picked", () => {
  const dir = repoWith({ typecheck: "tsc", test: "vitest run", "test:e2e": "playwright test", build: "vite build" });
  writeFileSync(join(dir, "yarn.lock"), "");
  const resolved = resolveScripts(dir);

  assert.equal(resolved.scripts.build, "vite build", "the full script list is what the settings page lists");
  assert.deepEqual(resolved.stages, {
    typecheck: [{ dir: "", script: "typecheck" }],
    test: [{ dir: "", script: "test" }],
    e2e: [{ dir: "", script: "test:e2e" }],
  });
  assert.deepEqual(resolved.packages, [], "a single-package repo has no workspaces to show");
  assert.match(resolved.install ?? "", /^yarn install/);

  const bare = resolveScripts(mkdtempSync(join(scratchRoot, "bare-")));
  assert.deepEqual(bare.scripts, {}, "a project with no package.json still renders, it just has nothing to show");
  assert.deepEqual(bare.stages, { typecheck: [], test: [], e2e: [] });
  assert.equal(bare.install, null);
});

// monorepo：根層沒有該階段的 script 時往 workspaces 的子 package 找。不這樣做
// 的話前後端分目錄的專案在 loom 眼裡是「沒有 typecheck/test/e2e」，測試階段直接
// 算過 -- 那是所有靜默綠燈裡最貴的一種。
test("resolveScripts falls back to workspace packages for stages the root does not define", () => {
  const dir = monorepoWith({ workspaces: ["apps/*"] }, {
    "apps/web": { typecheck: "tsc", test: "vitest run", e2e: "playwright test" },
    "apps/api": { typecheck: "tsc", test: "vitest run" },
  });
  const resolved = resolveScripts(dir);

  assert.deepEqual(resolved.stages.typecheck, [
    { dir: "apps/api", script: "typecheck" },
    { dir: "apps/web", script: "typecheck" },
  ], "every package that has the script runs, in a stable order");
  assert.deepEqual(resolved.stages.e2e, [{ dir: "apps/web", script: "e2e" }], "only the package that has it");
  assert.deepEqual(
    resolved.packages.map((p) => p.dir),
    ["apps/api", "apps/web"],
    "the settings page lists the workspace packages it found",
  );
});

// 專案自己寫的 `pnpm -r test` / `turbo run test` 是明確意圖。loom 再往子 package
// 遞迴一次的話同一批測試會跑兩遍，時間翻倍而且第二遍的紅綠沒有新資訊。
test("a root script wins over the workspace packages instead of running both", () => {
  const dir = monorepoWith({ workspaces: ["apps/*"], scripts: { test: "turbo run test" } }, {
    "apps/web": { test: "vitest run" },
  });
  const resolved = resolveScripts(dir);

  assert.deepEqual(resolved.stages.test, [{ dir: "", script: "test" }], "the root aggregate is the whole stage");
});

// pnpm 的 workspace 清單不在 package.json 裡。認不出來的話 pnpm monorepo 會
// 落回「沒有 script」那條路徑，也就是靜默算過。
test("pnpm-workspace.yaml is recognised as the workspace declaration", () => {
  const dir = monorepoWith({}, { "packages/core": { test: "vitest run" } });
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  # 註解不該被當成 pattern\n");

  assert.deepEqual(resolveScripts(dir).stages.test, [{ dir: "packages/core", script: "test" }]);
});

// yarn v1 的 workspaces 是 `{ packages: [...] }`，不是字串陣列。
test("the yarn v1 object form of workspaces is recognised too", () => {
  const dir = monorepoWith({ workspaces: { packages: ["packages/*"] } }, { "packages/core": { test: "vitest run" } });

  assert.deepEqual(resolveScripts(dir).stages.test, [{ dir: "packages/core", script: "test" }]);
});

// 依賴自己帶的 package.json 不是這個 repo 的 workspace。`**` 這種 pattern 沒有
// 排除 node_modules 的話，一個 workspace 會擴張成整棵依賴樹。
test("node_modules is never mistaken for a workspace package", () => {
  const dir = monorepoWith({ workspaces: ["**"] }, {
    "apps/web": { test: "vitest run" },
    "node_modules/left-pad": { test: "should never run" },
  });

  assert.deepEqual(resolveScripts(dir).stages.test, [{ dir: "apps/web", script: "test" }]);
});
