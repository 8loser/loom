import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  assert.match(noScript.output, /no test script/);

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
    "loom:test": `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`,
  });
  const result = await createDevServerTestRunner().runIssueTests(ctxFor(dir, 4325));

  assert.equal(result.pass, false);
  assert.match(result.output, /loom:setup failed/);
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
