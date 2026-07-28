import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function currentHead(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * spec branch 一個 worktree，放 repo 外。branch 不存在就從 main 開一條。
 * worktree 已存在就當成冪等操作跳過（崩潰重啟後會重跑到這裡）。
 */
export function ensureWorktree(
  repoPath: string,
  worktreePath: string,
  specBranch: string,
  mainBranch: string,
): void {
  if (existsSync(worktreePath)) return;

  const branchExists = gitOk(repoPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${specBranch}`,
  ]);

  if (branchExists) {
    git(repoPath, ["worktree", "add", worktreePath, specBranch]);
  } else {
    git(repoPath, ["worktree", "add", "-b", specBranch, worktreePath, mainBranch]);
  }
}

export interface CommitResult {
  committed: boolean;
  sha: string;
}

/**
 * orchestrator 代 coder commit（見 DESIGN.md「worktree 那一側的寫入契約」）。
 * coder 沒有實際改動時回傳 committed:false，呼叫端據此走「diff 為空送 reviewer
 * 判定」的路徑，不當成錯誤。
 */
export function commitAll(worktreePath: string, message: string): CommitResult {
  git(worktreePath, ["add", "-A"]);
  const dirty = git(worktreePath, ["status", "--porcelain"]);
  if (dirty === "") {
    return { committed: false, sha: currentHead(worktreePath) };
  }
  git(worktreePath, ["commit", "-m", message]);
  return { committed: true, sha: currentHead(worktreePath) };
}

export function diffRange(worktreePath: string, baseSha: string, toRef = "HEAD"): string {
  return git(worktreePath, ["diff", `${baseSha}..${toRef}`]);
}

export function diffNameOnly(
  cwd: string,
  fromRef: string,
  toRef: string,
  pathspec?: string[],
): string[] {
  const args = ["diff", "--name-only", `${fromRef}..${toRef}`, "--"];
  const out = git(cwd, pathspec ? [...args, ...pathspec] : [...args, "."]);
  return out === "" ? [] : out.split("\n");
}

/** 越界檢查：agent 的改動有沒有碰到 specs 資料夾。 */
export function touchesPath(
  worktreePath: string,
  baseSha: string,
  relativePath: string,
): boolean {
  return diffNameOnly(worktreePath, baseSha, "HEAD", [relativePath]).length > 0;
}

/** merge 前的判定：main 前進的這段是否只有 loom 自己的 specs-only commit。 */
export function onlyTouchesSpecsDir(
  repoPath: string,
  oldMainSha: string,
  newMainSha: string,
  specsDir: string,
): boolean {
  if (oldMainSha === newMainSha) return true;
  const changed = diffNameOnly(repoPath, oldMainSha, newMainSha, [
    ".",
    `:!${specsDir}/`,
  ]);
  return changed.length === 0;
}

export type RebaseResult = { ok: true } | { ok: false; conflict: true };

/** 每個 issue 完成後把 spec branch rebase 到最新 main。 */
export function rebaseOntoMain(worktreePath: string, mainBranch: string): RebaseResult {
  const ok = gitOk(worktreePath, ["rebase", mainBranch]);
  if (ok) return { ok: true };
  gitOk(worktreePath, ["rebase", "--abort"]);
  return { ok: false, conflict: true };
}

/**
 * 三段式清理，用於 domain 重試第三次與崩潰恢復。單純 `reset --hard` 不刪
 * untracked 檔案也不會中止進行中的 rebase，兩者都必須清掉才是真正乾淨。
 */
export function threeStageClean(worktreePath: string, baseSha: string): void {
  gitOk(worktreePath, ["rebase", "--abort"]);
  git(worktreePath, ["reset", "--hard", baseSha]);
  git(worktreePath, ["clean", "-fd"]);
}

export interface ConsistencyStatus {
  clean: boolean;
  rebaseInProgress: boolean;
  dirty: boolean;
}

/**
 * worktree 沒有自己的 .git 目錄 -- worktreePath/.git 是一個指向
 * main repo `.git/worktrees/<name>/` 的檔案，rebase-merge、rebase-apply
 * 這些狀態檔實際上在那裡，不在 worktreePath/.git 底下。用
 * `git rev-parse --git-dir` 讓 git 自己解析正確位置。
 */
function resolveGitDir(worktreePath: string): string {
  const out = git(worktreePath, ["rev-parse", "--git-dir"]);
  return isAbsolute(out) ? out : join(worktreePath, out);
}

/** 崩潰恢復用：這個 worktree 有沒有半途而廢的 rebase 或未 commit 的殘留。 */
export function checkConsistency(worktreePath: string): ConsistencyStatus {
  const gitDir = resolveGitDir(worktreePath);
  const rebaseInProgress =
    existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"));
  const dirty = git(worktreePath, ["status", "--porcelain"]) !== "";
  return {
    clean: !rebaseInProgress && !dirty,
    rebaseInProgress,
    dirty,
  };
}

export type MergeResult = { ok: true } | { ok: false; conflict: true };

/** 在 main checkout（repoPath，非 worktree）上執行，spec 全綠才呼叫。 */
export function mergeSpecIntoMain(
  repoPath: string,
  specBranch: string,
  mainBranch: string,
): MergeResult {
  git(repoPath, ["checkout", mainBranch]);
  const ok = gitOk(repoPath, ["merge", "--no-ff", specBranch, "-m", `merge ${specBranch}`]);
  if (ok) return { ok: true };
  gitOk(repoPath, ["merge", "--abort"]);
  return { ok: false, conflict: true };
}

export function removeWorktreeAndBranch(
  repoPath: string,
  worktreePath: string,
  specBranch: string,
): void {
  gitOk(repoPath, ["worktree", "remove", worktreePath, "--force"]);
  gitOk(repoPath, ["branch", "-D", specBranch]);
}

/**
 * 狀態 commit：只有 orchestrator 在 main checkout 寫 front matter。只 add
 * specsDir，不用 `add -A` -- 這個 commit 必須只碰 specs 資料夾，
 * onlyTouchesSpecsDir 的判定依賴這個不變量成立。
 */
export function commitStateChange(
  repoPath: string,
  specsDir: string,
  message: string,
): CommitResult {
  git(repoPath, ["add", specsDir]);
  const dirty = git(repoPath, ["status", "--porcelain", "--", specsDir]);
  if (dirty === "") {
    return { committed: false, sha: currentHead(repoPath) };
  }
  git(repoPath, ["commit", "-m", message, "--", specsDir]);
  return { committed: true, sha: currentHead(repoPath) };
}
