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
