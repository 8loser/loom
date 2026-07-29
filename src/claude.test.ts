import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runClaude, decideOutcome, type StreamEvent } from "./claude.ts";

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

// 這一組不叫 CLI，餵的是實測 dump 出來的真實事件形狀（claude 2.1.220,
// stream-json）。存在的理由：overageStatus:"rejected" 曾經被當成用量用盡的
// 判定條件，而它其實是「這個帳號沒開超額付費」的常態設定 -- 一改用
// stream-json，每一次呼叫都會被判成用量用盡，orchestrator 第一次呼叫就停住。
const OK_RESULT: StreamEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  session_id: "s-1",
  total_cost_usd: 0.01,
  duration_ms: 1234,
  usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
  structured_output: { ok: true },
} as StreamEvent;

test("decideOutcome: overageStatus 'rejected' on an allowed run is NOT usage exhaustion", () => {
  const events: StreamEvent[] = [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1785313200,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
      },
    } as StreamEvent,
    OK_RESULT,
  ];

  const result = decideOutcome(events, { type: "object" });
  assert.equal(result?.outcome, "ok", "a fully successful run must not be reported as usage exhaustion");
  assert.equal(result?.usage?.costUsd, 0.01);
});

test("decideOutcome: a genuinely non-allowed status is usage exhaustion", () => {
  const events: StreamEvent[] = [
    { type: "rate_limit_event", rate_limit_info: { status: "rejected" } } as StreamEvent,
    OK_RESULT,
  ];
  assert.equal(decideOutcome(events, undefined)?.outcome, "usage_exhausted");
});

test("decideOutcome: schema requested but no structured_output is infra_fail, not a silent ok", () => {
  const withoutStructured = { ...(OK_RESULT as Record<string, unknown>) };
  delete withoutStructured.structured_output;
  const result = decideOutcome([withoutStructured as StreamEvent], { type: "object" });
  assert.equal(result?.outcome, "infra_fail");
  assert.match(result?.errorDetail ?? "", /structured_output missing/);
});

test("decideOutcome: no result event at all returns null so the caller can fall back to string matching", () => {
  assert.equal(decideOutcome([{ type: "system" } as StreamEvent], undefined), null);
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
