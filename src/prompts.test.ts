import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { templateVarsFor } from "./agent.ts";
import type { AgentRequest } from "./orchestrator.ts";
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

test("every variable a template uses is declared as available", () => {
  for (const role of Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]) {
    const used = new Set([...DEFAULT_TEMPLATES[role].matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const declared = new Set(TEMPLATE_VARIABLES[role]);
    for (const name of used) {
      assert.ok(
        declared.has(name),
        `${role} template uses {${name}} but the settings page won't list it as available`,
      );
    }
  }
});

test("every declared variable can actually be filled with a value", () => {
  // 反向：宣告了但 varsFor 填不出值的變數，在設定頁上是騙人的 -- 使用者照著
  // 加進模板只會得到空字串。不強制預設模板都用到（使用者可以自己加進去），
  // 但強制填得出來。
  const request: AgentRequest = {
    role: "coder",
    workspace: {
      id: 1,
      name: "w",
      repoPath: "/nowhere",
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    },
    spec: "demo",
    issue: "01",
    worktreePath: "/nowhere",
    attempt: 1,
  };
  const available = new Set(Object.keys(templateVarsFor(request)));

  for (const role of Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]) {
    for (const name of TEMPLATE_VARIABLES[role]) {
      assert.ok(available.has(name), `${role} advertises {${name}} but agent.ts never supplies it`);
    }
  }
});

test("templateVarsFor: coder gets the worktree's actual package.json scripts, not last checked once", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-prompts-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } }));

  const request: AgentRequest = {
    role: "coder",
    workspace: {
      id: 1,
      name: "w",
      repoPath: "/nowhere",
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    },
    spec: "demo",
    issue: "01",
    worktreePath: dir,
    attempt: 1,
  };

  assert.equal(templateVarsFor(request).scripts, "test: vitest run\nbuild: vite build");
});

test("templateVarsFor: context_md comes from the repo's .loom/context.md, not the worktree's", () => {
  // 專案的 CLAUDE.md 不會被載入，這個檔案是專案規範進得了 prompt 的唯一管道，
  // 而且刻意讀主 checkout 的版本：某條 spec branch 改了規範不該立刻對別條
  // branch 的 coder 生效。兩邊都放檔案，斷言拿到的是 repo 那份。
  const repoPath = mkdtempSync(join(tmpdir(), "loom-ctx-repo-"));
  const worktreePath = mkdtempSync(join(tmpdir(), "loom-ctx-wt-"));
  mkdirSync(join(repoPath, ".loom"), { recursive: true });
  mkdirSync(join(worktreePath, ".loom"), { recursive: true });
  writeFileSync(join(repoPath, ".loom", "context.md"), "from repo");
  writeFileSync(join(worktreePath, ".loom", "context.md"), "from worktree");

  const request: AgentRequest = {
    role: "coder",
    workspace: {
      id: 1,
      name: "w",
      repoPath,
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    },
    spec: "demo",
    issue: "01",
    worktreePath,
    attempt: 1,
  };

  assert.equal(templateVarsFor(request).context_md, "from repo");
});

test("templateVarsFor: a missing .loom/context.md is an empty string, not a crash", () => {
  // 沒有規範檔的專案照樣要跑得起來，模板留一個空的 <context> 區塊就好。
  const dir = mkdtempSync(join(tmpdir(), "loom-ctx-none-"));

  const request: AgentRequest = {
    role: "coder",
    workspace: {
      id: 1,
      name: "w",
      repoPath: dir,
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    },
    spec: "demo",
    issue: "01",
    worktreePath: dir,
    attempt: 1,
  };

  assert.equal(templateVarsFor(request).context_md, "");
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
