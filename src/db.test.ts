import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDb,
  insertWorkspace,
  getWorkspace,
  startRun,
  finishRun,
  getIssueState,
  setIssueBaseSha,
  bumpRetry,
  clearIssueState,
  getSpecRunAggregate,
  getTodayRunAggregate,
  getLatestRun,
  getSpecReviewComments,
} from "./db.ts";

test("workspace round-trip", () => {
  const db = openDb(":memory:");
  const id = insertWorkspace(db, {
    name: "clinic-web",
    repoPath: "/tmp/clinic-web",
    specsDir: "specs",
    mainBranch: "main",
    portRangeStart: 4300,
    portRangeEnd: 4399,
    parallelLimit: 2,
  });
  const ws = getWorkspace(db, "clinic-web");
  assert.equal(ws?.id, id);
  assert.equal(ws?.repoPath, "/tmp/clinic-web");
  db.close();
});

test("run lifecycle records usage", () => {
  const db = openDb(":memory:");
  const wsId = insertWorkspace(db, {
    name: "w",
    repoPath: "/tmp/w",
    specsDir: "specs",
    mainBranch: "main",
    portRangeStart: 4300,
    portRangeEnd: 4399,
    parallelLimit: 2,
  });
  const runId = startRun(db, {
    workspaceId: wsId,
    spec: "mobile-slot-settings",
    issue: "04",
    role: "coder",
    attempt: 1,
    baseSha: "abc123",
  });
  finishRun(db, runId, {
    outcome: "ok",
    usage: {
      durationMs: 1000,
      inputTokens: 2,
      cacheReadTokens: 9985,
      cacheCreationTokens: 0,
      outputTokens: 4,
      costUsd: 0.005,
    },
    summary: "did the thing",
  });
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<
    string,
    unknown
  >;
  assert.equal(row.outcome, "ok");
  assert.equal(row.cache_read_tokens, 9985);
  db.close();
});

test("issue_state tracks base_sha and independent retry counters", () => {
  const db = openDb(":memory:");
  const wsId = insertWorkspace(db, {
    name: "w",
    repoPath: "/tmp/w",
    specsDir: "specs",
    mainBranch: "main",
    portRangeStart: 4300,
    portRangeEnd: 4399,
    parallelLimit: 2,
  });

  setIssueBaseSha(db, wsId, "spec-a", "04", "sha1");
  assert.equal(getIssueState(db, wsId, "spec-a", "04").baseSha, "sha1");

  assert.equal(bumpRetry(db, wsId, "spec-a", "04", "domain"), 1);
  assert.equal(bumpRetry(db, wsId, "spec-a", "04", "domain"), 2);
  assert.equal(bumpRetry(db, wsId, "spec-a", "04", "infra"), 1);

  const state = getIssueState(db, wsId, "spec-a", "04");
  assert.equal(state.domainRetries, 2);
  assert.equal(state.infraRetries, 1);
  assert.equal(state.baseSha, "sha1", "bumping retries must not clobber base_sha");

  clearIssueState(db, wsId, "spec-a", "04");
  const cleared = getIssueState(db, wsId, "spec-a", "04");
  assert.equal(cleared.domainRetries, 0);
  assert.equal(cleared.baseSha, null);

  db.close();
});

function usage(costUsd: number, inputTokens: number, outputTokens: number) {
  return { durationMs: 1000, inputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens, costUsd };
}

test("getSpecRunAggregate: sums cost/tokens across runs, tracks whether anything is still open", () => {
  const db = openDb(":memory:");
  const wsId = insertWorkspace(db, {
    name: "w", repoPath: "/tmp/w", specsDir: "specs", mainBranch: "main",
    portRangeStart: 4300, portRangeEnd: 4399, parallelLimit: 2,
  });

  const empty = getSpecRunAggregate(db, wsId, "no-runs-yet");
  assert.deepEqual(empty, {
    costUsd: 0, inputTokens: 0, outputTokens: 0,
    earliestStartedAt: null, latestFinishedAt: null, stillRunning: false,
  });

  const r1 = startRun(db, { workspaceId: wsId, spec: "s", issue: "01", role: "coder", attempt: 1, baseSha: "a" });
  finishRun(db, r1, { outcome: "ok", usage: usage(0.1, 100, 10) });
  const r2 = startRun(db, { workspaceId: wsId, spec: "s", issue: "01", role: "issue_reviewer", attempt: 1, baseSha: "a" });
  finishRun(db, r2, { outcome: "ok", usage: usage(0.05, 50, 5) });

  const done = getSpecRunAggregate(db, wsId, "s");
  assert.equal(done.costUsd, 0.15000000000000002);
  assert.equal(done.inputTokens, 150);
  assert.equal(done.outputTokens, 15);
  assert.equal(done.stillRunning, false);
  assert.ok(done.earliestStartedAt !== null && done.latestFinishedAt !== null);

  startRun(db, { workspaceId: wsId, spec: "s", issue: "02", role: "coder", attempt: 1, baseSha: "b" });
  assert.equal(getSpecRunAggregate(db, wsId, "s").stillRunning, true, "an unfinished run must flip stillRunning");

  db.close();
});

test("getTodayRunAggregate: only counts runs started at or after the cutoff", () => {
  const db = openDb(":memory:");
  const wsId = insertWorkspace(db, {
    name: "w", repoPath: "/tmp/w", specsDir: "specs", mainBranch: "main",
    portRangeStart: 4300, portRangeEnd: 4399, parallelLimit: 2,
  });
  const r1 = startRun(db, { workspaceId: wsId, spec: "s", issue: "01", role: "coder", attempt: 1, baseSha: "a" });
  finishRun(db, r1, { outcome: "ok", usage: usage(1, 10, 1) });

  assert.deepEqual(getTodayRunAggregate(db, wsId, Date.now() + 1000), { costUsd: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(getTodayRunAggregate(db, wsId, Date.now() - 1000), { costUsd: 1, inputTokens: 10, outputTokens: 1 });
});

test("getLatestRun: most recent run for an issue by insertion order, null when there's none", () => {
  const db = openDb(":memory:");
  const wsId = insertWorkspace(db, {
    name: "w", repoPath: "/tmp/w", specsDir: "specs", mainBranch: "main",
    portRangeStart: 4300, portRangeEnd: 4399, parallelLimit: 2,
  });
  assert.equal(getLatestRun(db, wsId, "s", "01"), null);

  const r1 = startRun(db, { workspaceId: wsId, spec: "s", issue: "01", role: "coder", attempt: 1, baseSha: "a" });
  finishRun(db, r1, { outcome: "ok", usage: usage(0, 0, 0) });
  startRun(db, { workspaceId: wsId, spec: "s", issue: "01", role: "issue_reviewer", attempt: 1, baseSha: "a" });

  const latest = getLatestRun(db, wsId, "s", "01");
  assert.equal(latest?.role, "issue_reviewer");
  assert.equal(latest?.finishedAt, null, "the still-running row must report finishedAt: null");
});

test("getSpecReviewComments: parses the latest successful spec_reviewer run, null when there's none", () => {
  const db = openDb(":memory:");
  const wsId = insertWorkspace(db, {
    name: "w", repoPath: "/tmp/w", specsDir: "specs", mainBranch: "main",
    portRangeStart: 4300, portRangeEnd: 4399, parallelLimit: 2,
  });
  assert.equal(getSpecReviewComments(db, wsId, "s"), null);

  const runId = startRun(db, { workspaceId: wsId, spec: "s", issue: null, role: "spec_reviewer", attempt: 1, baseSha: null });
  finishRun(db, runId, { outcome: "ok", usage: usage(0, 0, 0), verdict: { comments: ["dedupe X"] } });

  assert.deepEqual(getSpecReviewComments(db, wsId, "s"), ["dedupe X"]);
});
