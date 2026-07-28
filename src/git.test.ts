import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  ensureWorktree,
  commitAll,
  commitStateChange,
  currentHead,
  diffRange,
  touchesPath,
  onlyTouchesSpecsDir,
  rebaseOntoMain,
  threeStageClean,
  checkConsistency,
  mergeSpecIntoMain,
  removeWorktreeAndBranch,
} from "./git.ts";

const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "git-test");
mkdirSync(scratchRoot, { recursive: true });

function sh(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(scratchRoot, "repo-"));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "test@test"]);
  sh(dir, "git", ["config", "user.name", "test"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  mkdirSync(join(dir, "specs"), { recursive: true });
  writeFileSync(join(dir, "specs", ".gitkeep"), "");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
  return dir;
}

test("ensureWorktree creates branch and worktree, is idempotent", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/foo", "main");
  assert.ok(existsSync(wt));
  assert.ok(existsSync(join(wt, "README.md")));

  // second call must not throw
  ensureWorktree(repo, wt, "spec/foo", "main");
});

test("commitAll: no changes returns committed:false and does not throw", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/nochange", "main");
  const result = commitAll(wt, "should be a no-op");
  assert.equal(result.committed, false);
});

test("commitAll commits new files, diffRange sees them", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/coder-commits", "main");
  const baseSha = currentHead(wt);

  writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
  const result = commitAll(wt, "01 add feature");
  assert.equal(result.committed, true);

  const diff = diffRange(wt, baseSha);
  assert.match(diff, /feature\.ts/);
  assert.match(diff, /export const x/);
});

test("touchesPath detects when a commit touches the specs directory", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/boundary", "main");
  const baseSha = currentHead(wt);

  writeFileSync(join(wt, "specs", "sneaky.md"), "agent should not write here\n");
  commitAll(wt, "oops");

  assert.equal(touchesPath(wt, baseSha, "specs"), true);
});

test("touchesPath is false when specs untouched", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/clean-boundary", "main");
  const baseSha = currentHead(wt);

  writeFileSync(join(wt, "app.ts"), "1\n");
  commitAll(wt, "fine");

  assert.equal(touchesPath(wt, baseSha, "specs"), false);
});

test("onlyTouchesSpecsDir: true when main only advanced via loom state commits", () => {
  const repo = initRepo();
  const oldSha = currentHead(repo);
  writeFileSync(join(repo, "specs", "issue-01.md"), "status: done\n");
  const result = commitStateChange(repo, "specs", "01 -> done");
  assert.equal(result.committed, true);
  const newSha = currentHead(repo);

  assert.equal(onlyTouchesSpecsDir(repo, oldSha, newSha, "specs"), true);
});

test("onlyTouchesSpecsDir: false when main advanced with real code", () => {
  const repo = initRepo();
  const oldSha = currentHead(repo);
  writeFileSync(join(repo, "app.ts"), "real code\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "code change on main"]);
  const newSha = currentHead(repo);

  assert.equal(onlyTouchesSpecsDir(repo, oldSha, newSha, "specs"), false);
});

test("commitStateChange never picks up stray files outside specsDir", () => {
  const repo = initRepo();
  writeFileSync(join(repo, "unrelated.txt"), "should not be committed\n");
  writeFileSync(join(repo, "specs", "issue-01.md"), "status: done\n");

  const result = commitStateChange(repo, "specs", "state only");
  assert.equal(result.committed, true);

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(status, /unrelated\.txt/, "unrelated file must remain untracked");
});

test("rebaseOntoMain replays spec branch onto advanced main cleanly", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/rebase-clean", "main");

  writeFileSync(join(repo, "on-main.txt"), "advance\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "advance main"]);

  writeFileSync(join(wt, "on-spec.txt"), "issue work\n");
  commitAll(wt, "issue work");

  const result = rebaseOntoMain(wt, "main");
  assert.deepEqual(result, { ok: true });
  assert.ok(existsSync(join(wt, "on-main.txt")), "rebased branch must contain main's new commit");
  assert.ok(existsSync(join(wt, "on-spec.txt")), "rebased branch must keep its own commit");
});

test("rebaseOntoMain reports conflict and leaves a clean worktree (no half-finished rebase)", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/rebase-conflict", "main");

  writeFileSync(join(repo, "README.md"), "changed on main\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "conflicting change on main"]);

  writeFileSync(join(wt, "README.md"), "changed on spec branch\n");
  commitAll(wt, "conflicting change on spec");

  const result = rebaseOntoMain(wt, "main");
  assert.deepEqual(result, { ok: false, conflict: true });

  const status = checkConsistency(wt);
  assert.equal(status.rebaseInProgress, false, "aborted rebase must not leave rebase-merge/apply behind");
});

test("threeStageClean removes untracked files that a bare reset --hard would leave behind", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/untracked-cleanup", "main");
  const baseSha = currentHead(wt);

  writeFileSync(join(wt, "half-written.ts"), "agent died mid tool call\n");

  threeStageClean(wt, baseSha);

  assert.equal(existsSync(join(wt, "half-written.ts")), false);
  assert.equal(checkConsistency(wt).clean, true);
});

test("threeStageClean aborts an in-progress rebase before resetting", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/rebase-then-clean", "main");
  const baseSha = currentHead(wt);

  writeFileSync(join(repo, "README.md"), "main advanced\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "advance"]);

  writeFileSync(join(wt, "README.md"), "spec advanced differently\n");
  commitAll(wt, "conflicting");

  const result = rebaseOntoMain(wt, "main");
  assert.equal(result.ok, false);

  // simulate crashing mid-rebase by not relying on the auto-abort inside rebaseOntoMain:
  // directly assert threeStageClean still yields a clean tree even if called after a conflict.
  threeStageClean(wt, baseSha);
  const status = checkConsistency(wt);
  assert.deepEqual(status, { clean: true, rebaseInProgress: false, dirty: false });
  assert.equal(currentHead(wt), baseSha);
});

test("checkConsistency flags a real half-finished rebase (not auto-aborted)", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/real-mid-rebase", "main");
  const baseSha = currentHead(wt);

  writeFileSync(join(repo, "README.md"), "main side\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "main side"]);

  writeFileSync(join(wt, "README.md"), "spec side\n");
  commitAll(wt, "spec side");

  // start a rebase by hand and leave it hanging, to simulate orchestrator dying mid-rebase
  try {
    sh(wt, "git", ["rebase", "main"]);
  } catch {
    // expected: conflict leaves rebase in progress
  }

  const status = checkConsistency(wt);
  assert.equal(status.rebaseInProgress, true);
  assert.equal(status.clean, false);

  // crash recovery path: orchestrator restarts, finds this worktree dirty, cleans it
  threeStageClean(wt, baseSha);
  assert.deepEqual(checkConsistency(wt), { clean: true, rebaseInProgress: false, dirty: false });
  assert.equal(currentHead(wt), baseSha);
});

test("mergeSpecIntoMain merges a clean spec branch into main", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/merge-me", "main");
  writeFileSync(join(wt, "shipped.ts"), "done\n");
  commitAll(wt, "01 ship it");

  const result = mergeSpecIntoMain(repo, "spec/merge-me", "main");
  assert.deepEqual(result, { ok: true });
  assert.ok(existsSync(join(repo, "shipped.ts")));
});

test("mergeSpecIntoMain reports conflict and leaves main usable", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/merge-conflict", "main");

  writeFileSync(join(repo, "README.md"), "main changed it\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "main changes README"]);

  writeFileSync(join(wt, "README.md"), "spec changed it differently\n");
  commitAll(wt, "spec changes README");

  const result = mergeSpecIntoMain(repo, "spec/merge-conflict", "main");
  assert.deepEqual(result, { ok: false, conflict: true });

  // main must be left in a clean, usable state after the aborted merge
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(status.trim(), "");
});

test("removeWorktreeAndBranch cleans up after merge", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/cleanup-me", "main");
  writeFileSync(join(wt, "x.ts"), "1\n");
  commitAll(wt, "work");
  mergeSpecIntoMain(repo, "spec/cleanup-me", "main");

  removeWorktreeAndBranch(repo, wt, "spec/cleanup-me");

  assert.equal(existsSync(wt), false);
  const branches = execFileSync("git", ["branch", "--list", "spec/cleanup-me"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  assert.equal(branches, "");
});
