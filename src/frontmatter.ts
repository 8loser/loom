// ponytail: hand-rolled minimal front matter parser, not general YAML.
// loom's front matter is always flat string/bool/array-of-strings -- a real
// parser (js-yaml) is only worth adding if the field set grows past that.

export type IssueStatus =
  | "draft"
  | "ready"
  | "implementing"
  | "review_ready"
  | "reviewing"
  | "test_ready"
  | "testing"
  | "done"
  | "blocked"
  | "human"
  | "dropped";

export const MID_STATES: IssueStatus[] = [
  "implementing",
  "review_ready",
  "reviewing",
  "test_ready",
  "testing",
];

export interface IssueFrontMatter {
  status: IssueStatus;
  e2e: boolean;
  blockedBy: string[];
}

export type SpecBlockedReason =
  | "rebase_conflict"
  | "merge_conflict"
  | "specs_touched"
  | "e2e_loop";

export interface SpecFrontMatter {
  merged: boolean;
  blockedReason: SpecBlockedReason | null;
}

interface ParsedFile {
  data: Record<string, string>;
  body: string;
}

const FM_BLOCK = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseBlock(raw: string): ParsedFile | null {
  const m = FM_BLOCK.exec(raw);
  if (!m) return null;
  const [, yaml, body] = m;
  const data: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = kv[2].trim();
  }
  return { data, body };
}

function parseArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function serializeBlock(fields: [string, string][], body: string): string {
  const yaml = fields.map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * 去掉 front matter 後的內容。過期偵測 hash 的是這個而不是整份檔案：front
 * matter 由 orchestrator 自己寫（`merged: true`、`status` 轉移），拿整檔算
 * hash 的話按下 merge 那一刻所有 issue 會同時變成過期。
 */
export function bodyOf(raw: string): string {
  return parseBlock(raw)?.body ?? raw;
}

export function readIssueFrontMatter(raw: string): IssueFrontMatter | null {
  const parsed = parseBlock(raw);
  if (!parsed || !parsed.data.status) return null;
  return {
    status: parsed.data.status as IssueStatus,
    e2e: parsed.data.e2e === "true",
    blockedBy: parsed.data.blocked_by ? parseArray(parsed.data.blocked_by) : [],
  };
}

export function writeIssueFrontMatter(raw: string, fm: IssueFrontMatter): string {
  const existing = parseBlock(raw);
  const body = existing ? existing.body : raw;
  const fields: [string, string][] = [
    ["status", fm.status],
    ["e2e", String(fm.e2e)],
    ["blocked_by", `[${fm.blockedBy.join(", ")}]`],
  ];
  return serializeBlock(fields, body);
}

export function readSpecFrontMatter(raw: string): SpecFrontMatter {
  const parsed = parseBlock(raw);
  if (!parsed) return { merged: false, blockedReason: null };
  const reason = parsed.data.blocked_reason;
  return {
    merged: parsed.data.merged === "true",
    blockedReason:
      reason && reason !== "null" ? (reason as SpecBlockedReason) : null,
  };
}

export function writeSpecFrontMatter(raw: string, fm: SpecFrontMatter): string {
  const existing = parseBlock(raw);
  const body = existing ? existing.body : raw;
  const fields: [string, string][] = [
    ["merged", String(fm.merged)],
    ["blocked_reason", fm.blockedReason ?? "null"],
  ];
  return serializeBlock(fields, body);
}

// skills（mattpocock/skills）產出的檔案沒有 front matter，狀態寫在 body 的
// **Status:** 或 Status: 那一行。粗體與非粗體兩種寫法都要吃（見 DESIGN.md）。

const SKILLS_STATUS = /^\*{0,2}Status:\*{0,2}\s*(\S+)/m;
const SKILLS_BLOCKED_BY = /^\*{0,2}Blocked by:\*{0,2}\s*(.+)$/m;

const SKILLS_STATUS_MAP: Record<string, IssueStatus | "skip"> = {
  "ready-for-agent": "ready",
  "ready-for-human": "human",
  "needs-triage": "draft",
  "needs-info": "draft",
  wontfix: "skip",
};

/**
 * 讀一份沒有 loom front matter 的檔案，嘗試從 skills 的慣例格式推出初始狀態。
 * 回傳 "skip" 代表這個 issue 不該被匯入（wontfix）。什麼都找不到時預設 draft，
 * 因為那正是手寫、什麼標記都沒有的 issue 該落的狀態。
 */
export function importIssueFromSkillsFormat(
  raw: string,
): IssueFrontMatter | "skip" {
  const statusMatch = SKILLS_STATUS.exec(raw);
  const mapped = statusMatch ? SKILLS_STATUS_MAP[statusMatch[1]] : undefined;
  if (mapped === "skip") return "skip";

  const blockedByMatch = SKILLS_BLOCKED_BY.exec(raw);
  const blockedBy =
    blockedByMatch && !/^none$/i.test(blockedByMatch[1].trim())
      ? blockedByMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  return {
    status: mapped ?? "draft",
    e2e: false,
    blockedBy,
  };
}
