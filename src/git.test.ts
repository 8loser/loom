import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  ensureWorktree,
  commitAll,
  commitStateChange,
  currentHead,
  diffRange,
  diffForReview,
  diffStatForReview,
  touchesPath,
  onlyTouchesSpecsDir,
  rebaseOntoMain,
  threeStageClean,
  checkConsistency,
  mergeSpecIntoMain,
  removeWorktreeAndBranch,
  commitsBehind,
  diffShortStat,
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

test("commitsBehind: null for a branch that doesn't exist yet, counts main-only commits otherwise", () => {
  const repo = initRepo();
  assert.equal(commitsBehind(repo, "spec/never-started", "main"), null);

  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/behind", "main");
  assert.equal(commitsBehind(repo, "spec/behind", "main"), 0);

  writeFileSync(join(repo, "on-main.txt"), "x\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "lands on main while spec is running"]);
  assert.equal(commitsBehind(repo, "spec/behind", "main"), 1);
});

test("diffShortStat: null when the worktree doesn't exist, insertions/deletions once it does", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  assert.equal(diffShortStat(wt, "HEAD"), null);

  ensureWorktree(repo, wt, "spec/diffstat", "main");
  const baseSha = currentHead(wt);
  assert.deepEqual(diffShortStat(wt, baseSha), { insertions: 0, deletions: 0 });

  writeFileSync(join(wt, "README.md"), "hello\nmore\n");
  writeFileSync(join(wt, "new.ts"), "export const x = 1;\n");
  commitAll(wt, "add a line and a file");
  assert.deepEqual(diffShortStat(wt, baseSha), { insertions: 2, deletions: 0 });
});

// review 的 diff 排除 lockfile、snapshot、build 產物：它們對「這個改動做對
// 了嗎」零價值，卻很容易佔掉 diff 的九成。這不是為了省 token 而截斷，是這
// 些檔案本來就不該被 review。
test("diffForReview keeps real source changes and drops generated files", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/review", "main");

  writeFileSync(join(wt, "src.ts"), "export const real = 1;\n");
  writeFileSync(join(wt, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n");
  mkdirSync(join(wt, "dist"), { recursive: true });
  writeFileSync(join(wt, "dist", "bundle.js"), "console.log('built');\n");
  mkdirSync(join(wt, "packages", "web", "dist"), { recursive: true });
  writeFileSync(join(wt, "packages", "web", "dist", "nested.js"), "console.log('nested');\n");
  writeFileSync(join(wt, "packages", "web", "real.ts"), "export const alsoReal = 2;\n");
  mkdirSync(join(wt, "__snapshots__"), { recursive: true });
  writeFileSync(join(wt, "__snapshots__", "a.snap"), "exports[`x`] = `y`;\n");
  writeFileSync(join(wt, "types.generated.ts"), "export type Gen = 1;\n");
  commitAll(wt, "work plus a pile of generated files");

  const diff = diffForReview(wt, "main");
  assert.match(diff, /export const real/, "the actual change must be there");
  assert.match(diff, /alsoReal/, "source inside a monorepo package must survive too");
  for (const noise of [
    "package-lock.json",
    "pnpm-lock.yaml",
    "dist/bundle.js",
    "packages/web/dist/nested.js",
    "a.snap",
    "types.generated.ts",
  ]) {
    assert.doesNotMatch(diff, new RegExp(noise.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${noise} should be excluded`);
  }
});

test("diffStatForReview lists files and line counts, using the same exclusions", () => {
  const repo = initRepo();
  const wt = join(scratchRoot, "wt-" + Math.random().toString(36).slice(2));
  ensureWorktree(repo, wt, "spec/reviewstat", "main");

  writeFileSync(join(wt, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(wt, "package-lock.json"), "{}\n");
  commitAll(wt, "one real file, one lockfile");

  const stat = diffStatForReview(wt, "main");
  assert.match(stat, /a\.ts/);
  assert.doesNotMatch(stat, /package-lock/);
  assert.doesNotMatch(stat, /export const a/, "a stat is file names and counts, not the content");
});

// DESIGN.md「worktree 位置」：worktree 開在 repo 內，那個目錄必須自我忽略，
// 而忽略規則不能寬到蓋掉 .loom/specs -- 狀態 commit 靠那個路徑落地。
// 這條測試盯的是兩者共存於 .loom/ 底下而不互相波及。
test("ensureWorktree: repo 內的 worktree 自我忽略，主 checkout 保持乾淨且 specs 仍可 commit", () => {
  const repo = initRepo();
  const wt = join(repo, ".loom", "worktrees", "foo");
  ensureWorktree(repo, wt, "spec/foo", "main");

  assert.ok(existsSync(join(repo, ".loom", "worktrees", ".gitignore")));
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal(status.trim(), "", "一整份 checkout 不該出現在主 repo 的 status 裡");

  mkdirSync(join(repo, ".loom", "specs", "demo"), { recursive: true });
  writeFileSync(join(repo, ".loom", "specs", "demo", "spec.md"), "merged: false\n");
  const result = commitStateChange(repo, ".loom/specs", "demo -> created");
  assert.equal(result.committed, true, "同一個 .loom/ 底下的 specs 不能被 worktrees 的忽略規則波及");
});

test("ensureWorktree: 已經有 .gitignore 就不覆寫", () => {
  const repo = initRepo();
  const wt = join(repo, ".loom", "worktrees", "foo");
  const ignoreFile = join(repo, ".loom", "worktrees", ".gitignore");
  mkdirSync(join(repo, ".loom", "worktrees"), { recursive: true });
  writeFileSync(ignoreFile, "*\n# 使用者加的註解\n");

  ensureWorktree(repo, wt, "spec/foo", "main");
  assert.match(readFileSync(ignoreFile, "utf8"), /使用者加的註解/);
});

// 忽略規則寫太寬（`.loom/` 而不是 `.loom/worktrees/`）時，狀態 commit 必須
// 響亮地失敗。`git add <明確路徑>` 對被 ignore 的新檔案會 exit 非 0，這條
// 測試盯的就是它沒有退化成 `add -A` 那種靜默跳過。
test("commitStateChange: specsDir 被 .gitignore 蓋到時拋錯，不是靜默回 committed:false", () => {
  const repo = initRepo();
  writeFileSync(join(repo, ".gitignore"), ".loom/\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "ignore .loom"]);

  mkdirSync(join(repo, ".loom", "specs", "demo"), { recursive: true });
  writeFileSync(join(repo, ".loom", "specs", "demo", "spec.md"), "merged: false\n");

  assert.throws(
    () => commitStateChange(repo, ".loom/specs", "demo -> created"),
    /ignored by one of your .gitignore files/,
  );
});
