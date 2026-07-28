import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readIssueFrontMatter,
  writeIssueFrontMatter,
  readSpecFrontMatter,
  writeSpecFrontMatter,
  importIssueFromSkillsFormat,
} from "./frontmatter.ts";

test("issue front matter round-trips", () => {
  const original = "# some issue\n\nbody text\n";
  const written = writeIssueFrontMatter(original, {
    status: "ready",
    e2e: true,
    blockedBy: ["02", "06"],
  });
  const parsed = readIssueFrontMatter(written);
  assert.deepEqual(parsed, {
    status: "ready",
    e2e: true,
    blockedBy: ["02", "06"],
  });
  assert.match(written, /# some issue/, "body must survive");
});

test("issue front matter with empty blocked_by", () => {
  const written = writeIssueFrontMatter("body", {
    status: "draft",
    e2e: false,
    blockedBy: [],
  });
  const parsed = readIssueFrontMatter(written);
  assert.deepEqual(parsed?.blockedBy, []);
});

test("re-writing preserves body and updates fields", () => {
  const v1 = writeIssueFrontMatter("body", {
    status: "ready",
    e2e: false,
    blockedBy: [],
  });
  const v2 = writeIssueFrontMatter(v1, {
    status: "implementing",
    e2e: false,
    blockedBy: [],
  });
  assert.equal(readIssueFrontMatter(v2)?.status, "implementing");
  assert.match(v2, /body/);
  assert.equal((v2.match(/---/g) || []).length, 2, "must not duplicate the block");
});

test("no front matter returns null", () => {
  assert.equal(readIssueFrontMatter("# plain markdown\n"), null);
});

test("spec front matter round-trips", () => {
  const written = writeSpecFrontMatter("# spec\n", {
    merged: false,
    blockedReason: "rebase_conflict",
  });
  assert.deepEqual(readSpecFrontMatter(written), {
    merged: false,
    blockedReason: "rebase_conflict",
  });
});

test("spec front matter defaults when absent", () => {
  assert.deepEqual(readSpecFrontMatter("# spec\nno front matter here\n"), {
    merged: false,
    blockedReason: null,
  });
});

test("skills format: ready-for-agent maps to ready", () => {
  const raw = "# 04 split-shared-components\n\n**Status:** ready-for-agent\n\nBlocked by: 02\n";
  assert.deepEqual(importIssueFromSkillsFormat(raw), {
    status: "ready",
    e2e: false,
    blockedBy: ["02"],
  });
});

test("skills format: non-bold Status line also parses", () => {
  const result = importIssueFromSkillsFormat("Status: ready-for-human\n");
  assert.notEqual(result, "skip");
  assert.equal((result as { status: string }).status, "human");
});

test("skills format: wontfix is skipped", () => {
  assert.equal(importIssueFromSkillsFormat("Status: wontfix\n"), "skip");
});

test("skills format: no Status line defaults to draft", () => {
  const result = importIssueFromSkillsFormat("# hand-written issue\nno status here\n");
  assert.deepEqual(result, { status: "draft", e2e: false, blockedBy: [] });
});

test("skills format: Blocked by None means no dependencies", () => {
  const raw = "**Status:** ready-for-agent\n**Blocked by:** None\n";
  const result = importIssueFromSkillsFormat(raw);
  assert.notEqual(result, "skip");
  assert.deepEqual((result as { blockedBy: string[] }).blockedBy, []);
});
