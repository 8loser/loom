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
