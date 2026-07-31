import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openDb, insertWorkspace, type Workspace } from "./db.ts";
import { writeIssueFrontMatter, writeSpecFrontMatter } from "./frontmatter.ts";
import { runUntilIdle, loadIssues, SPECS_DIR, type Ctx, type TestRunner } from "./orchestrator.ts";
import { createClaudeAgentRunner } from "./agent.ts";

// 真的端到端：真的 claude -p 當 coder 跟 issue_reviewer，真的 git worktree，
// 只有 testing 階段（loom:test/e2e 的執行本身）維持 stub，那是另一塊還沒做
// 的範圍（dev server、port 分配）。花真的錢，預設 SKIP，設
// ORC_TEST_REAL_CLAUDE=1 才跑。用 haiku 壓低成本，任務刻意設計得很小。
const RUN_REAL = process.env.ORC_TEST_REAL_CLAUDE === "1";
const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "e2e-real-test");
if (RUN_REAL) mkdirSync(scratchRoot, { recursive: true });

function sh(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function stubTest(): TestRunner {
  return {
    async runIssueTests() {
      return { pass: true, output: "" };
    },
    async runSpecE2E() {
      return { pass: true, output: "" };
    },
  };
}

test(
  "real claude -p end to end: one trivial issue goes ready -> done via a real coder and a real reviewer",
  { skip: !RUN_REAL, timeout: 5 * 60_000 },
  async () => {
    const repoPath = mkdtempSync(join(scratchRoot, "repo-"));
    sh(repoPath, "git", ["init", "-q", "-b", "main"]);
    sh(repoPath, "git", ["config", "user.email", "t@t"]);
    sh(repoPath, "git", ["config", "user.name", "t"]);
    writeFileSync(join(repoPath, "README.md"), "demo repo\n");

    const specDir = join(repoPath, SPECS_DIR, "greeting");
    const issuesDir = join(specDir, "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      join(specDir, "spec.md"),
      writeSpecFrontMatter(
        [
          "# greeting",
          "",
          "## Problem Statement",
          "The repo has no greeting file.",
          "",
          "## Solution",
          "Add a plain text file with a fixed greeting.",
          "",
          "## Testing Decisions",
          "No tests needed -- this is a static text file, not behavior.",
        ].join("\n"),
        { merged: false, blockedReason: null },
      ),
    );
    writeFileSync(
      join(issuesDir, "01-add-greeting-file.md"),
      writeIssueFrontMatter(
        [
          "# 01 add-greeting-file",
          "",
          "Create a file named `greeting.txt` at the repo root containing exactly",
          "this text on a single line, nothing else:",
          "",
          "    hello from loom",
        ].join("\n"),
        { status: "ready", e2e: false, blockedBy: [] },
      ),
    );
    sh(repoPath, "git", ["add", "-A"]);
    sh(repoPath, "git", ["commit", "-q", "-m", "init"]);

    const db = openDb(":memory:");
    const id = insertWorkspace(db, {
      name: "e2e-real",
      repoPath,
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    });
    const workspace: Workspace = {
      id,
      name: "e2e-real",
      repoPath,
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    };

    const agent = createClaudeAgentRunner({ model: "haiku" });
    const ctx: Ctx = { db, workspace, agent, test: stubTest() };

    const results = await runUntilIdle(ctx, "greeting");
    console.log("steps:", results.map((r) => `${r.status}${r.note ? ` (${r.note})` : ""}`));

    const issues = loadIssues(ctx, "greeting");
    assert.equal(issues[0].status, "done", `expected done, steps were: ${JSON.stringify(results)}`);

    const wt = join(repoPath, ".loom", "worktrees", "greeting");
    const greetingPath = join(wt, "greeting.txt");
    assert.ok(existsSync(greetingPath), "the real coder must have actually created the file");
    assert.match(readFileSync(greetingPath, "utf8"), /hello from loom/);

    const runs = db
      .prepare("SELECT role, outcome, cost_usd FROM runs ORDER BY id")
      .all() as { role: string; outcome: string; cost_usd: number | null }[];
    assert.ok(runs.length >= 2, "must have logged at least a coder and a reviewer run");
    for (const r of runs) {
      if (r.role !== "test") assert.ok((r.cost_usd ?? 0) >= 0, `${r.role} run should have a cost recorded`);
    }
  },
);
