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
 * 設定頁主分支選單的選項。只列本地分支 -- rebase/merge 的目標得是本地 ref，
 * 而且 spec branch 也是從它開出來的。repo 讀不到就回空陣列，設定頁少一個
 * 選單不該讓整頁掛掉。
 */
export function listBranches(repoPath: string): string[] {
  try {
    return git(repoPath, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
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

/**
 * review 用的 diff 要排除的東西：lockfile、snapshot、build 產物。
 *
 * 它們對「這個改動做對了嗎」零價值，卻很容易佔掉 diff 的九成 --
 * `package-lock.json` 改一次就是幾千行。這不是為了省 token 而截斷（那會
 * 隨機丟掉 reviewer 要找的東西），是這些檔案本來就不該被 review。
 *
 * 寫死一份常見清單，不開設定欄位：DESIGN.md「不為詞彙表與規範文件開設定
 * 欄位」的同一個理由，多開一個地方可以改就多一個地方會不一致。monorepo 的
 * 產生檔路徑五花八門，真的漏掉的話補進這份清單，不是叫每個專案自己填。
 *
 * 兩個 pathspec 的坑，都是實際撞到才知道的：
 * 1. 用長格式 `:(exclude)` 不用短格式 `:!`。短格式會把 pattern 開頭的字元
 *    繼續當成 magic signature 解析，`:!__snapshots__/*` 直接讓 git 死在
 *    「Unimplemented pathspec magic '_'」。
 * 2. 不用雙星號。git 預設的比對不帶 FNM_PATHNAME，單個 `*` 本來就跨 `/`，
 *    所以 `*.generated.*` 任何深度都中；加上雙星號前綴反而要求前面至少有
 *    一層目錄，根目錄的檔案會漏掉。目錄類的兩種形式都列，涵蓋根目錄與
 *    monorepo 的 packages/x/dist。
 */
const REVIEW_EXCLUDED = [
  ":(exclude)package-lock.json",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)yarn.lock",
  ":(exclude)bun.lockb",
  ":(exclude)*.snap",
  ":(exclude)*.generated.*",
  ":(exclude)dist/*",
  ":(exclude)*/dist/*",
  ":(exclude)build/*",
  ":(exclude)*/build/*",
  ":(exclude)__snapshots__/*",
  ":(exclude)*/__snapshots__/*",
];

/** 一個 spec 分支相對 main 的完整 diff，給 spec_reviewer 看跨 issue 的全貌。 */
export function diffForReview(worktreePath: string, fromRef: string, toRef = "HEAD"): string {
  return git(worktreePath, ["diff", `${fromRef}..${toRef}`, "--", ".", ...REVIEW_EXCLUDED]);
}

/** 檔案清單加增刪行數。diff 大到不值得整份送進 prompt 時改送這個。 */
export function diffStatForReview(worktreePath: string, fromRef: string, toRef = "HEAD"): string {
  return git(worktreePath, ["diff", `${fromRef}..${toRef}`, "--stat", "--", ".", ...REVIEW_EXCLUDED]);
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

/**
 * 看板「落後 main」欄位：main 已經有、spec branch 還沒 rebase 進來的
 * commit 數。分支不存在（spec 還沒開工）回 null，不當成錯誤。
 */
export function commitsBehind(repoPath: string, branch: string, mainBranch: string): number | null {
  if (!gitOk(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) return null;
  return Number(git(repoPath, ["rev-list", "--count", `${branch}..${mainBranch}`]));
}

export interface DiffStat {
  insertions: number;
  deletions: number;
}

/** issue 詳情面板的 +/- 統計。worktree 不存在（還沒開工、或 spec 已合併移除）回 null。 */
export function diffShortStat(worktreePath: string, baseSha: string): DiffStat | null {
  if (!existsSync(worktreePath)) return null;
  const out = git(worktreePath, ["diff", "--shortstat", `${baseSha}..HEAD`]);
  const insertions = /(\d+) insertion/.exec(out);
  const deletions = /(\d+) deletion/.exec(out);
  return {
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
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
