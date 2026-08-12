# 提示詞模板 snippet

這份綁的是舊模型（parent/child、`{parent_md}`/`{child_md}` 變數名）。`DESIGN.md` 已改名成 issue group + issue（`{group_md}`/`{issue_md}`）。模板的**結構與策略**仍然有效，變數名與角色稱呼要照新設計改。

---

## 變數替換：認得才換，不認得原樣留著

```ts
export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? (vars[name] ?? "") : whole,
  );
}
```

使用者打錯字時看得到 `{spce_md}` 留在 prompt 裡，比默默替換成空字串好查。已知變數但值是 undefined 才換成空字串。

---

## 一個角色一份模板，不分首次與接手

coder 只有一份模板，`{last_failure}` 為空時那一段就是空的。不另開「重試專用模板」——多一份就多一份要維護的分岔。

---

## schema 不可編輯

`--json-schema` 是狀態轉移的判定依據，改壞了 orchestrator 讀不到 verdict 整條流水線停擺。UI 上顯示為唯讀。prompt 本體改壞了最多品質變差，還救得回來。

---

## 完整 snippet

### `prompts.ts`

```ts
/**
 * 內建提示詞。
 *
 * 這裡是「出廠預設」，設定頁的「還原預設」復原成這一份。實際跑的時候讀的是
 * DB 裡 per-workspace 的那份。
 */

export const CODER_TEMPLATE = `You are implementing exactly one child issue inside a git worktree, unattended.

Read the parent issue and child issue below before changing code. Implement only the requested child issue. Do not solve neighbouring child issues unless this child cannot be completed without a narrow shared change.

If the \`<context>\` block is not empty, treat it as project guidance. Match names and vocabulary to it.

Before finishing:

- Run the relevant typecheck and test commands from \`<scripts>\`.
- Do not modify anything under the .loom/ directory.
- Report whether the child issue is complete, a one-line summary, and the files changed.

<scripts>
{scripts}
</scripts>

<context>
{context_md}
</context>

<parent_issue>
{parent_md}
</parent_issue>

<child_issue>
{child_md}
</child_issue>

<last_failure>
{last_failure}
</last_failure>`;

export const ISSUE_REVIEWER_TEMPLATE = `You are reviewing one completed child issue.

Judge only the diff for this child issue against the parent issue, the child issue, and the project context. Reject if the diff misses required behavior, adds unrelated behavior, leaves obvious defects, or lacks meaningful verification for behavior that should be tested.

If rejecting, return specific comments that the next coder attempt can act on. The next attempt sees your comments, not your private reasoning.

<context>
{context_md}
</context>

<parent_issue>
{parent_md}
</parent_issue>

<child_issue>
{child_md}
</child_issue>

<diff>
{diff}
</diff>`;

export const SPEC_REVIEWER_TEMPLATE = `You are reviewing an entire completed parent issue after all child issues are done.

You do not gate merging. Report comments only; a human decides whether to merge.

Look for cross-child problems: inconsistent behavior, duplicated or conflicting abstractions, dead code left behind by earlier child issues, missed cleanup, and whether the combined diff actually solves the parent issue.

<context>
{context_md}
</context>

<parent_issue>
{parent_md}
</parent_issue>

<diff>
{diff}
</diff>`;

export const CHAT_TEMPLATE = `You are helping a human turn a rough idea into one parent issue and an ordered list of child issues for an unattended pipeline.

You can read the repo to make the discussion concrete. You must not modify any file.

The parent issue should state the problem, the intended outcome, important constraints, testing guidance, and any cross-parent dependencies. Split the work into child issues that are small enough to implement and review one at a time.

For each child issue, include:

- the concrete behavior or change requested;
- any dependency on another child issue;
- whether it needs human judgment before it can run;
- whether it should trigger e2e verification.

<repo>
{repo_path}
</repo>`;

export const DEFAULT_TEMPLATES = {
	coder: CODER_TEMPLATE,
	issue_reviewer: ISSUE_REVIEWER_TEMPLATE,
	spec_reviewer: SPEC_REVIEWER_TEMPLATE,
	chat: CHAT_TEMPLATE,
} as const;

export type PromptRoleName = keyof typeof DEFAULT_TEMPLATES;

/**
 * 設定頁顯示「可用變數」用，也是 renderTemplate 在那個角色會替換的全集。
 *
 * 這裡列的每一個都必須真的有值可填，不是「模板可能會用到的東西」的願望
 * 清單。prompts.test.ts 檢查：模板用到的一定有宣告。
 */
export const TEMPLATE_VARIABLES: Record<PromptRoleName, string[]> = {
	coder: [
		"parent",
		"parent_md",
		"context_md",
		"child_md",
		"last_failure",
		"base_sha",
		"attempt",
		"scripts",
	],
	issue_reviewer: [
		"parent",
		"parent_md",
		"context_md",
		"child_md",
		"diff",
		"base_sha",
		"attempt",
	],
	spec_reviewer: ["parent", "parent_md", "context_md", "diff", "main_branch"],
	chat: ["repo_path"],
};

/**
 * 變數替換。認得的變數才換，不認得的原樣留著 -- 使用者打錯字時看得到
 * `{spce_md}` 留在 prompt 裡，比默默替換成空字串好查。
 */
export function renderTemplate(
	template: string,
	vars: Record<string, string | undefined>,
): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		name in vars ? (vars[name] ?? "") : whole,
	);
}

```

### `prompts.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_TEMPLATES,
	TEMPLATE_VARIABLES,
	renderTemplate,
	type PromptRoleName,
} from "./prompts.ts";

test("renderTemplate: known variables are substituted, unknown ones are left visible", () => {
	const out = renderTemplate("a={a} b={b} c={c}", { a: "1", b: "2" });
	assert.equal(
		out,
		"a=1 b=2 c={c}",
		"a typo'd variable must stay visible, not silently become empty",
	);
});

test("renderTemplate: a known variable that is undefined becomes empty, not the literal 'undefined'", () => {
	assert.equal(
		renderTemplate("[{last_failure}]", { last_failure: undefined }),
		"[]",
	);
});

test("renderTemplate: substituted content is not itself re-scanned for variables", () => {
	// parent 描述裡可能出現 {port} 之類的字樣（例如在說明文字裡），那不該被當成
	// 變數再替換一次 -- String.replace 的單次掃描本來就保證這件事，這個測試
	// 是把它釘住，避免有人改成迴圈式替換。
	const out = renderTemplate("<parent>{parent_md}</parent>", {
		parent_md: "see {port} below",
		port: "4300",
	});
	assert.equal(out, "<parent>see {port} below</parent>");
});

test("every variable a template uses is declared as available", () => {
	for (const role of Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]) {
		const used = new Set(
			[...DEFAULT_TEMPLATES[role].matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
		);
		const declared = new Set(TEMPLATE_VARIABLES[role]);
		for (const name of used) {
			assert.ok(
				declared.has(name),
				`${role} template uses {${name}} but the settings page won't list it as available`,
			);
		}
	}
});

test("default templates are loom-owned and start directly with role instructions", () => {
	for (const role of Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]) {
		assert.doesNotMatch(DEFAULT_TEMPLATES[role], /^\s*<!--/);
	}
});

test("default templates use parent/child issue terminology", () => {
	assert.match(DEFAULT_TEMPLATES.coder, /child issue/);
	assert.match(DEFAULT_TEMPLATES.coder, /parent_issue/);
	assert.match(DEFAULT_TEMPLATES.issue_reviewer, /child issue/);
	assert.match(DEFAULT_TEMPLATES.spec_reviewer, /parent issue/);
	assert.match(DEFAULT_TEMPLATES.chat, /parent issue/);
	assert.match(DEFAULT_TEMPLATES.chat, /child issues/);
});

```
