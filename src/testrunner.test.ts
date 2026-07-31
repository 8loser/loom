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

function ctxFor(dir: string, port: number, events: LiveEvent[] = []) {
  return { worktreePath: dir, port, onEvent: (e: LiveEvent) => events.push(e) };
}

test("allocatePort: returns a port in range, and skips one that's already bound", async () => {
  const held = createServer();
  await new Promise<void>((resolve) => held.listen(4310, "127.0.0.1", resolve));
  try {
    const port = await allocatePort(4310, 4312);
    assert.notEqual(port, 4310, "4310 is taken, allocatePort must move on");
    assert.ok(port >= 4310 && port <= 4312);
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
  assert.match(noScript.output, /no typecheck\/test\/e2e script/);

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

// DESIGN.md「失敗與重試」的表格分兩類 infra：subprocess 非零退出是「原地
// 重跑」，超時是「直接 blocked」。orchestrator 靠 failure 欄位分流，混在一起
// 的話一次基礎設施故障會吃掉 coder 的三次改 code 機會，而且第三次會觸發三階段
// 清除把已完成的工作全部丟掉。
test("timeouts are infra failures, a red test is a domain failure", async () => {
  const runner = createTestRunner({ scriptTimeoutMs: 1200 });

  const redTest = await runner.runIssueTests(ctxFor(repoWith({ test: `node -e "process.exit(1)"` }), 4331));
  assert.equal(redTest.failure, "domain", "a genuinely failing test is the coder's problem");

  const hung = await runner.runIssueTests(ctxFor(repoWith({ test: `node -e "setTimeout(()=>{}, 60000)"` }), 4333));
  assert.equal(hung.failure, "infra", "the same workload will time out the same way, retrying is pointless");

  const hungTypecheck = await runner.runIssueTests(
    ctxFor(repoWith({ typecheck: `node -e "setTimeout(()=>{}, 60000)"`, test: "true" }), 4334),
  );
  assert.equal(hungTypecheck.failure, "infra");
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

// 設定頁顯示的是這份，判斷不在 ui.html 裡重寫一次。
test("resolveScripts reports the project's scripts alongside which one each stage picked", () => {
  const dir = repoWith({ typecheck: "tsc", test: "vitest run", "test:e2e": "playwright test", build: "vite build" });
  writeFileSync(join(dir, "yarn.lock"), "");
  const resolved = resolveScripts(dir);

  assert.equal(resolved.scripts.build, "vite build", "the full script list is what the settings page lists");
  assert.deepEqual(resolved.stages, { typecheck: "typecheck", test: "test", e2e: "test:e2e" });
  assert.match(resolved.install ?? "", /^yarn install/);

  const bare = resolveScripts(mkdtempSync(join(scratchRoot, "bare-")));
  assert.deepEqual(bare.scripts, {}, "a project with no package.json still renders, it just has nothing to show");
  assert.deepEqual(bare.stages, { typecheck: null, test: null, e2e: null });
  assert.equal(bare.install, null);
});
