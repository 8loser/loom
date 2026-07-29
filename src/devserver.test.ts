import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { allocatePort, createDevServerTestRunner } from "./devserver.ts";
import type { LiveEvent } from "./claude.ts";

const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "devserver-test");
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

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await allocatePort(port, port);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
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
    () => createDevServerTestRunner().runIssueTests(ctxFor(gone, 4330)),
    /worktree does not exist/,
    "this is the difference between 'the project has no tests' and 'there is nothing here at all'",
  );
});

test("no package.json and no test script both report pass with output saying nothing ran, not a silent green", async () => {
  const runner = createDevServerTestRunner();

  const empty = mkdtempSync(join(scratchRoot, "bare-"));
  const noPkg = await runner.runIssueTests(ctxFor(empty, 4320));
  assert.equal(noPkg.pass, true, "a project loom can't introspect must not deadlock the pipeline");
  assert.match(noPkg.output, /no readable package\.json/, "but the reason is recorded, not silent");

  const noScript = await runner.runIssueTests(ctxFor(repoWith({ build: "true" }), 4321));
  assert.equal(noScript.pass, true);
  assert.match(noScript.output, /no typecheck\/test\/e2e script/);

  const noE2E = await runner.runSpecE2E(ctxFor(repoWith({ "loom:test": "true" }), 4322));
  assert.equal(noE2E.pass, true);
  assert.match(noE2E.output, /no e2e script/);
});

test("a passing loom:test runs for real and its stdout is captured", async () => {
  const dir = repoWith({ "loom:test": `node -e "console.log('42 tests passed')"` });
  const events: LiveEvent[] = [];
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4323, events));

  assert.equal(result.pass, true);
  assert.match(result.output, /42 tests passed/, "the project's own output is what lands in runs.summary");
  assert.deepEqual(
    events.map((e) => e.text),
    ["npm run loom:test"],
    "the command shows up on the board's live feed",
  );
});

test("a failing loom:test is a fail, and its output survives for the coder's next attempt", async () => {
  const dir = repoWith({ "loom:test": `node -e "console.error('expected 1 to be 2'); process.exit(1)"` });
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4324));

  assert.equal(result.pass, false, "non-zero exit is the whole point -- this is what the stub never did");
  assert.match(result.output, /expected 1 to be 2/);
});

test("loom:setup failing short-circuits before anything else runs", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "test-ran.txt");
  const dir = repoWith({
    "loom:setup": `node -e "process.exit(3)"`,
    "loom:test": `node -e "require('fs').writeFileSync('${marker}', 'x')"`,
  });
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4325));

  assert.equal(result.pass, false);
  assert.match(result.output, /setup failed/);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "a broken setup must not let tests run against a half-installed tree");
});

test("PORT is injected into the script's environment", async () => {
  const dir = repoWith({ "loom:test": `node -e "console.log('PORT=' + process.env.PORT)"` });
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4326));

  assert.equal(result.pass, true);
  assert.match(result.output, /PORT=4326/, "DESIGN.md: loom only guarantees PORT, the script decides what to do with it");
});

test("dev server is started, waited for, used, then killed -- and its port is reported to the board", async () => {
  // 這支 dev server 就是一個最小 http server，PORT 從環境變數拿 -- 跟真的
  // vite/next 對 loom 來說沒有差別，loom 只輪詢 http://127.0.0.1:$PORT/。
  const dir = repoWith({
    "loom:dev": `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`,
    "loom:test": `node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>r.text()).then(t=>{console.log('server said '+t)}).catch(e=>{console.error(e);process.exit(1)})"`,
  });
  const events: LiveEvent[] = [];
  const result = await createDevServerTestRunner({ healthTimeoutMs: 15_000 }).runIssueTests(ctxFor(dir, 4327, events));

  assert.equal(result.pass, true, "the test could only pass if the dev server was actually up");
  assert.match(result.output, /server said ok/);

  const portEvent = events.find((e) => e.kind === "port");
  assert.equal(portEvent?.text, "4327", "the board's 連線埠 field reads this event");

  // process group 真的被收掉：port 回到可綁定狀態。SIGTERM 送出到 process
  // 真的消失不是同步的，所以是輪詢等它放掉，不是送完就馬上斷言。
  assert.equal(await waitForPortFree(4327, 5000), true, "the dev server's whole process group must be dead, not orphaned holding the port");
});

test("a dev server that never answers fails the run instead of hanging forever", async () => {
  const dir = repoWith({
    "loom:dev": `node -e "setTimeout(()=>{}, 60000)"`, // 起得來但從不監聽
    "loom:test": `node -e "console.log('should never get here')"`,
  });
  const result = await createDevServerTestRunner({ healthTimeoutMs: 1500 }).runIssueTests(ctxFor(dir, 4328));

  assert.equal(result.pass, false);
  assert.match(result.output, /never answered/);
  assert.doesNotMatch(result.output, /should never get here/, "the test command must not run against a dead server");
});

test("a script that hangs is killed at the timeout rather than blocking the scheduler", async () => {
  const dir = repoWith({ "loom:test": `node -e "setTimeout(()=>{}, 60000)"` });
  const result = await createDevServerTestRunner({ scriptTimeoutMs: 1200 }).runIssueTests(ctxFor(dir, 4329));

  assert.equal(result.pass, false);
  assert.match(result.output, /timed out/);
});

// DESIGN.md「失敗與重試」的表格分兩類 infra：subprocess 非零退出是「原地
// 重跑」，超時與 setup 失敗是「直接 blocked」。orchestrator 靠 failure 欄位
// 分流，混在一起的話一次基礎設施故障會吃掉 coder 的三次改 code 機會，而且
// 第三次會觸發三階段清除把已完成的工作全部丟掉。
test("setup failure and timeouts are infra failures, a red test is a domain failure", async () => {
  const runner = createDevServerTestRunner({ scriptTimeoutMs: 1200, healthTimeoutMs: 1500 });

  const redTest = await runner.runIssueTests(
    ctxFor(repoWith({ "loom:test": `node -e "process.exit(1)"` }), 4331),
  );
  assert.equal(redTest.failure, "domain", "a genuinely failing test is the coder's problem");

  const badSetup = await runner.runIssueTests(
    ctxFor(repoWith({ "loom:setup": `node -e "process.exit(3)"`, "loom:test": "true" }), 4332),
  );
  assert.equal(badSetup.failure, "infra");

  const hung = await runner.runIssueTests(
    ctxFor(repoWith({ "loom:test": `node -e "setTimeout(()=>{}, 60000)"` }), 4333),
  );
  assert.equal(hung.failure, "infra", "the same workload will time out the same way, retrying is pointless");

  const deadServer = await runner.runIssueTests(
    ctxFor(repoWith({ "loom:dev": `node -e "setTimeout(()=>{}, 60000)"`, "loom:test": "true" }), 4334),
  );
  assert.equal(deadServer.failure, "infra");
});

test("typecheck runs before the dev server, and a type error fails without ever starting it", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "dev-started.txt");
  const dir = repoWith({
    "loom:typecheck": `node -e "process.exit(2)"`,
    "loom:dev": `node -e "require('fs').writeFileSync('${marker}', 'x'); setTimeout(()=>{}, 60000)"`,
    "loom:test": "true",
  });
  const result = await createDevServerTestRunner({ healthTimeoutMs: 1500 }).runIssueTests(ctxFor(dir, 4335));

  assert.equal(result.pass, false);
  assert.equal(result.failure, "domain", "a type error is the coder's problem, not infrastructure");
  assert.equal(existsSync(marker), false, "no point spending 30s starting a server for code that won't compile");
});

// runs.summary 存這份，coder 下一輪的 prompt 也帶這份（DESIGN.md「失敗時的
// 資訊傳遞」）。每個跑過的階段都要留下痕跡，否則紅在哪一階段看不出來。
test("output accumulates across every stage that ran, not just the last or the failing one", async () => {
  const dir = repoWith({
    "loom:typecheck": `node -e "console.log('TYPES OK')"`,
    "loom:test": `node -e "console.log('UNIT OK')"`,
    "loom:e2e": `node -e "console.log('E2E OK')"`,
  });
  const result = await createDevServerTestRunner().runIssueTests({ ...ctxFor(dir, 4344), e2e: true });

  assert.equal(result.pass, true);
  for (const stage of ["TYPES OK", "UNIT OK", "E2E OK"]) {
    assert.ok(result.output.includes(stage), `lost the ${stage} stage from the summary: ${JSON.stringify(result.output)}`);
  }
});

test("when a later stage fails, the earlier stages' output is still there to show what did pass", async () => {
  const dir = repoWith({
    "loom:typecheck": `node -e "console.log('TYPES OK')"`,
    "loom:test": `node -e "console.error('UNIT RED'); process.exit(1)"`,
  });
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4345));

  assert.equal(result.failure, "domain");
  assert.ok(result.output.includes("TYPES OK"), "the coder needs to see typecheck passed before the tests went red");
  assert.ok(result.output.includes("UNIT RED"));
});

test("typecheck falls back to the conventional script name and can be the only thing that runs", async () => {
  const dir = repoWith({ typecheck: `node -e "console.log('types ok')"` });
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4336));

  assert.equal(result.pass, true);
  assert.match(result.output, /typecheck only/);
});

// DESIGN.md「issue front matter 宣告 e2e: true 的：該 issue 也跑一次 e2e」。
test("an issue only runs e2e when its front matter asked for it", async () => {
  const marker = join(mkdtempSync(join(scratchRoot, "marker-")), "e2e-ran.txt");
  const scripts = {
    "loom:test": "true",
    "loom:e2e": `node -e "require('fs').writeFileSync('${marker}', 'x')"`,
  };

  await createDevServerTestRunner().runIssueTests(ctxFor(repoWith(scripts), 4337));
  assert.equal(existsSync(marker), false, "a plain issue must not pay for an e2e run");

  const withE2E = { ...ctxFor(repoWith(scripts), 4338), e2e: true };
  const result = await createDevServerTestRunner().runIssueTests(withE2E);
  assert.equal(result.pass, true);
  assert.equal(existsSync(marker), true, "an issue flagged e2e:true runs it");
});

// DESIGN.md「e2e 紅了先原地重跑一次，兩次都紅才算 domain fail。不這樣做的話
// 一次 flaky 就吃掉一格重試額度。unit test 不需要這層」。
test("a flaky e2e passes on its automatic second run; unit tests get no such retry", async () => {
  const counter = join(mkdtempSync(join(scratchRoot, "counter-")), "runs.txt");
  const countingScript = (failUntil: number) =>
    `node -e "const f=require('fs');const n=(f.existsSync('${counter}')?+f.readFileSync('${counter}','utf8'):0)+1;f.writeFileSync('${counter}',String(n));console.log('run '+n);process.exit(n<=${failUntil}?1:0)"`;

  const flaky = { ...ctxFor(repoWith({ "loom:e2e": countingScript(1) }), 4339), e2e: true };
  const result = await createDevServerTestRunner().runIssueTests(flaky);
  assert.equal(result.pass, true, "first run red, retry green, so it was flaky and must not cost a retry slot");
  assert.match(result.output, /treated as flaky/);

  // unit test 沒有這層：紅一次就是紅。
  let unitRuns = 0;
  const unitCounter = join(mkdtempSync(join(scratchRoot, "counter-")), "unit.txt");
  const unit = await createDevServerTestRunner().runIssueTests(
    ctxFor(
      repoWith({
        "loom:test": `node -e "const f=require('fs');const n=(f.existsSync('${unitCounter}')?+f.readFileSync('${unitCounter}','utf8'):0)+1;f.writeFileSync('${unitCounter}',String(n));process.exit(1)"`,
      }),
      4340,
    ),
  );
  unitRuns = Number(readFileSync(unitCounter, "utf8"));
  assert.equal(unit.pass, false);
  assert.equal(unitRuns, 1, "unit tests are deterministic, retrying them just hides a real failure");
});

test("with no loom:setup, the install command comes from whichever lockfile is present", async () => {
  const dir = repoWith({ "loom:test": "true" });
  writeFileSync(join(dir, "package-lock.json"), "{}");
  const events: LiveEvent[] = [];
  await createDevServerTestRunner({ scriptTimeoutMs: 60_000 }).runIssueTests(ctxFor(dir, 4341, events));

  assert.ok(
    events.some((e) => e.text === "npm ci"),
    `package-lock.json should select npm ci, got: ${JSON.stringify(events.map((e) => e.text))}`,
  );

  // 換一種 lockfile 就換一個指令，而且 loom:setup 存在時它優先。
  const pnpmDir = repoWith({ "loom:test": "true" });
  writeFileSync(join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n");
  const pnpmEvents: LiveEvent[] = [];
  await createDevServerTestRunner({ scriptTimeoutMs: 30_000 }).runIssueTests(ctxFor(pnpmDir, 4342, pnpmEvents));
  assert.ok(
    pnpmEvents.some((e) => e.text.startsWith("pnpm install")),
    `pnpm-lock.yaml should select pnpm install, got: ${JSON.stringify(pnpmEvents.map((e) => e.text))}`,
  );

  const explicitDir = repoWith({ "loom:setup": "true", "loom:test": "true" });
  writeFileSync(join(explicitDir, "package-lock.json"), "{}");
  const explicitEvents: LiveEvent[] = [];
  await createDevServerTestRunner().runIssueTests(ctxFor(explicitDir, 4343, explicitEvents));
  assert.ok(
    explicitEvents.some((e) => e.text === "npm run loom:setup") && !explicitEvents.some((e) => e.text === "npm ci"),
    "an explicit loom:setup wins over the lockfile guess",
  );
});
