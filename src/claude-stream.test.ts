import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runClaude, type LiveEvent } from "./claude.ts";

// 跟 claude.test.ts 同樣的約定：真的叫 claude CLI，真的花額度，預設 SKIP，
// 設 ORC_TEST_REAL_CLAUDE=1 才跑。這支存在的理由是 stream-json 的事件形狀
// 只查過文件沒實測過（見 DESIGN.md「觀測」），而看板的即時輸出整個建立在
// 那個形狀上 -- 文件跟實際輸出對不上的話，這裡是唯一會抓到的地方。
const RUN_REAL = process.env.ORC_TEST_REAL_CLAUDE === "1";
const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "claude-stream-test");
if (RUN_REAL) mkdirSync(scratchRoot, { recursive: true });

test(
  "stream-json: onEvent fires with real say/read events while the run is still going, and the final result still parses",
  { skip: !RUN_REAL, timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(scratchRoot, "d-"));
    writeFileSync(join(dir, "note.txt"), "the sky is green\n");

    const events: LiveEvent[] = [];
    const result = await runClaude({
      cwd: dir,
      prompt: "Read note.txt and report its exact contents via the tool. Say what you are about to do first.",
      model: "haiku",
      jsonSchema: {
        type: "object",
        properties: { contents: { type: "string" } },
        required: ["contents"],
      },
      timeoutMs: 90_000,
      onEvent: (e) => events.push(e),
    });

    // 一次性 JSON 路徑該有的東西，串流路徑一樣要有 -- 兩條路徑共用
    // decideOutcome，這裡確認共用真的成立。
    assert.equal(result.outcome, "ok", result.errorDetail);
    assert.ok(result.sessionId);
    assert.ok(result.usage && result.usage.costUsd > 0, "usage/cost comes off the final result event");
    assert.match(String((result.structuredOutput as { contents?: string })?.contents ?? ""), /sky is green/);

    // 這是本測試存在的核心理由：事件真的有解析出來。全空代表文件講的形狀
    // 跟 CLI 實際吐的不一樣，看板的即時輸出就是空的。
    assert.ok(events.length > 0, "no live events parsed at all -- the stream-json shape does not match what claude.ts expects");

    const kinds = new Set(events.map((e) => e.kind));
    assert.ok(kinds.has("read"), `expected a Read tool_use event, got kinds: ${[...kinds].join(", ")}`);
    assert.ok(
      events.some((e) => e.kind === "read" && e.text === "note.txt"),
      `Read's file_path should be relativised against cwd, got: ${JSON.stringify(events.filter((e) => e.kind === "read").map((e) => e.text))}`,
    );
    assert.ok(events.every((e) => e.at > 0 && typeof e.text === "string"));
  },
);
