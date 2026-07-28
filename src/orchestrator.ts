import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Db, RunUsage, Workspace } from "./db.ts";
import {
  startRun,
  finishRun,
  getIssueState,
  setIssueBaseSha,
  setIssueSourceHash,
  getSourceHashes,
  bumpRetry,
  clearIssueState,
  setVerifiedMainSha,
  getVerifiedMainSha,
} from "./db.ts";
import {
  readIssueFrontMatter,
  writeIssueFrontMatter,
  readSpecFrontMatter,
  writeSpecFrontMatter,
  bodyOf,
  MID_STATES,
  type IssueStatus,
  type SpecBlockedReason,
} from "./frontmatter.ts";
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
  mergeSpecIntoMain,
  removeWorktreeAndBranch,
} from "./git.ts";
import {
  nextDispatchable,
  aggregateSpecStatus,
  type IssueNode,
  type SpecDisplayStatus,
} from "./statemachine.ts";

// 這兩個上限 DESIGN.md 沒有給明確數字（domain 給了「三次」，infra 只說
// 「獨立計數加 backoff」），infra 這裡先跟 domain 一樣是 3，屬於實作時填的
//預設值，不是文件規定的數字。
const DOMAIN_MAX_ATTEMPTS = 3;
const INFRA_MAX_ATTEMPTS = 3;

export type AgentRole = "coder" | "issue_reviewer" | "spec_reviewer";

export interface AgentRequest {
  role: AgentRole;
  workspace: Workspace;
  spec: string;
  issue: string | null; // null 只用於 spec_reviewer
  worktreePath: string;
  attempt: number;
  diff?: string;
  lastFailure?: string;
}

export type AgentResponse =
  | {
      outcome: "ok";
      usage: RunUsage;
      sessionId?: string;
      coder?: { done: boolean; summary: string; filesChanged: string[] };
      issueReview?: { verdict: "pass" | "reject"; comments: string[] };
      specReview?: { comments: string[] };
    }
  | { outcome: "infra_fail"; usage?: RunUsage }
  // 用量視窗用盡（DESIGN.md「用量視窗用盡是全域事件」）：不是這個 issue 的
  // 錯，下一個 issue 一樣會失敗。不能走 infra_fail 的路徑（那會吃掉 infra
  // 重試額度，重試三次後把一個好 issue 判死）。
  | { outcome: "usage_exhausted" };

export type AgentRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface TestResult {
  pass: boolean;
  output: string;
}

export interface TestRunner {
  runIssueTests(worktreePath: string): Promise<TestResult>;
  runSpecE2E(worktreePath: string): Promise<TestResult>;
}

export interface Ctx {
  db: Db;
  workspace: Workspace;
  agent: AgentRunner;
  test: TestRunner;
  /**
   * worktree 根目錄，預設 ~/.loom/worktrees（見 DESIGN.md「worktree 位置」，
   * 固定位置、放 repo 外，避免被 repo 自己的 glob/watcher/test runner 掃到）。
   * 覆寫只用於測試 -- 絕不能推導自 repoPath，那樣兩個 parent 目錄相同的
   * 專案（例如都在 ~/workspaces/ 底下）一旦 spec 撞名就會共用同一個
   * worktree，這正是這裡曾經犯過的錯。
   */
  worktreesRoot?: string;
}

function worktreePath(ctx: Ctx, spec: string): string {
  const root = ctx.worktreesRoot ?? join(homedir(), ".loom", "worktrees");
  return join(root, ctx.workspace.name, spec);
}

function specDir(ctx: Ctx, spec: string): string {
  return join(ctx.workspace.repoPath, ctx.workspace.specsDir, spec);
}

function issuePath(ctx: Ctx, spec: string, issue: string): string {
  const dir = join(specDir(ctx, spec), "issues");
  const [file] = readdirSync(dir).filter((f) => f.startsWith(`${issue}-`) || f === `${issue}.md`);
  if (!file) throw new Error(`issue file not found: ${spec}/${issue}`);
  return join(dir, file);
}

function specPath(ctx: Ctx, spec: string): string {
  return join(specDir(ctx, spec), "spec.md");
}

interface IssueFile extends IssueNode {
  path: string;
  /**
   * 來源過期：這個 issue 完成後，spec.md 或它自己的 issue 檔內容被改過。
   * 純 derived，不進 front matter、不是第十二個狀態、不擋 merge -- 只是看板
   * 上的一個徽章，人決定要重做還是忽略（見 DESIGN.md「來源過期偵測」）。
   * 只對 done 有意義：還在跑的 issue 下一輪本來就會讀到新內容。
   */
  stale: boolean;
}

/**
 * 一個 issue 的「來源內容」指紋：spec.md 的 body 加它自己的 body。
 * 兩份合成一個值，因為人的處置方式不分兩種（都是去 git 看 diff、決定重做或
 * 忽略），而舊版長什麼樣 git 已經有了，不需要另外存內容。
 */
function sourceHash(specBody: string, issueRaw: string): string {
  return createHash("sha256").update(specBody).update("\0").update(bodyOf(issueRaw)).digest("hex");
}

function specBodyOf(ctx: Ctx, spec: string): string {
  return bodyOf(readFileSync(specPath(ctx, spec), "utf8"));
}

/** 讀所有 issue 檔案的 front matter。只在 main checkout 讀，不進 worktree。 */
export function loadIssues(ctx: Ctx, spec: string): IssueFile[] {
  const dir = join(specDir(ctx, spec), "issues");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const specBody = specBodyOf(ctx, spec);
  const recorded = getSourceHashes(ctx.db, ctx.workspace.id, spec);
  return files.map((f) => {
    const path = join(dir, f);
    const raw = readFileSync(path, "utf8");
    const fm = readIssueFrontMatter(raw);
    if (!fm) throw new Error(`issue file missing front matter (import first): ${path}`);
    const id = /^(\d+)/.exec(f)?.[1] ?? f;
    const was = recorded.get(id);
    return {
      id,
      path,
      status: fm.status,
      blockedBy: fm.blockedBy,
      stale: fm.status === "done" && was !== undefined && was !== sourceHash(specBody, raw),
    };
  });
}

/** 過期的 issue 退回重做：狀態回 ready，清掉 base_sha 讓下一輪重新開工。 */
export function redoIssue(ctx: Ctx, spec: string, issueId: string): void {
  const issue = loadIssues(ctx, spec).find((i) => i.id === issueId);
  if (!issue) throw new Error(`no such issue: ${spec}/${issueId}`);
  writeIssueStatus(ctx, spec, issue, "ready", { commit: true, clearRetries: true });
}

/** 「這次改動不影響它」：把記錄的指紋更新成當前值，徽章消失，code 不動。 */
export function acknowledgeStale(ctx: Ctx, spec: string, issueId: string): void {
  const issue = loadIssues(ctx, spec).find((i) => i.id === issueId);
  if (!issue) throw new Error(`no such issue: ${spec}/${issueId}`);
  const hash = sourceHash(specBodyOf(ctx, spec), readFileSync(issue.path, "utf8"));
  setIssueSourceHash(ctx.db, ctx.workspace.id, spec, issueId, hash);
}

/**
 * 寫 issue 狀態。只有 done 觸發 commit 到 main（見 DESIGN.md「狀態寫入」
 * 規則 4），其餘轉移只寫檔。recover / human_reset 額外清掉 issue_state，
 * 讓下一次 claim 是全新的一輪，不繼承舊的 base_sha 與重試計數。
 */
function writeIssueStatus(
  ctx: Ctx,
  spec: string,
  issue: IssueFile,
  status: IssueStatus,
  opts: { commit?: boolean; clearRetries?: boolean } = {},
): void {
  const raw = readFileSync(issue.path, "utf8");
  const fm = readIssueFrontMatter(raw);
  if (!fm) throw new Error(`missing front matter: ${issue.path}`);
  writeFileSync(issue.path, writeIssueFrontMatter(raw, { ...fm, status }));

  if (opts.clearRetries || status === "done" || status === "dropped") {
    clearIssueState(ctx.db, ctx.workspace.id, spec, issue.id);
  }
  if (opts.commit) {
    commitStateChange(ctx.workspace.repoPath, ctx.workspace.specsDir, `${issue.id} -> ${status}`);
  }
}

function writeSpecBlocked(ctx: Ctx, spec: string, reason: SpecBlockedReason | null): void {
  const raw = readFileSync(specPath(ctx, spec), "utf8");
  const fm = readSpecFrontMatter(raw);
  writeFileSync(specPath(ctx, spec), writeSpecFrontMatter(raw, { ...fm, blockedReason: reason }));
}

function feedbackFor(ctx: Ctx, spec: string, issue: string): string | undefined {
  const row = ctx.db
    .prepare(
      `SELECT verdict_json, summary FROM runs
       WHERE workspace_id = ? AND spec = ? AND issue = ? AND outcome = 'domain_fail'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ctx.workspace.id, spec, issue) as
    | { verdict_json: string | null; summary: string | null }
    | undefined;
  if (!row) return undefined;
  return row.verdict_json ?? row.summary ?? undefined;
}

export interface StepResult {
  advanced: boolean;
  status: IssueStatus;
  note?: string;
  /**
   * 用量視窗用盡。呼叫端（runUntilIdle 或未來的多 spec 排程器）看到這個要
   * 整個停下來，不能當成「這個 issue 沒事做了」繼續處理別的 spec -- 額度
   * 是帳號層級的，下一個 spec 一樣會失敗。
   */
  paused?: boolean;
}

function handleUsageExhausted(
  ctx: Ctx,
  spec: string,
  issue: IssueFile,
  runId: number,
  role: "coder" | "issue_reviewer",
): StepResult {
  finishRun(ctx.db, runId, { outcome: "usage_paused" });
  return { advanced: false, status: issue.status, note: `${role}: usage window exhausted`, paused: true };
}

async function doImplement(ctx: Ctx, spec: string, issue: IssueFile): Promise<StepResult> {
  const wt = worktreePath(ctx, spec);
  ensureWorktree(ctx.workspace.repoPath, wt, `spec/${spec}`, ctx.workspace.mainBranch);

  // 每次進 doImplement 都重記，不只第一次：coder 每一次嘗試都會重讀 spec.md
  // 與 issue 檔，指紋要對得上它最後一次真正看到的內容。
  setIssueSourceHash(
    ctx.db,
    ctx.workspace.id,
    spec,
    issue.id,
    sourceHash(specBodyOf(ctx, spec), readFileSync(issue.path, "utf8")),
  );

  let state = getIssueState(ctx.db, ctx.workspace.id, spec, issue.id);
  if (state.baseSha === null) {
    setIssueBaseSha(ctx.db, ctx.workspace.id, spec, issue.id, currentHead(wt));
    state = getIssueState(ctx.db, ctx.workspace.id, spec, issue.id);
  }
  if (issue.status !== "implementing") {
    writeIssueStatus(ctx, spec, issue, "implementing");
  }

  const attempt = state.domainRetries + 1;
  const runId = startRun(ctx.db, {
    workspaceId: ctx.workspace.id,
    spec,
    issue: issue.id,
    role: "coder",
    attempt,
    baseSha: state.baseSha,
  });

  const resp = await ctx.agent({
    role: "coder",
    workspace: ctx.workspace,
    spec,
    issue: issue.id,
    worktreePath: wt,
    attempt,
    lastFailure: feedbackFor(ctx, spec, issue.id),
  });

  if (resp.outcome === "usage_exhausted") {
    return handleUsageExhausted(ctx, spec, issue, runId, "coder");
  }
  if (resp.outcome === "infra_fail") {
    finishRun(ctx.db, runId, { outcome: "infra_fail", usage: resp.usage });
    return handleInfraFail(ctx, spec, issue);
  }

  finishRun(ctx.db, runId, {
    outcome: "ok",
    usage: resp.usage,
    sessionId: resp.sessionId,
    summary: resp.coder?.summary,
  });

  commitAll(wt, `${issue.id} ${resp.coder?.summary ?? "coder update"}`);
  // diff 為空不算失敗（見 DESIGN.md），一律送 review_ready 讓 reviewer 判定。
  writeIssueStatus(ctx, spec, issue, "review_ready");
  return { advanced: true, status: "review_ready" };
}

async function doIssueReview(ctx: Ctx, spec: string, issue: IssueFile): Promise<StepResult> {
  const wt = worktreePath(ctx, spec);
  const state = getIssueState(ctx.db, ctx.workspace.id, spec, issue.id);
  if (state.baseSha === null) throw new Error(`issue ${issue.id} has no base_sha to review against`);

  if (issue.status !== "reviewing") {
    writeIssueStatus(ctx, spec, issue, "reviewing");
  }

  const diff = diffRange(wt, state.baseSha);
  const attempt = state.domainRetries + 1;
  const runId = startRun(ctx.db, {
    workspaceId: ctx.workspace.id,
    spec,
    issue: issue.id,
    role: "issue_reviewer",
    attempt,
    baseSha: state.baseSha,
  });

  const resp = await ctx.agent({
    role: "issue_reviewer",
    workspace: ctx.workspace,
    spec,
    issue: issue.id,
    worktreePath: wt,
    attempt,
    diff,
  });

  if (resp.outcome === "usage_exhausted") {
    return handleUsageExhausted(ctx, spec, issue, runId, "issue_reviewer");
  }
  if (resp.outcome === "infra_fail") {
    finishRun(ctx.db, runId, { outcome: "infra_fail", usage: resp.usage });
    return handleInfraFail(ctx, spec, issue);
  }

  const verdict = resp.issueReview!;
  finishRun(ctx.db, runId, { outcome: "ok", usage: resp.usage, verdict });

  if (verdict.verdict === "pass") {
    writeIssueStatus(ctx, spec, issue, "test_ready");
    return { advanced: true, status: "test_ready" };
  }

  return handleDomainFail(ctx, spec, issue, "review_reject", verdict.comments.join("\n"));
}

async function doTest(ctx: Ctx, spec: string, issue: IssueFile): Promise<StepResult> {
  const wt = worktreePath(ctx, spec);
  const state = getIssueState(ctx.db, ctx.workspace.id, spec, issue.id);
  if (state.baseSha === null) throw new Error(`issue ${issue.id} has no base_sha to test`);

  if (issue.status !== "testing") {
    writeIssueStatus(ctx, spec, issue, "testing");
  }

  const attempt = state.domainRetries + 1;
  const runId = startRun(ctx.db, {
    workspaceId: ctx.workspace.id,
    spec,
    issue: issue.id,
    role: "test",
    attempt,
    baseSha: state.baseSha,
  });

  const result = await ctx.test.runIssueTests(wt);
  finishRun(ctx.db, runId, {
    outcome: result.pass ? "ok" : "domain_fail",
    summary: result.output.slice(-2000),
  });

  if (result.pass) {
    writeIssueStatus(ctx, spec, issue, "done", { commit: true });
    afterIssueDone(ctx, spec);
    return { advanced: true, status: "done" };
  }

  return handleDomainFail(ctx, spec, issue, "test_fail", result.output);
}

function handleInfraFail(ctx: Ctx, spec: string, issue: IssueFile): StepResult {
  const retries = bumpRetry(ctx.db, ctx.workspace.id, spec, issue.id, "infra");
  if (retries >= INFRA_MAX_ATTEMPTS) {
    writeIssueStatus(ctx, spec, issue, "blocked");
    return { advanced: true, status: "blocked", note: "infra retries exhausted" };
  }
  return { advanced: false, status: issue.status, note: `infra retry ${retries}` };
}

function handleDomainFail(
  ctx: Ctx,
  spec: string,
  issue: IssueFile,
  reason: string,
  _feedback: string,
): StepResult {
  const retries = bumpRetry(ctx.db, ctx.workspace.id, spec, issue.id, "domain");

  if (retries >= DOMAIN_MAX_ATTEMPTS) {
    writeIssueStatus(ctx, spec, issue, "blocked");
    return { advanced: true, status: "blocked", note: `domain retries exhausted (${reason})` };
  }

  if (retries === DOMAIN_MAX_ATTEMPTS - 1) {
    // 第三次是最後一次機會：從乾淨狀態重寫，不在堆滿失敗痕跡的 code 上再改。
    const wt = worktreePath(ctx, spec);
    const state = getIssueState(ctx.db, ctx.workspace.id, spec, issue.id);
    threeStageClean(wt, state.baseSha!);
  }

  writeIssueStatus(ctx, spec, issue, "implementing");
  return { advanced: true, status: "implementing", note: `domain retry ${retries} (${reason})` };
}

/** 每個 issue 完成後 rebase spec branch 到最新 main（見 DESIGN.md「git 拓撲」）。 */
function afterIssueDone(ctx: Ctx, spec: string): void {
  const wt = worktreePath(ctx, spec);
  const result = rebaseOntoMain(wt, ctx.workspace.mainBranch);
  if (!result.ok) {
    writeSpecBlocked(ctx, spec, "rebase_conflict");
  }
}

/**
 * 驅動一個 spec 往前走一步：找出 nextDispatchable 的 issue 並對它跑一次
 * stepIssue。回傳 null 代表這個 spec 現在沒有可做的事（可能是全部到達
 * 終端、卡在 blocked/human 沒有替代 issue、或平行度已滿）。
 */
export async function stepSpec(ctx: Ctx, spec: string): Promise<StepResult | null> {
  const issues = loadIssues(ctx, spec);

  // nextDispatchable 只回答「該不該起一個新的」，一旦有 issue 已經在中間
  // 狀態，它就回 null（別再起新的）-- 但那個既有的 issue 本身仍要被繼續
  // 推進（infra 重試、domain 重試都是同一個 issue 再跑一次），不能把
  // nextDispatchable 的「別起新的」誤讀成「沒事可做」。
  const active = issues.find((i) => MID_STATES.includes(i.status));
  const issue = active ?? (() => {
    const id = nextDispatchable(issues);
    return id ? issues.find((i) => i.id === id) : undefined;
  })();
  if (!issue) return null;
  switch (issue.status) {
    case "ready":
    case "implementing":
      return doImplement(ctx, spec, issue);
    case "review_ready":
    case "reviewing":
      return doIssueReview(ctx, spec, issue);
    case "test_ready":
    case "testing":
      return doTest(ctx, spec, issue);
    default:
      throw new Error(`stepSpec: unexpected dispatchable status ${issue.status} for ${issue.id}`);
  }
}

/** 測試與簡單驅動用：重複呼叫 stepSpec 直到沒有事可做。 */
export async function runUntilIdle(ctx: Ctx, spec: string, maxSteps = 100): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = await stepSpec(ctx, spec);
    if (r === null) break;
    results.push(r);
    // 用量用盡不是「這個 spec 沒事做了」，是整個帳號額度用完 -- 停下來，
    // 不要繼續呼叫（下一次呼叫只會得到一樣的結果）。
    if (r.paused) break;
  }
  return results;
}

export type SpecStatus = ReturnType<typeof aggregateSpecStatus>;

const MAX_E2E_FOLLOWUPS = 2;

/**
 * 所有 issue 到達終端後呼叫：跑整體 e2e 與 spec review。e2e 紅了開一個新
 * issue（累計超過上限就 spec blocked，見 DESIGN.md）；spec review 只記錄
 * 意見，不自動開工。
 */
export async function verifySpec(
  ctx: Ctx,
  spec: string,
): Promise<{ e2ePass: boolean; comments: string[]; paused?: boolean }> {
  const wt = worktreePath(ctx, spec);
  const e2e = await ctx.test.runSpecE2E(wt);

  if (!e2e.pass) {
    const followups = countE2EFollowups(ctx, spec);
    if (followups >= MAX_E2E_FOLLOWUPS) {
      writeSpecBlocked(ctx, spec, "e2e_loop");
      return { e2ePass: false, comments: [] };
    }
    createE2EFollowupIssue(ctx, spec, e2e.output, followups + 1);
    return { e2ePass: false, comments: [] };
  }

  const runId = startRun(ctx.db, {
    workspaceId: ctx.workspace.id,
    spec,
    issue: null,
    role: "spec_reviewer",
    attempt: 1,
    baseSha: null,
  });
  const resp = await ctx.agent({
    role: "spec_reviewer",
    workspace: ctx.workspace,
    spec,
    issue: null,
    worktreePath: wt,
    attempt: 1,
  });

  if (resp.outcome === "usage_exhausted") {
    finishRun(ctx.db, runId, { outcome: "usage_paused" });
    // e2e 真的過了，只是意見還沒拿到 -- 不記 verified_main_sha，caller 不該
    // 把這個 spec 當成已經驗證完成，等額度回來再叫一次 verifySpec。
    return { e2ePass: true, comments: [], paused: true };
  }

  // spec_reviewer 失敗（infra_fail）時降級成沒有意見，不擋流程 -- 它本來就
  // 不決定 mergeable（見 DESIGN.md「沒有 verdict，因為它不決定流程」），
  // e2e 才是。但還是要記一筆 run 讓花費/次數看得到。
  finishRun(ctx.db, runId, {
    outcome: resp.outcome === "ok" ? "ok" : "infra_fail",
    usage: resp.outcome === "ok" ? resp.usage : undefined,
    verdict: resp.outcome === "ok" ? resp.specReview : undefined,
  });
  const comments = resp.outcome === "ok" ? resp.specReview?.comments ?? [] : [];
  setVerifiedMainSha(ctx.db, ctx.workspace.id, spec, currentHead(ctx.workspace.repoPath));
  return { e2ePass: true, comments };
}

function countE2EFollowups(ctx: Ctx, spec: string): number {
  const dir = join(specDir(ctx, spec), "issues");
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return files.filter((f) => f.includes("e2e-followup")).length;
}

function createE2EFollowupIssue(ctx: Ctx, spec: string, tailOutput: string, n: number): void {
  const dir = join(specDir(ctx, spec), "issues");
  const existing = readdirSync(dir).filter((f) => /^\d+/.test(f));
  const nums = existing.map((f) => parseInt(/^(\d+)/.exec(f)![1], 10));
  const nextNum = String(Math.max(0, ...nums) + 1).padStart(2, "0");
  const path = join(dir, `${nextNum}-e2e-followup-${n}.md`);
  const body = `# ${nextNum} e2e-followup-${n}\n\nspec e2e failed:\n\n\`\`\`\n${tailOutput.slice(-2000)}\n\`\`\`\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, writeIssueFrontMatter(body, { status: "ready", e2e: true, blockedBy: [] }));
}

export interface MergeResult {
  merged: boolean;
  reason?: "rebase_conflict" | "specs_touched" | "merge_conflict" | "needs_reverify";
}

/**
 * merge 按鈕。先 rebase，若帶進非 specs-only 的 commit 就要求重新走
 * verifySpec，不直接合併（見 DESIGN.md「多個 spec 平行時的三個交互點」）。
 */
export function attemptMerge(ctx: Ctx, spec: string): MergeResult {
  const wt = worktreePath(ctx, spec);

  // main 不會因為 rebase 這個動作本身移動（rebase 動的是 spec branch），
  // 所以「mergeable 等待期間 main 有沒有被塞進真正的 code」這件事，比較
  // 的基準必須是「上次 verifySpec 通過時 main 的 HEAD」，不能拿 rebase
  // 前後的 main HEAD 互相比（那永遠相等，等於沒檢查）。
  // verifiedSha 為 null 代表這個 spec 從沒驗證過就被叫來 merge -- 正常
  // 情況下呼叫端只在聚合狀態是 mergeable（verifySpec 已通過）時才會叫這
  // 支函式，所以這裡信任呼叫順序，不主動擋。
  const verifiedSha = getVerifiedMainSha(ctx.db, ctx.workspace.id, spec);
  const currentMainSha = currentHead(ctx.workspace.repoPath);
  if (
    verifiedSha &&
    !onlyTouchesSpecsDir(ctx.workspace.repoPath, verifiedSha, currentMainSha, ctx.workspace.specsDir)
  ) {
    return { merged: false, reason: "needs_reverify" };
  }

  const rebase = rebaseOntoMain(wt, ctx.workspace.mainBranch);
  if (!rebase.ok) {
    writeSpecBlocked(ctx, spec, "rebase_conflict");
    return { merged: false, reason: "rebase_conflict" };
  }

  if (touchesPath(wt, ctx.workspace.mainBranch, ctx.workspace.specsDir)) {
    writeSpecBlocked(ctx, spec, "specs_touched");
    return { merged: false, reason: "specs_touched" };
  }

  const merge = mergeSpecIntoMain(ctx.workspace.repoPath, `spec/${spec}`, ctx.workspace.mainBranch);
  if (!merge.ok) {
    writeSpecBlocked(ctx, spec, "merge_conflict");
    return { merged: false, reason: "merge_conflict" };
  }

  const raw = readFileSync(specPath(ctx, spec), "utf8");
  const fm = readSpecFrontMatter(raw);
  writeFileSync(specPath(ctx, spec), writeSpecFrontMatter(raw, { ...fm, merged: true }));
  commitStateChange(ctx.workspace.repoPath, ctx.workspace.specsDir, `${spec} -> merged`);

  removeWorktreeAndBranch(ctx.workspace.repoPath, wt, `spec/${spec}`);
  return { merged: true };
}

/** 「blocked 先收目前進度」：blocked 的 issue 與所有下游未開工 issue 一起丟。 */
export function dropIssueAndDownstream(ctx: Ctx, spec: string, issueId: string): void {
  const issues = loadIssues(ctx, spec);
  const toDrop = new Set([issueId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of issues) {
      if (toDrop.has(issue.id)) continue;
      if (issue.blockedBy.some((d) => toDrop.has(d))) {
        toDrop.add(issue.id);
        changed = true;
      }
    }
  }
  for (const issue of issues) {
    if (toDrop.has(issue.id) && issue.status !== "done") {
      writeIssueStatus(ctx, spec, issue, "dropped");
    }
  }
}

/** 掃 specsDir 底下有 spec.md 的目錄。不驗證內容格式，畸形的交給呼叫端處理。 */
export function listSpecs(ctx: Ctx): string[] {
  const root = join(ctx.workspace.repoPath, ctx.workspace.specsDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "spec.md")))
    .map((e) => e.name)
    .sort();
}

export interface SpecBoard {
  spec: string;
  status: SpecDisplayStatus;
  merged: boolean;
  blockedReason: SpecBlockedReason | null;
  issues: IssueFile[];
}

/**
 * 單一權威讀模型：kanban API 與排程器都呼叫這支，不能各自重算聚合邏輯
 * （見 DESIGN.md「spec 層」）。verifyResult 只需要 pass / 非 pass 兩種給
 * aggregateSpecStatus 分支，"fail" 用不到 -- e2e 失敗或 spec_reviewer
 * 還沒過都是 verified_main_sha 沒寫入，跟「還沒驗證」是同一個狀態。
 */
export function getSpecBoard(ctx: Ctx, spec: string): SpecBoard {
  const raw = readFileSync(specPath(ctx, spec), "utf8");
  const fm = readSpecFrontMatter(raw);
  const issues = loadIssues(ctx, spec);
  const verifyResult: "pending" | "pass" =
    getVerifiedMainSha(ctx.db, ctx.workspace.id, spec) !== null ? "pass" : "pending";
  const status = aggregateSpecStatus({
    merged: fm.merged,
    blockedReason: fm.blockedReason,
    issues,
    verifyResult,
  });
  return { spec, status, merged: fm.merged, blockedReason: fm.blockedReason, issues };
}

const DRIVEN_STATUSES: SpecDisplayStatus[] = ["queued", "running", "verifying"];
// 防跑飛的安全網：正常一個 spec 走完所有 issue 加 verify 不會逼近這個數字。
// 撞到代表 driveSpec 陷入迴圈（多半是新 bug），要當成錯誤處理，不能悶著頭
// 一直跑到燒光額度或塞爆 log。
const MAX_DRIVE_STEPS = 500;

/**
 * 把一個 spec 從目前狀態一路推到「這一輪沒事可做」為止：queued/running 時
 * 呼叫 stepSpec，全部 issue 到終端時呼叫 verifySpec，兩者間交錯直到落到
 * blocked/human/mergeable/merged/draft 其中之一，或用量用盡暫停。
 */
export async function driveSpec(
  ctx: Ctx,
  spec: string,
  onProgress?: () => void,
): Promise<{ paused: boolean }> {
  for (let i = 0; i < MAX_DRIVE_STEPS; i++) {
    const status = getSpecBoard(ctx, spec).status;
    if (!DRIVEN_STATUSES.includes(status)) return { paused: false };

    if (status === "verifying") {
      const v = await verifySpec(ctx, spec);
      onProgress?.();
      if (v.paused) return { paused: true };
      continue; // e2e 紅了會多一個 ready issue（回 queued），過了會變 mergeable
    }

    const r = await stepSpec(ctx, spec);
    onProgress?.();
    if (r === null) return { paused: false }; // 不該發生：queued/running 代表有事可做
    if (r.paused) return { paused: true };
  }
  throw new Error(`driveSpec: spec ${spec} exceeded ${MAX_DRIVE_STEPS} steps, likely stuck in a loop`);
}

export interface Scheduler {
  pause(): void;
  /** 清掉暫停狀態（含用量用盡與上次的錯誤）並立刻嘗試往下跑。 */
  resume(): void;
  /** 外部動作（redo issue、匯入新 spec）後的提醒：暫停中不會因此被喚醒。 */
  wake(): void;
  stop(): void;
  isPaused(): boolean;
  /** 上一次 tick 因未預期例外中止時的訊息；resume() 會清掉。 */
  getError(): string | null;
}

/**
 * 一個 workspace 一個排程器：輪詢找出還有事做的 spec，逐一 driveSpec 到底。
 * ponytail: 同一個 workspace 底下的 spec 目前是序列處理，沒有真的用到
 * `parallelLimit` 平行跑——真平行需要先解決「commitStateChange /
 * mergeSpecIntoMain 同時寫同一個 main checkout」的序列化問題（DESIGN.md
 * 「orchestrator 必須是單一事件迴圈」），那是獨立的一塊設計，這裡先用
 * 「同時只有一個 spec 在跑」把正確性換到手，效能之後再補。不同 workspace
 * 之間本來就互不相干（各自的 repoPath），彼此仍會平行跑。
 */
export function startScheduler(
  ctx: Ctx,
  opts: { pollMs?: number; onChange?: () => void } = {},
): Scheduler {
  const pollMs = opts.pollMs ?? 5000;
  let paused = false;
  let driving = false;
  let stopped = false;
  let lastError: string | null = null;

  function pickNextSpec(): string | null {
    for (const spec of listSpecs(ctx)) {
      let status: SpecDisplayStatus;
      try {
        status = getSpecBoard(ctx, spec).status;
      } catch {
        continue; // 尚未 import（沒有 front matter）或格式不對，交給匯入流程
      }
      if (DRIVEN_STATUSES.includes(status)) return spec;
    }
    return null;
  }

  async function tick(): Promise<void> {
    if (paused || driving || stopped) return;
    driving = true;
    try {
      for (;;) {
        const spec = pickNextSpec();
        if (!spec) break;
        const result = await driveSpec(ctx, spec, opts.onChange);
        if (result.paused) {
          paused = true;
          opts.onChange?.();
          break;
        }
      }
    } catch (err) {
      // 未預期例外：安全預設是暫停整個 workspace 讓人看一眼，不要悶著頭對
      // 同一個壞掉的 spec 每個 poll 週期重跑一次同樣的錯誤。
      lastError = err instanceof Error ? err.message : String(err);
      paused = true;
      opts.onChange?.();
    } finally {
      driving = false;
    }
  }

  const timer = setInterval(() => void tick(), pollMs);
  void tick();

  return {
    pause() {
      paused = true;
    },
    resume() {
      if (stopped) return;
      paused = false;
      lastError = null;
      void tick();
    },
    wake() {
      if (!paused) void tick();
    },
    stop() {
      stopped = true;
      paused = true;
      clearInterval(timer);
    },
    isPaused() {
      return paused;
    },
    getError() {
      return lastError;
    },
  };
}
