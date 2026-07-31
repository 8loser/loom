import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  openDb,
  insertWorkspace,
  getIssueState,
  getVerifiedMainSha,
  setIssueBaseSha,
  startRun,
  getLatestRun,
  type Db,
  type Workspace,
} from "./db.ts";
import {
  writeIssueFrontMatter,
  writeSpecFrontMatter,
  readIssueFrontMatter,
  bodyOf,
} from "./frontmatter.ts";
import {
  runUntilIdle,
  stepSpec,
  verifySpec,
  attemptMerge,
  dropIssueAndDownstream,
  loadIssues,
  redoIssue,
  acknowledgeStale,
  getSpecBoardDetail,
  getWorkspaceSummary,
  createLiveOutputStore,
  createSpecFromDraft,
  SPECS_DIR,
  type Ctx,
  type AgentRunner,
  type AgentRequest,
  type AgentResponse,
  type TestRunner,
} from "./orchestrator.ts";
import type { LiveEvent } from "./claude.ts";
import type { SpecDraft } from "./chat.ts";

const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "orchestrator-test");
mkdirSync(scratchRoot, { recursive: true });

function sh(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

const USAGE = {
  durationMs: 100,
  inputTokens: 10,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 5,
  costUsd: 0.001,
};

/** 建一個 repo，裡面有一個 spec 跟指定的 issue 清單（front matter 直接寫好）。 */
function initWorkspaceRepo(
  spec: string,
  issues: { id: string; blockedBy?: string[] }[],
): { repoPath: string; workspace: Workspace; db: Db } {
  const repoPath = mkdtempSync(join(scratchRoot, "repo-"));
  sh(repoPath, "git", ["init", "-q", "-b", "main"]);
  sh(repoPath, "git", ["config", "user.email", "t@t"]);
  sh(repoPath, "git", ["config", "user.name", "t"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");

  const specDir = join(repoPath, SPECS_DIR, spec);
  const issuesDir = join(specDir, "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    join(specDir, "spec.md"),
    writeSpecFrontMatter(`# ${spec}\n\nproblem statement etc.\n`, {
      merged: false,
      blockedReason: null,
    }),
  );
  for (const issue of issues) {
    writeFileSync(
      join(issuesDir, `${issue.id}-issue.md`),
      writeIssueFrontMatter(`# ${issue.id} issue\n\nwhat to build.\n`, {
        status: "ready",
        e2e: false,
        blockedBy: issue.blockedBy ?? [],
      }),
    );
  }

  sh(repoPath, "git", ["add", "-A"]);
  sh(repoPath, "git", ["commit", "-q", "-m", "init"]);

  const name = "w-" + Math.random().toString(36).slice(2);
  const db = openDb(":memory:");
  const id = insertWorkspace(db, {
    name,
    repoPath,
    mainBranch: "main",
    portRangeStart: 4300,
    portRangeEnd: 4399,
    parallelLimit: 2,
  });
  const workspace: Workspace = {
    id,
    name,
    repoPath,
    mainBranch: "main",
    portRangeStart: 4300,
    portRangeEnd: 4399,
    parallelLimit: 2,
  };
  return { repoPath, workspace, db };
}

function wtPathFor(workspace: Workspace, spec: string): string {
  return join(workspace.repoPath, ".loom", "worktrees", spec);
}

interface StubOptions {
  /** issue id -> array of verdicts to return in order, cycling the last one after exhausted */
  reviewVerdicts?: Record<string, ("pass" | "reject")[]>;
  coderInfraFailTimes?: number;
  coderUsageExhausted?: boolean;
}

function makeStubAgent(opts: StubOptions = {}): { agent: AgentRunner; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const reviewCallCount: Record<string, number> = {};
  let coderInfraFailsLeft = opts.coderInfraFailTimes ?? 0;

  const agent: AgentRunner = async (req) => {
    calls.push(req);

    if (req.role === "coder") {
      if (opts.coderUsageExhausted) {
        const resp: AgentResponse = { outcome: "usage_exhausted" };
        return resp;
      }
      if (coderInfraFailsLeft > 0) {
        coderInfraFailsLeft--;
        const resp: AgentResponse = { outcome: "infra_fail", usage: USAGE };
        return resp;
      }
      writeFileSync(join(req.worktreePath, `attempt-${req.attempt}.txt`), "work\n");
      const resp: AgentResponse = {
        outcome: "ok",
        usage: USAGE,
        coder: { done: true, summary: `did attempt ${req.attempt}`, filesChanged: [`attempt-${req.attempt}.txt`] },
      };
      return resp;
    }

    if (req.role === "issue_reviewer") {
      const key = req.issue ?? "";
      const seq = opts.reviewVerdicts?.[key] ?? ["pass"];
      const i = reviewCallCount[key] ?? 0;
      reviewCallCount[key] = i + 1;
      const verdict = seq[Math.min(i, seq.length - 1)];
      const resp: AgentResponse = {
        outcome: "ok",
        usage: USAGE,
        issueReview: { verdict, comments: verdict === "reject" ? ["fix the thing"] : [] },
      };
      return resp;
    }

    // spec_reviewer
    const resp: AgentResponse = {
      outcome: "ok",
      usage: USAGE,
      specReview: { comments: ["consider deduping X"] },
    };
    return resp;
  };

  return { agent, calls };
}

function makeStubTest(
  opts: { issuePass?: boolean; e2ePass?: boolean; issueFailure?: "domain" | "infra" } = {},
): TestRunner {
  return {
    async runIssueTests() {
      const pass = opts.issuePass ?? true;
      return { pass, output: "unit tests output", failure: pass ? undefined : opts.issueFailure ?? "domain" };
    },
    async runSpecE2E() {
      const pass = opts.e2ePass ?? true;
      return { pass, output: "e2e output", failure: pass ? undefined : "domain" };
    },
  };
}

test("happy path: single issue goes ready -> done, main gets exactly one state commit", async () => {
  const { repoPath, workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  const beforeLog = execFileSync("git", ["log", "--oneline"], { cwd: repoPath, encoding: "utf8" });
  await runUntilIdle(ctx, "demo");
  const afterLog = execFileSync("git", ["log", "--oneline"], { cwd: repoPath, encoding: "utf8" });

  const issues = loadIssues(ctx, "demo");
  assert.equal(issues[0].status, "done");

  const beforeCount = beforeLog.trim().split("\n").length;
  const afterCount = afterLog.trim().split("\n").length;
  assert.equal(afterCount - beforeCount, 1, "only the done transition should commit to main");

  const state = getIssueState(db, workspace.id, "demo", "01");
  assert.equal(state.baseSha, null, "issue_state must be cleared once terminal");

  const runs = db.prepare("SELECT role, outcome FROM runs ORDER BY id").all() as {
    role: string;
    outcome: string;
  }[];
  assert.deepEqual(
    runs.map((r) => `${r.role}:${r.outcome}`),
    ["coder:ok", "issue_reviewer:ok", "test:ok"],
  );
});

// DESIGN.md「失敗與重試」：「infra｜超時、setup 失敗｜直接 blocked」。混成
// domain fail 的話，一次基礎設施故障會吃掉 coder 改 code 的三次機會，而且
// 第三次會觸發 threeStageClean 把已經寫好的東西整個清掉重來。
test("a test-stage infra failure blocks immediately without burning a domain retry", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = {
    db,
    workspace,
    agent,
    test: makeStubTest({ issuePass: false, issueFailure: "infra" }),
  };

  await runUntilIdle(ctx, "demo");

  assert.equal(loadIssues(ctx, "demo")[0].status, "blocked");
  const state = getIssueState(db, workspace.id, "demo", "01");
  assert.equal(state.domainRetries, 0, "an infra failure must not cost the coder a chance to fix real code");

  const testRuns = (db.prepare("SELECT outcome FROM runs WHERE role = 'test'").all() as { outcome: string }[]).map(
    (r) => r.outcome,
  );
  assert.deepEqual(testRuns, ["infra_fail"], "recorded as infra, and tried exactly once");
});

test("a genuinely red test is a domain failure and does go back to the coder", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest({ issuePass: false }) };

  await runUntilIdle(ctx, "demo");

  assert.equal(loadIssues(ctx, "demo")[0].status, "blocked", "after exhausting the domain retries");
  const testRuns = (db.prepare("SELECT outcome FROM runs WHERE role = 'test'").all() as { outcome: string }[]).map(
    (r) => r.outcome,
  );
  assert.deepEqual(testRuns, ["domain_fail", "domain_fail", "domain_fail"], "three chances, unlike the infra path");
});

test("an issue flagged e2e:true asks the test runner for an e2e run", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const issuePath = join(workspace.repoPath, SPECS_DIR, "demo", "issues", "01-issue.md");
  writeFileSync(
    issuePath,
    writeIssueFrontMatter(readFileSync(issuePath, "utf8"), { status: "ready", e2e: true, blockedBy: [] }),
  );
  sh(workspace.repoPath, "git", ["commit", "-qam", "flag e2e"]);

  const seen: (boolean | undefined)[] = [];
  const ctx: Ctx = {
    db,
    workspace,
    agent: makeStubAgent().agent,
    test: {
      async runIssueTests(runCtx) {
        seen.push(runCtx.e2e);
        return { pass: true, output: "" };
      },
      async runSpecE2E() {
        return { pass: true, output: "" };
      },
    },
  };

  await runUntilIdle(ctx, "demo");
  assert.deepEqual(seen, [true], "the front matter flag has to reach the runner, or the e2e follow-up loop never converges");
});

test("domain fail retries twice in place, resets on third attempt, then passes", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent({ reviewVerdicts: { "01": ["reject", "reject", "pass"] } });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");

  const issues = loadIssues(ctx, "demo");
  assert.equal(issues[0].status, "done");

  const wt = wtPathFor(workspace, "demo");
  assert.equal(existsSync(join(wt, "attempt-1.txt")), false, "attempt 1 must be wiped by the reset");
  assert.equal(existsSync(join(wt, "attempt-2.txt")), false, "attempt 2 must be wiped by the reset");
  assert.equal(existsSync(join(wt, "attempt-3.txt")), true, "attempt 3 is what actually landed");

  const coderRuns = db
    .prepare("SELECT attempt, outcome FROM runs WHERE role = 'coder' ORDER BY id")
    .all() as { attempt: number; outcome: string }[];
  assert.deepEqual(
    coderRuns.map((r) => r.attempt),
    [1, 2, 3],
  );
});

test("domain fail exhausts all attempts and lands in blocked", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent({ reviewVerdicts: { "01": ["reject", "reject", "reject"] } });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");

  const issues = loadIssues(ctx, "demo");
  assert.equal(issues[0].status, "blocked");
});

test("infra fail retries in place then escalates to blocked without touching domain retries", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent({ coderInfraFailTimes: 3 });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");

  const issues = loadIssues(ctx, "demo");
  assert.equal(issues[0].status, "blocked");

  const state = getIssueState(db, workspace.id, "demo", "01");
  assert.equal(state.domainRetries, 0, "infra failures must not consume the domain retry budget");
});

test("usage_exhausted pauses the run loop without touching retries or issue status", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent, calls } = makeStubAgent({ coderUsageExhausted: true });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  const results = await runUntilIdle(ctx, "demo");

  assert.equal(results.length, 1, "must stop after the first paused step, not keep spinning");
  assert.equal(results[0].paused, true);

  const issues = loadIssues(ctx, "demo");
  assert.equal(issues[0].status, "implementing", "must stay claimed, not bounced to blocked");

  const state = getIssueState(db, workspace.id, "demo", "01");
  assert.equal(state.domainRetries, 0);
  assert.equal(state.infraRetries, 0, "usage exhaustion is not an infra failure, must not spend that budget either");

  const runs = db.prepare("SELECT outcome FROM runs").all() as { outcome: string }[];
  assert.deepEqual(runs.map((r) => r.outcome), ["usage_paused"]);

  // calling again immediately (simulating a naive retry before the window resets)
  // must produce the exact same paused result, not escalate anything.
  const again = await stepSpec(ctx, "demo");
  assert.equal(again?.paused, true);
  assert.equal(calls.filter((c) => c.role === "coder").length, 2);
});

test("verifySpec: spec_reviewer usage_exhausted reports paused without recording a verified checkpoint", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const baseAgent = makeStubAgent().agent;
  const agent: AgentRunner = async (req) => {
    if (req.role === "spec_reviewer") return { outcome: "usage_exhausted" };
    return baseAgent(req);
  };
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest({ e2ePass: true }) };

  await runUntilIdle(ctx, "demo");
  const result = await verifySpec(ctx, "demo");

  assert.equal(result.e2ePass, true, "e2e genuinely passed, that part of the result is real");
  assert.equal(result.paused, true);
  assert.deepEqual(result.comments, []);

  assert.equal(
    getVerifiedMainSha(db, workspace.id, "demo"),
    null,
    "must not record a checkpoint for a verification that didn't actually complete",
  );
});

test("stepSpec continues an already-active issue instead of freezing on repeated infra retries", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent, calls } = makeStubAgent({ coderInfraFailTimes: 2 });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await stepSpec(ctx, "demo"); // claims + 1st infra fail
  await stepSpec(ctx, "demo"); // 2nd infra fail (retry in place)
  await stepSpec(ctx, "demo"); // succeeds

  const coderCalls = calls.filter((c) => c.role === "coder");
  assert.equal(coderCalls.length, 3, "must retry the same issue, not go idle after the first failure");

  const issues = loadIssues(ctx, "demo");
  assert.equal(issues[0].status, "review_ready");
});

test("blocked-by: an independent issue keeps running while another is blocked", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [
    { id: "01" },
    { id: "02", blockedBy: ["01"] },
    { id: "03" }, // independent
  ]);
  const { agent } = makeStubAgent({ reviewVerdicts: { "01": ["reject", "reject", "reject"] } });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");

  const issues = loadIssues(ctx, "demo");
  const byId = Object.fromEntries(issues.map((i) => [i.id, i.status]));
  assert.equal(byId["01"], "blocked");
  assert.equal(byId["02"], "ready", "02 depends on the blocked issue, must stay put");
  assert.equal(byId["03"], "done", "03 is independent, must proceed despite 01 being blocked");
});

test("dropIssueAndDownstream drops a blocked issue and everything depending on it", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [
    { id: "01" },
    { id: "02", blockedBy: ["01"] },
    { id: "03", blockedBy: ["02"] },
    { id: "04" },
  ]);
  const { agent } = makeStubAgent({ reviewVerdicts: { "01": ["reject", "reject", "reject"] } });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");
  let issues = loadIssues(ctx, "demo");
  assert.equal(issues.find((i) => i.id === "01")!.status, "blocked");

  dropIssueAndDownstream(ctx, "demo", "01");
  issues = loadIssues(ctx, "demo");
  const byId = Object.fromEntries(issues.map((i) => [i.id, i.status]));
  assert.equal(byId["01"], "dropped");
  assert.equal(byId["02"], "dropped", "direct dependent must be dropped too");
  assert.equal(byId["03"], "dropped", "transitive dependent must be dropped too");
  assert.equal(byId["04"], "done", "unrelated issue must be untouched");
});

test("verifySpec: e2e failure creates a followup issue flagged e2e:true", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest({ e2ePass: false }) };

  await runUntilIdle(ctx, "demo");
  const result = await verifySpec(ctx, "demo");
  assert.equal(result.e2ePass, false);

  const issues = loadIssues(ctx, "demo");
  const followup = issues.find((i) => i.id !== "01")!;
  assert.ok(followup, "a followup issue must have been created");
  assert.equal(followup.e2e, true, "followup issue must force e2e verification");
  assert.equal(followup.title, "e2e-followup-1");
});

test("verifySpec: e2e pass returns spec review comments without creating any issue", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest({ e2ePass: true }) };

  await runUntilIdle(ctx, "demo");
  const before = loadIssues(ctx, "demo").length;
  const result = await verifySpec(ctx, "demo");
  const after = loadIssues(ctx, "demo").length;

  assert.equal(result.e2ePass, true);
  assert.deepEqual(result.comments, ["consider deduping X"]);
  assert.equal(after, before, "spec review must not create issues on its own");
});

// spec review 找的是「不同 issue 各自引入了重複的抽象」「issue 03 建的東西被
// issue 06 淘汰但沒刪」，那些只有攤開全貌才看得見。所以整份送，但 lockfile
// 那類產生檔不送 -- 它們對這個判斷零價值卻能佔掉九成篇幅。
test("spec review gets the whole branch diff, minus generated files", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const seen: (string | undefined)[] = [];
  const agent: AgentRunner = async (req) => {
    if (req.role === "coder") {
      writeFileSync(join(req.worktreePath, "real.ts"), "export const x = 1;\n");
      writeFileSync(join(req.worktreePath, "package-lock.json"), '{"lockfileVersion":3}\n');
      return {
        outcome: "ok",
        usage: USAGE,
        coder: { done: true, summary: "did it", filesChanged: ["real.ts", "package-lock.json"] },
      };
    }
    if (req.role === "issue_reviewer") {
      return { outcome: "ok", usage: USAGE, issueReview: { verdict: "pass", comments: [] } };
    }
    seen.push(req.diff);
    return { outcome: "ok", usage: USAGE, specReview: { comments: [] } };
  };

  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };
  await runUntilIdle(ctx, "demo");
  await verifySpec(ctx, "demo");

  assert.equal(seen.length, 1, "spec_reviewer must have been called");
  const diff = seen[0] ?? "";
  assert.match(diff, /export const x = 1/, "the reviewer cannot run git itself -- it only has Read/Glob/Grep");
  assert.doesNotMatch(diff, /lockfileVersion/, "generated files would drown the real change");
});

test("attemptMerge: happy path merges into main and cleans up the worktree", async () => {
  const { repoPath, workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");
  await verifySpec(ctx, "demo");

  const result = attemptMerge(ctx, "demo");
  assert.deepEqual(result, { merged: true });

  assert.ok(existsSync(join(repoPath, "attempt-1.txt")), "merged code must land on main");

  const wt = wtPathFor(workspace, "demo");
  assert.equal(existsSync(wt), false, "worktree must be removed after merge");

  const branches = execFileSync("git", ["branch", "--list", "spec/demo"], {
    cwd: repoPath,
    encoding: "utf8",
  }).trim();
  assert.equal(branches, "", "spec branch must be removed after merge");
});

test("attemptMerge: specs-only commits on main do not block merge, real code commits do", async () => {
  const { repoPath, workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo"); // this itself produces a specs-only state commit on main
  await verifySpec(ctx, "demo");

  writeFileSync(join(repoPath, "unrelated.ts"), "someone else shipped\n");
  sh(repoPath, "git", ["add", "-A"]);
  sh(repoPath, "git", ["commit", "-q", "-m", "real code landed on main meanwhile"]);

  const result = attemptMerge(ctx, "demo");
  assert.deepEqual(result, { merged: false, reason: "needs_reverify" });

  // re-verifying against the now-current main updates the checkpoint, after
  // which the merge should go through.
  await verifySpec(ctx, "demo");
  const retry = attemptMerge(ctx, "demo");
  assert.deepEqual(retry, { merged: true });
});

test("staleness: editing spec.md body after an issue is done marks it stale", async () => {
  const { repoPath, workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");
  assert.equal(loadIssues(ctx, "demo")[0].status, "done");
  assert.equal(loadIssues(ctx, "demo")[0].stale, false, "nothing changed yet");

  const specFile = join(repoPath, SPECS_DIR, "demo", "spec.md");
  writeFileSync(specFile, readFileSync(specFile, "utf8") + "\n## Testing Decisions\n\nnew constraint.\n");
  assert.equal(loadIssues(ctx, "demo")[0].stale, true, "spec body changed after done");
});

test("staleness: editing the issue's own body also marks it stale", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");
  const issue = loadIssues(ctx, "demo")[0];
  writeFileSync(issue.path, readFileSync(issue.path, "utf8") + "\nalso do this other thing.\n");
  assert.equal(loadIssues(ctx, "demo")[0].stale, true);
});

test("staleness: orchestrator's own front matter writes never mark anything stale", async () => {
  // 這是 hash body 不 hash 整檔的理由：merged: true 是 orchestrator 自己
  // 在 merge 時寫進 spec.md front matter 的，不能讓它把所有 issue 打成過期。
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }, { id: "02" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");
  await verifySpec(ctx, "demo");
  assert.deepEqual(attemptMerge(ctx, "demo"), { merged: true });
  assert.deepEqual(
    loadIssues(ctx, "demo").map((i) => i.stale),
    [false, false],
  );
});

test("staleness: only done issues can be stale, and redo/acknowledge both clear the badge", async () => {
  const { repoPath, workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }, { id: "02" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };

  // 只推進 01，02 還停在 ready。
  await stepSpec(ctx, "demo");
  await stepSpec(ctx, "demo");
  await stepSpec(ctx, "demo");

  const specFile = join(repoPath, SPECS_DIR, "demo", "spec.md");
  writeFileSync(specFile, readFileSync(specFile, "utf8") + "\nchanged mid-flight.\n");

  const after = loadIssues(ctx, "demo");
  assert.equal(after[0].status, "done");
  assert.equal(after[0].stale, true);
  assert.equal(after[1].stale, false, "02 never ran, it will just read the new spec");

  acknowledgeStale(ctx, "demo", "01");
  assert.equal(loadIssues(ctx, "demo")[0].stale, false);

  writeFileSync(specFile, readFileSync(specFile, "utf8") + "\nchanged again.\n");
  assert.equal(loadIssues(ctx, "demo")[0].stale, true);

  redoIssue(ctx, "demo", "01");
  const redone = loadIssues(ctx, "demo")[0];
  assert.equal(redone.status, "ready");
  assert.equal(redone.stale, false);
  assert.equal(getIssueState(db, workspace.id, "demo", "01").baseSha, null, "next round starts fresh");

  // 重跑後指紋對上新內容，不會又立刻變回過期。
  await runUntilIdle(ctx, "demo");
  assert.deepEqual(
    loadIssues(ctx, "demo").map((i) => [i.status, i.stale]),
    [["done", false], ["done", false]],
  );
});

test("getSpecBoardDetail: mergeable spec reports real cost/token totals, elapsed, 0 behind main, and review comments", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest({ e2ePass: true }) };

  await runUntilIdle(ctx, "demo");
  await verifySpec(ctx, "demo");

  const detail = getSpecBoardDetail(ctx, "demo");
  assert.equal(detail.branch, "spec/demo");
  assert.equal(detail.status, "mergeable");
  assert.ok(detail.costUsd > 0, "coder + reviewer + spec_reviewer runs must all have recorded cost");
  assert.ok(detail.inputTokens > 0);
  assert.ok(detail.elapsedMs !== null && detail.elapsedMs >= 0);
  assert.equal(detail.behindMain, 0, "spec branch was just rebased onto the tip it's being compared against");
  assert.deepEqual(detail.specReviewComments, ["consider deduping X"]);
  assert.equal(detail.currentIssue, null, "nothing is mid-state once the spec is mergeable");
});

test("getSpecBoardDetail: currentIssue reports the in-flight run's role and attempt for a mid-state issue", () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const live = createLiveOutputStore();
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest(), live };

  // 手動把 issue 推到 implementing、開一筆未結束的 run -- 只驗證讀模型，
  // 不需要真的跑一次 coder 或等它完成。
  const issuePath = join(ctx.workspace.repoPath, SPECS_DIR, "demo", "issues", "01-issue.md");
  writeFileSync(
    issuePath,
    writeIssueFrontMatter(readFileSync(issuePath, "utf8"), { status: "implementing", e2e: false, blockedBy: [] }),
  );
  setIssueBaseSha(db, workspace.id, "demo", "01", "deadbeef");
  const runId = startRun(db, {
    workspaceId: workspace.id,
    spec: "demo",
    issue: "01",
    role: "coder",
    attempt: 1,
    baseSha: "deadbeef",
  });
  live.append(runId, { at: 1000, kind: "say", text: "reading spec" });
  live.append(runId, { at: 1001, kind: "read", text: "spec.md" });

  const detail = getSpecBoardDetail(ctx, "demo");
  assert.equal(detail.currentIssue?.id, "01");
  assert.equal(detail.currentIssue?.role, "coder");
  assert.equal(detail.currentIssue?.attempt, 1);
  assert.equal(detail.currentIssue?.diffStat, null, "coder role doesn't get a diff stat, only issue_reviewer does");
  assert.equal(detail.behindMain, null, "spec branch was never created, there's nothing to compare");
  assert.deepEqual(
    detail.currentIssue?.liveEvents.map((e) => e.text),
    ["reading spec", "spec.md"],
    "liveEvents is read from ctx.live keyed by this run's id",
  );
});

test("getSpecBoardDetail: currentIssue.liveEvents is empty when ctx.live isn't wired up (tests/stub runners don't need it)", () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };

  const issuePath = join(ctx.workspace.repoPath, SPECS_DIR, "demo", "issues", "01-issue.md");
  writeFileSync(
    issuePath,
    writeIssueFrontMatter(readFileSync(issuePath, "utf8"), { status: "implementing", e2e: false, blockedBy: [] }),
  );
  startRun(db, { workspaceId: workspace.id, spec: "demo", issue: "01", role: "coder", attempt: 1, baseSha: null });

  const detail = getSpecBoardDetail(ctx, "demo");
  assert.deepEqual(detail.currentIssue?.liveEvents, []);
});

test("createLiveOutputStore: append/get/clear are keyed by run id, onAppend fires per event", () => {
  const appended: number[] = [];
  const live = createLiveOutputStore((runId) => appended.push(runId));

  assert.deepEqual(live.get(1), [], "nothing appended yet");

  const e1: LiveEvent = { at: 1, kind: "say", text: "a" };
  const e2: LiveEvent = { at: 2, kind: "bash", text: "pnpm test" };
  const e3: LiveEvent = { at: 3, kind: "read", text: "other run" };
  live.append(1, e1);
  live.append(1, e2);
  live.append(2, e3);

  assert.deepEqual(live.get(1), [e1, e2], "events accumulate in order, scoped to their run id");
  assert.deepEqual(live.get(2), [e3]);
  assert.deepEqual(appended, [1, 1, 2], "onAppend fires once per append, with that event's run id");

  live.clear(1);
  assert.deepEqual(live.get(1), [], "cleared run reads back empty");
  assert.deepEqual(live.get(2), [e3], "clearing one run id doesn't touch another");
});

test("live output: onEvent passed to the coder agent lands in ctx.live while the run is in flight, then gets cleared once it settles", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const live = createLiveOutputStore();
  let snapshotDuringRun: LiveEvent[] = [];
  let runIdDuringRun: number | null = null;

  const agent: AgentRunner = async (req) => {
    if (req.role === "coder") {
      assert.ok(req.onEvent, "ctx.live being set means the request carries a live onEvent callback");
      req.onEvent!({ at: 1, kind: "say", text: "reading spec" });
      req.onEvent!({ at: 2, kind: "read", text: "spec.md" });
      runIdDuringRun = getLatestRun(db, workspace.id, "demo", "01")!.id;
      // 快照當下的陣列參照：doImplement 在 agent() resolve 後會 clear()，
      // 但 clear 只是把 map 裡的 entry 刪掉，不會清空這個已經拿到手的陣列 --
      // 用它來斷言「run 還在跑的當下，事件真的進了 store」。
      snapshotDuringRun = live.get(runIdDuringRun);
      writeFileSync(join(req.worktreePath, "output.txt"), "done\n");
      return { outcome: "ok", usage: USAGE, coder: { done: true, summary: "did it", filesChanged: ["output.txt"] } };
    }
    if (req.role === "issue_reviewer") {
      return { outcome: "ok", usage: USAGE, issueReview: { verdict: "pass", comments: [] } };
    }
    return { outcome: "ok", usage: USAGE, specReview: { comments: [] } };
  };

  const ctx: Ctx = { db, workspace, agent, test: makeStubTest(), live };
  await runUntilIdle(ctx, "demo");

  assert.ok(runIdDuringRun !== null, "the coder branch above must have run");
  assert.ok(snapshotDuringRun.length > 0, "onEvent must have fired inside the coder branch above");
  assert.deepEqual(
    snapshotDuringRun.map((e) => e.text),
    ["reading spec", "spec.md"],
    "events appended via onEvent were visible in ctx.live mid-run",
  );
  assert.deepEqual(live.get(runIdDuringRun!), [], "cleared once ctx.agent() resolved, so it doesn't leak into later reads");
});

test("getSpecBoardDetail: issueFailures surfaces the last review rejection reason per issue", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent({ reviewVerdicts: { "01": ["reject", "pass"] } });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");

  const detail = getSpecBoardDetail(ctx, "demo");
  assert.equal(detail.issueFailures["01"], "fix the thing");
});

test("getSpecBoardDetail: issueRetries tracks the exhausted attempt count on a blocked issue, exposes the shared max", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent({ reviewVerdicts: { "01": ["reject", "reject", "reject"] } });
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  await runUntilIdle(ctx, "demo");

  const detail = getSpecBoardDetail(ctx, "demo");
  assert.equal(detail.issues[0].status, "blocked");
  assert.deepEqual(detail.issueRetries["01"], { domain: 3, infra: 0 });
  assert.equal(detail.domainMaxAttempts, 3);
  assert.equal(detail.infraMaxAttempts, 3);
});

test("getWorkspaceSummary: recentCostUsd sums today's runs, runningCount reflects specs with a mid-state issue", async () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const { agent } = makeStubAgent();
  const ctx: Ctx = { db, workspace, agent, test: makeStubTest() };

  const idle = getWorkspaceSummary(ctx);
  assert.equal(idle.recentCostUsd, 0);
  assert.equal(idle.runningCount, 0);

  await stepSpec(ctx, "demo"); // ready -> implementing, one coder run recorded

  const running = getWorkspaceSummary(ctx);
  assert.ok(running.recentCostUsd > 0);
  assert.equal(running.runningCount, 1);
});

test("createSpecFromDraft: writes spec.md + numbered issues, resolves blocked_by from title to id, commits once, and records the chat session", () => {
  const { workspace, db } = initWorkspaceRepo("existing-spec", [{ id: "01" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };

  const draft: SpecDraft = {
    slug: "week-strip-ipad-portrait",
    specMd: "# week-strip-ipad-portrait\n\nproblem statement.\n",
    issues: [
      { title: "extract-timeline-range-hook", body: "do the extraction.", blockedBy: [], e2e: false, needsHuman: false },
      {
        title: "fluid-week-strip-columns",
        body: "use flexible columns.",
        blockedBy: ["extract-timeline-range-hook"],
        e2e: false,
        needsHuman: false,
      },
      {
        title: "confirm-ipad-breakpoints-with-clinic",
        body: "needs a human call.",
        blockedBy: [],
        e2e: false,
        needsHuman: true,
      },
    ],
  };

  const slug = createSpecFromDraft(ctx, draft, "session-abc");
  assert.equal(slug, "week-strip-ipad-portrait");

  const issues = loadIssues(ctx, slug);
  assert.deepEqual(issues.map((i) => i.id), ["01", "02", "03"]);
  assert.equal(issues[0].status, "ready");
  assert.deepEqual(issues[1].blockedBy, ["01"]);
  assert.equal(issues[2].status, "human");

  // 一次落地只該有一個 commit（spec.md + 三個 issue 檔一起進去）。
  const log = execFileSync("git", ["log", "--oneline", "-n", "2"], { cwd: workspace.repoPath }).toString();
  assert.match(log.split("\n")[0], /week-strip-ipad-portrait created from chat/);

  const row = db
    .prepare("SELECT chat_session_id FROM spec_state WHERE workspace_id = ? AND spec = ?")
    .get(workspace.id, slug) as { chat_session_id: string } | undefined;
  assert.equal(row?.chat_session_id, "session-abc");
});

test("createSpecFromDraft: refuses to overwrite a spec that already exists", () => {
  const { workspace, db } = initWorkspaceRepo("existing-spec", [{ id: "01" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };
  const draft: SpecDraft = {
    slug: "existing-spec",
    specMd: "# existing-spec\n",
    issues: [{ title: "a", body: "b", blockedBy: [], e2e: false, needsHuman: false }],
  };
  assert.throws(() => createSpecFromDraft(ctx, draft, "session-abc"), /already exists/);
});

test("手寫的 issue 檔沒有 front matter：loadIssues 就地補成 draft，body 原封不動", () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };
  const path = join(workspace.repoPath, SPECS_DIR, "demo", "issues", "02-handwritten.md");
  // 刻意帶著別的工具的詞彙：loom 不解讀 body，這兩行只是文字。
  const body = "# 02 handwritten\n\n**Status:** ready-for-agent\n**Blocked by:** 01\n";
  writeFileSync(path, body);

  const added = loadIssues(ctx, "demo").find((i) => i.id === "02")!;
  assert.equal(added.status, "draft", "落點是 draft，不放行就不會被派工");
  assert.deepEqual(added.blockedBy, [], "body 的 Blocked by 不解析，要依賴就自己寫 front matter");
  assert.equal(added.e2e, false);

  const after = readFileSync(path, "utf8");
  assert.equal(readIssueFrontMatter(after)?.status, "draft", "補寫要落到檔案上，不只在記憶體裡");
  assert.equal(bodyOf(after), body);
});

test("spec 有 spec.md 但還沒有 issues/：算 0 個 issue，不是錯誤", () => {
  const { workspace, db } = initWorkspaceRepo("demo", [{ id: "01" }]);
  const ctx: Ctx = { db, workspace, agent: makeStubAgent().agent, test: makeStubTest() };
  mkdirSync(join(workspace.repoPath, SPECS_DIR, "skeleton"), { recursive: true });
  writeFileSync(
    join(workspace.repoPath, SPECS_DIR, "skeleton", "spec.md"),
    writeSpecFrontMatter("# skeleton\n", { merged: false, blockedReason: null }),
  );
  assert.deepEqual(loadIssues(ctx, "skeleton"), []);
});
