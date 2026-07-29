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
  assert.equal(out, "a=1 b=2 c={c}", "a typo'd variable must stay visible, not silently become empty");
});

test("renderTemplate: a known variable that is undefined becomes empty, not the literal 'undefined'", () => {
  assert.equal(renderTemplate("[{last_failure}]", { last_failure: undefined }), "[]");
});

test("renderTemplate: substituted content is not itself re-scanned for variables", () => {
  // spec.md 裡可能出現 {port} 之類的字樣（例如在說明文字裡），那不該被當成
  // 變數再替換一次 -- String.replace 的單次掃描本來就保證這件事，這個測試
  // 是把它釘住，避免有人改成迴圈式替換。
  const out = renderTemplate("<spec>{spec_md}</spec>", { spec_md: "see {port} below", port: "4300" });
  assert.equal(out, "<spec>see {port} below</spec>");
});

test("every declared variable actually appears in its role's template, and vice versa", () => {
  for (const role of Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]) {
    const template = DEFAULT_TEMPLATES[role];
    const used = new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const declared = new Set(TEMPLATE_VARIABLES[role]);

    for (const name of used) {
      assert.ok(
        declared.has(name),
        `${role} template uses {${name}} but the settings page won't list it as available`,
      );
    }
    // 反向不強制相等：宣告了但預設模板沒用到的變數是刻意的（使用者編輯模板
    // 時可以加進去），所以只檢查「用到的一定有宣告」。
    assert.ok(declared.size > 0, `${role} must declare at least one variable`);
  }
});

test("vendored templates keep the MIT attribution", () => {
  for (const role of Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]) {
    assert.match(
      DEFAULT_TEMPLATES[role],
      /mattpocock\/skills \(MIT, Copyright \(c\) 2026 Matt Pocock\)/,
      `${role} template dropped the attribution the MIT licence requires`,
    );
  }
});

test("the coder template carries the seam rule rewritten for unattended runs", () => {
  // DESIGN.md「攤平時要改的一條規則」：tdd 原文要 agent 跟 user 確認 seam，
  // 無人值守流程裡沒有 user。這個測試釘住那次改寫沒有被還原回去。
  const coder = DEFAULT_TEMPLATES.coder;
  assert.match(coder, /Testing Decisions/, "seams come from the spec, so the template must point at that section");
  assert.doesNotMatch(
    coder,
    /confirm them with the user/i,
    "the original tdd wording asks for human confirmation, which cannot happen here",
  );
});

test("reviewer templates carry the smell baseline vocabulary rather than paraphrasing it", () => {
  // 價值在壓縮過的術語（DESIGN.md「價值在詞彙」）。展開成白話等於把壓縮
  // 效果丟掉，這裡釘住幾個關鍵詞還在。
  const reviewer = DEFAULT_TEMPLATES.issue_reviewer;
  for (const term of ["Feature Envy", "Primitive Obsession", "Speculative Generality", "Shotgun Surgery"]) {
    assert.ok(reviewer.includes(term), `issue_reviewer lost the "${term}" smell`);
  }
  const specReviewer = DEFAULT_TEMPLATES.spec_reviewer;
  for (const term of ["deep module", "Seam", "deletion test"]) {
    assert.ok(specReviewer.toLowerCase().includes(term.toLowerCase()), `spec_reviewer lost "${term}"`);
  }
});
