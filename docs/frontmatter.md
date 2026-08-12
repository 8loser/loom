# front matter snippet

hand-rolled 最小 front matter parser，不引 js-yaml。loom 的 front matter 永遠是 flat string/bool/array-of-strings，欄位集不會長過那個範圍，引套件不值得。

---

## hash body 不 hash 整檔

過期偵測算 hash 的對象是去掉 front matter 後的 body，不是整份檔案。front matter 由 orchestrator 自己寫（`merged: true`、狀態轉移），拿整檔算 hash 的話，按下 merge 那一刻所有 issue 會同時變成「過期」。

```ts
export function bodyOf(raw: string): string {
  return parseBlock(raw)?.body ?? raw;
}
```

---

## 手寫 front matter 回傳新物件，不共用常數

```ts
export function handwrittenFrontMatter(): IssueFrontMatter {
  return { status: "draft", e2e: false, blockedBy: [] };
}
```

是函式不是常數：回傳值會被放進 IssueFile 交出去，共用一份的話所有手寫 issue 的 `blockedBy` 會是同一個陣列，改一個改到全部。

---

## 完整 snippet

### `frontmatter.ts`

```ts
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

/**
 * 人手寫丟進 specs 資料夾的 issue 檔沒有 front matter，loom 補一份最小的
 * 上去（見 DESIGN.md「人手寫的 spec」）。body 裡的任何欄位都不解讀 --
 * 想宣告依賴就自己寫 front matter 的 blocked_by。
 *
 * 是函式不是常數：回傳值會被放進 IssueFile 交出去，共用一份的話所有手寫
 * issue 的 blockedBy 會是同一個陣列。
 */
export function handwrittenFrontMatter(): IssueFrontMatter {
  return { status: "draft", e2e: false, blockedBy: [] };
}

```

### `frontmatter.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readIssueFrontMatter,
  writeIssueFrontMatter,
  readSpecFrontMatter,
  writeSpecFrontMatter,
  bodyOf,
  handwrittenFrontMatter,
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

test("手寫的 issue 補上 draft front matter，body 原封不動", () => {
  const raw = "# 04 split-shared-components\n\n**Status:** ready-for-agent\n\nBlocked by: 02\n";
  const written = writeIssueFrontMatter(raw, handwrittenFrontMatter());
  // body 裡的 Status 與 Blocked by 是別的工具的詞彙，loom 不解讀也不改寫。
  assert.deepEqual(readIssueFrontMatter(written), {
    status: "draft",
    e2e: false,
    blockedBy: [],
  });
  assert.equal(bodyOf(written), raw);
});

```
