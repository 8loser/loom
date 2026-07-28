import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runClaude } from "./claude.ts";

// 這些測試真的會叫 claude CLI（真的花錢/花額度），用最便宜的 haiku 模型、
// 最小的 prompt 控制成本。預設 SKIP，設 ORC_TEST_REAL_CLAUDE=1 才會跑 --
// 不該每次 `npm test` 都燒真的 API 呼叫。
const RUN_REAL = process.env.ORC_TEST_REAL_CLAUDE === "1";
const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "claude-test");
if (RUN_REAL) mkdirSync(scratchRoot, { recursive: true });

function scratchDir(): string {
  return mkdtempSync(join(scratchRoot, "d-"));
}

test("runClaude: schema-constrained call returns parsed structured_output and usage", { skip: !RUN_REAL }, async () => {
  const result = await runClaude({
    cwd: scratchDir(),
    prompt: "Say the sky is blue. Reply using the tool.",
    model: "haiku",
    jsonSchema: {
      type: "object",
      properties: { color: { type: "string" }, confident: { type: "boolean" } },
      required: ["color", "confident"],
    },
    tools: [],
    timeoutMs: 60_000,
  });

  assert.equal(result.outcome, "ok");
  assert.ok(result.sessionId);
  assert.ok(result.usage);
  assert.ok(result.usage!.costUsd > 0);
  assert.deepEqual(result.structuredOutput, { color: "blue", confident: true });
});

test("runClaude: coder-shaped call can actually write a file in cwd via the Write tool", { skip: !RUN_REAL }, async () => {
  const dir = scratchDir();
  const result = await runClaude({
    cwd: dir,
    prompt:
      "Create a file named hello.txt in the current directory containing exactly the text: hello from loom\n" +
      "Then report done via the tool.",
    model: "haiku",
    jsonSchema: {
      type: "object",
      properties: { done: { type: "boolean" }, summary: { type: "string" } },
      required: ["done", "summary"],
    },
    timeoutMs: 60_000,
  });

  assert.equal(result.outcome, "ok");
  const { readFileSync, existsSync } = await import("node:fs");
  assert.ok(existsSync(join(dir, "hello.txt")), "the agent must have actually used the Write tool");
  assert.match(readFileSync(join(dir, "hello.txt"), "utf8"), /hello from loom/);
});

test("runClaude: unknown model name surfaces as infra_fail, not a hang or a throw", { skip: !RUN_REAL }, async () => {
  const result = await runClaude({
    cwd: scratchDir(),
    prompt: "hi",
    model: "definitely-not-a-real-model-xyz",
    tools: [],
    timeoutMs: 30_000,
  });
  assert.equal(result.outcome, "infra_fail");
  assert.ok(result.errorDetail);
});

test("runClaude: nonexistent binary is reported as infra_fail via child 'error' event, not a crash", async () => {
  // doesn't need the real CLI or network access, always runs -- exercises
  // the spawn-failure path directly by pointing PATH somewhere claude isn't.
  const result = await runClaude({
    cwd: process.cwd(),
    prompt: "hi",
    env: { ...process.env, PATH: "/nonexistent" },
    timeoutMs: 5_000,
  });
  assert.equal(result.outcome, "infra_fail");
  assert.match(result.errorDetail ?? "", /spawn error/);
});
