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
