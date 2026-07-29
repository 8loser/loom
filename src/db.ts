import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export interface Workspace {
  id: number;
  name: string;
  repoPath: string;
  specsDir: string;
  mainBranch: string;
  portRangeStart: number;
  portRangeEnd: number;
  parallelLimit: number;
}

// "test" 不是 LLM 角色（見 DESIGN.md「沒有 tester agent」），但綠燈路徑
// 也記一筆 run，讓 issue 面板的耗時/歷史看得到 testing 階段發生過什麼。
export type Role = "coder" | "issue_reviewer" | "spec_reviewer" | "chat" | "test";
export type RunOutcome =
  | "ok"
  | "domain_fail"
  | "infra_fail"
  | "usage_paused";

export interface RunUsage {
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  repo_path TEXT NOT NULL,
  specs_dir TEXT NOT NULL DEFAULT 'specs',
  main_branch TEXT NOT NULL DEFAULT 'main',
  port_range_start INTEGER NOT NULL DEFAULT 4300,
  port_range_end INTEGER NOT NULL DEFAULT 4399,
  parallel_limit INTEGER NOT NULL DEFAULT 2,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  spec TEXT NOT NULL,
  issue TEXT,
  role TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  base_sha TEXT,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  outcome TEXT,
  verdict_json TEXT,
  summary TEXT,
  raw_output_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs (workspace_id, spec, issue);
CREATE INDEX IF NOT EXISTS idx_runs_spec ON runs (workspace_id, spec);

-- 每個 issue 目前這一輪的可變狀態：base_sha 與獨立的 domain/infra 重試計數。
-- 不放進 front matter，因為那些不是狀態機需要的欄位（見 DESIGN.md「狀態寫入」）。
-- source_hash 例外：它跨輪存活，見 clearIssueState。
CREATE TABLE IF NOT EXISTS issue_state (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  spec TEXT NOT NULL,
  issue TEXT NOT NULL,
  base_sha TEXT,
  domain_retries INTEGER NOT NULL DEFAULT 0,
  infra_retries INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, spec, issue)
);

-- verifySpec 通過時記下當時 main 的 HEAD。merge 按鈕按下時拿它跟 main
-- 現在的 HEAD 比對，判斷 mergeable 等待期間 main 有沒有被別的 spec
-- 塞進真正的 code（不只是 loom 自己的狀態 commit），有的話要求重驗
-- （見 DESIGN.md「多個 spec 平行時的三個交互點」）。
CREATE TABLE IF NOT EXISTS spec_state (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  spec TEXT NOT NULL,
  verified_main_sha TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, spec)
);

-- 每個角色一份可編輯的提示詞，per-workspace（見 DESIGN.md「提示詞在 web UI
-- 上可調」）。新增 workspace 時複製一份內建預設進來，沒有繼承或覆寫的兩層
-- 邏輯。不做版本歷史，編輯就是覆蓋 -- 看到 coder 一直踩同一個坑、改模板、
-- 讓當前重試立刻吃到新版，正是這個功能的用途。
CREATE TABLE IF NOT EXISTS prompts (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL,
  template TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, role)
);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function insertWorkspace(
  db: Db,
  w: Omit<Workspace, "id">,
): number {
  const stmt = db.prepare(
    `INSERT INTO workspaces (name, repo_path, specs_dir, main_branch, port_range_start, port_range_end, parallel_limit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    w.name,
    w.repoPath,
    w.specsDir,
    w.mainBranch,
    w.portRangeStart,
    w.portRangeEnd,
    w.parallelLimit,
    Date.now(),
  );
  return Number(result.lastInsertRowid);
}

export function getWorkspace(db: Db, name: string): Workspace | undefined {
  const row = db
    .prepare("SELECT * FROM workspaces WHERE name = ?")
    .get(name) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToWorkspace(row);
}

export function listWorkspaces(db: Db): Workspace[] {
  const rows = db.prepare("SELECT * FROM workspaces ORDER BY name").all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToWorkspace);
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as number,
    name: row.name as string,
    repoPath: row.repo_path as string,
    specsDir: row.specs_dir as string,
    mainBranch: row.main_branch as string,
    portRangeStart: row.port_range_start as number,
    portRangeEnd: row.port_range_end as number,
    parallelLimit: row.parallel_limit as number,
  };
}

/** 只有 LLM 角色有提示詞，"test" 不是（見 DESIGN.md「沒有 tester agent」）。 */
export type PromptRole = Exclude<Role, "test">;

export function setPrompt(db: Db, workspaceId: number, role: PromptRole, template: string): void {
  db.prepare(
    `INSERT INTO prompts (workspace_id, role, template, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, role) DO UPDATE SET template = excluded.template, updated_at = excluded.updated_at`,
  ).run(workspaceId, role, template, Date.now());
}

/** null 代表這個 workspace 還沒有那個角色的模板，呼叫端該用內建預設。 */
export function getPrompt(db: Db, workspaceId: number, role: PromptRole): string | null {
  const row = db
    .prepare("SELECT template FROM prompts WHERE workspace_id = ? AND role = ?")
    .get(workspaceId, role) as { template: string } | undefined;
  return row?.template ?? null;
}

export function getPrompts(db: Db, workspaceId: number): Record<string, string> {
  const rows = db
    .prepare("SELECT role, template FROM prompts WHERE workspace_id = ?")
    .all(workspaceId) as { role: string; template: string }[];
  return Object.fromEntries(rows.map((r) => [r.role, r.template]));
}

export function deletePrompt(db: Db, workspaceId: number, role: PromptRole): void {
  db.prepare("DELETE FROM prompts WHERE workspace_id = ? AND role = ?").run(workspaceId, role);
}

export function startRun(
  db: Db,
  args: {
    workspaceId: number;
    spec: string;
    issue: string | null;
    role: Role;
    attempt: number;
    baseSha: string | null;
  },
): number {
  const stmt = db.prepare(
    `INSERT INTO runs (workspace_id, spec, issue, role, attempt, base_sha, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    args.workspaceId,
    args.spec,
    args.issue,
    args.role,
    args.attempt,
    args.baseSha,
    Date.now(),
  );
  return Number(result.lastInsertRowid);
}

export function finishRun(
  db: Db,
  runId: number,
  args: {
    outcome: RunOutcome;
    usage?: RunUsage;
    sessionId?: string;
    verdict?: unknown;
    summary?: string;
    rawOutputPath?: string;
  },
): void {
  const stmt = db.prepare(
    `UPDATE runs SET
       finished_at = ?, outcome = ?, session_id = ?, verdict_json = ?, summary = ?, raw_output_path = ?,
       duration_ms = ?, input_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, output_tokens = ?, cost_usd = ?
     WHERE id = ?`,
  );
  stmt.run(
    Date.now(),
    args.outcome,
    args.sessionId ?? null,
    args.verdict !== undefined ? JSON.stringify(args.verdict) : null,
    args.summary ?? null,
    args.rawOutputPath ?? null,
    args.usage?.durationMs ?? null,
    args.usage?.inputTokens ?? null,
    args.usage?.cacheReadTokens ?? null,
    args.usage?.cacheCreationTokens ?? null,
    args.usage?.outputTokens ?? null,
    args.usage?.costUsd ?? null,
    runId,
  );
}

export interface IssueState {
  baseSha: string | null;
  domainRetries: number;
  infraRetries: number;
  sourceHash: string | null;
}

export function getIssueState(
  db: Db,
  workspaceId: number,
  spec: string,
  issue: string,
): IssueState {
  const row = db
    .prepare(
      "SELECT base_sha, domain_retries, infra_retries, source_hash FROM issue_state WHERE workspace_id = ? AND spec = ? AND issue = ?",
    )
    .get(workspaceId, spec, issue) as Record<string, unknown> | undefined;
  if (!row) return { baseSha: null, domainRetries: 0, infraRetries: 0, sourceHash: null };
  return {
    baseSha: row.base_sha as string | null,
    domainRetries: row.domain_retries as number,
    infraRetries: row.infra_retries as number,
    sourceHash: row.source_hash as string | null,
  };
}

export function setIssueBaseSha(
  db: Db,
  workspaceId: number,
  spec: string,
  issue: string,
  baseSha: string,
): void {
  db.prepare(
    `INSERT INTO issue_state (workspace_id, spec, issue, base_sha, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, spec, issue)
     DO UPDATE SET base_sha = excluded.base_sha, updated_at = excluded.updated_at`,
  ).run(workspaceId, spec, issue, baseSha, Date.now());
}

export function bumpRetry(
  db: Db,
  workspaceId: number,
  spec: string,
  issue: string,
  kind: "domain" | "infra",
): number {
  const col = kind === "domain" ? "domain_retries" : "infra_retries";
  db.prepare(
    `INSERT INTO issue_state (workspace_id, spec, issue, ${col}, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (workspace_id, spec, issue)
     DO UPDATE SET ${col} = ${col} + 1, updated_at = excluded.updated_at`,
  ).run(workspaceId, spec, issue, Date.now());
  return getIssueState(db, workspaceId, spec, issue)[
    kind === "domain" ? "domainRetries" : "infraRetries"
  ];
}

export function setIssueSourceHash(
  db: Db,
  workspaceId: number,
  spec: string,
  issue: string,
  hash: string,
): void {
  db.prepare(
    `INSERT INTO issue_state (workspace_id, spec, issue, source_hash, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, spec, issue)
     DO UPDATE SET source_hash = excluded.source_hash, updated_at = excluded.updated_at`,
  ).run(workspaceId, spec, issue, hash, Date.now());
}

/** 一次拿一個 spec 底下所有 issue 的 source_hash，給 loadIssues 算過期用。 */
export function getSourceHashes(
  db: Db,
  workspaceId: number,
  spec: string,
): Map<string, string> {
  const rows = db
    .prepare(
      "SELECT issue, source_hash FROM issue_state WHERE workspace_id = ? AND spec = ? AND source_hash IS NOT NULL",
    )
    .all(workspaceId, spec) as { issue: string; source_hash: string }[];
  return new Map(rows.map((r) => [r.issue, r.source_hash]));
}

/**
 * 結束這一輪：清掉 base_sha 與重試計數，讓下一次 claim 是全新的一輪。
 * 不能整列 DELETE -- source_hash 必須跨輪存活，過期偵測正是對「已經 done、
 * 這一輪早就結束」的 issue 才有意義（見 DESIGN.md「來源過期偵測」）。
 */
export function clearIssueState(
  db: Db,
  workspaceId: number,
  spec: string,
  issue: string,
): void {
  db.prepare(
    `UPDATE issue_state SET base_sha = NULL, domain_retries = 0, infra_retries = 0, updated_at = ?
     WHERE workspace_id = ? AND spec = ? AND issue = ?`,
  ).run(Date.now(), workspaceId, spec, issue);
}

export function setVerifiedMainSha(
  db: Db,
  workspaceId: number,
  spec: string,
  sha: string,
): void {
  db.prepare(
    `INSERT INTO spec_state (workspace_id, spec, verified_main_sha, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, spec)
     DO UPDATE SET verified_main_sha = excluded.verified_main_sha, updated_at = excluded.updated_at`,
  ).run(workspaceId, spec, sha, Date.now());
}

export function getVerifiedMainSha(
  db: Db,
  workspaceId: number,
  spec: string,
): string | null {
  const row = db
    .prepare(
      "SELECT verified_main_sha FROM spec_state WHERE workspace_id = ? AND spec = ?",
    )
    .get(workspaceId, spec) as { verified_main_sha: string | null } | undefined;
  return row?.verified_main_sha ?? null;
}

export interface SpecRunAggregate {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  earliestStartedAt: number | null;
  latestFinishedAt: number | null;
  stillRunning: boolean;
}

/** 看板用：一個 spec 至今所有 run 的花費/token 總和與耗時範圍。 */
export function getSpecRunAggregate(db: Db, workspaceId: number, spec: string): SpecRunAggregate {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              MIN(started_at) AS earliest_started_at,
              MAX(finished_at) AS latest_finished_at,
              SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) AS open_count
       FROM runs WHERE workspace_id = ? AND spec = ?`,
    )
    .get(workspaceId, spec) as Record<string, unknown>;
  return {
    costUsd: row.cost_usd as number,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    earliestStartedAt: row.earliest_started_at as number | null,
    latestFinishedAt: row.latest_finished_at as number | null,
    stillRunning: (row.open_count as number) > 0,
  };
}

export interface TodayRunAggregate {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** topbar meters 用：sinceMs 之後啟動的 run 的花費/token 總和。 */
export function getTodayRunAggregate(db: Db, workspaceId: number, sinceMs: number): TodayRunAggregate {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM runs WHERE workspace_id = ? AND started_at >= ?`,
    )
    .get(workspaceId, sinceMs) as Record<string, unknown>;
  return {
    costUsd: row.cost_usd as number,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
  };
}

export interface LatestRun {
  id: number;
  role: Role;
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
}

/** issue 詳情面板用：這個 issue 最近一次（不論成功與否）的 run。 */
export function getLatestRun(db: Db, workspaceId: number, spec: string, issue: string): LatestRun | null {
  const row = db
    .prepare(
      `SELECT id, role, attempt, started_at, finished_at FROM runs
       WHERE workspace_id = ? AND spec = ? AND issue = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workspaceId, spec, issue) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    role: row.role as Role,
    attempt: row.attempt as number,
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | null,
  };
}

/** spec 詳情面板用：最近一次成功的 spec_reviewer 意見（不決定流程，只給人看）。 */
export function getSpecReviewComments(db: Db, workspaceId: number, spec: string): string[] | null {
  const row = db
    .prepare(
      `SELECT verdict_json FROM runs
       WHERE workspace_id = ? AND spec = ? AND issue IS NULL AND role = 'spec_reviewer' AND outcome = 'ok'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workspaceId, spec) as { verdict_json: string | null } | undefined;
  if (!row?.verdict_json) return null;
  const parsed = JSON.parse(row.verdict_json) as { comments?: string[] };
  return parsed.comments ?? [];
}
