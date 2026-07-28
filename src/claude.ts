import { spawn } from "node:child_process";
import type { RunUsage } from "./db.ts";

// 形狀是實測出來的（claude 2.1.220，`--output-format json --json-schema ...`），
// 不是查文件猜的。--output-format json 會把整條 session 的所有事件包成一個
// JSON 陣列印出，最後一個 type:"result" 的元素帶完整的 usage/cost/是否出錯。
// 有 --json-schema 時 CLI 會強迫呼叫一個 StructuredOutput 工具，result 事件
// 上同時有 result（JSON 字串）跟 structured_output（已經 parse 好的物件）--
// 用後者，不要自己再 parse 一次。
interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  api_error_status?: string | number | null;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
  result?: string;
  structured_output?: unknown;
}

interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: { status: string; overageStatus?: string; isUsingOverage?: boolean };
}

type StreamEvent = ResultEvent | RateLimitEvent | { type: string; [k: string]: unknown };

export interface ClaudeSpawnOptions {
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  jsonSchema?: object;
  /** 覆寫預設的 --tools（見 createClaudeAgentRunner 裡每個角色給的清單）。 */
  tools?: string[];
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type ClaudeOutcome = "ok" | "infra_fail" | "usage_exhausted";

export interface ClaudeRunResult {
  outcome: ClaudeOutcome;
  sessionId?: string;
  usage?: RunUsage;
  structuredOutput?: unknown;
  /** infra_fail / usage_exhausted 時附上，方便看板顯示與除錯，不是穩定介面。 */
  errorDetail?: string;
}

// DESIGN.md「用量視窗用盡是全域事件」：判定依據是 result 事件的 subtype/
// is_error，加一份 stderr/事件字串比對清單；判定不出來的一律歸 infra_fail
// （安全預設 -- 誤判成 infra 只是多重試三次，誤判成用量用盡會讓整個
// orchestrator 白白停住）。這份清單沒有真的撞到用量上限驗證過，是保守的
// 起點，之後遇到真實案例要回來補。
const USAGE_EXHAUSTION_MARKERS = [
  "usage limit",
  "rate limit",
  "5-hour limit",
  "weekly limit",
  "out_of_credits",
];

// rate_limit_event 只出現在 --output-format json 印整條事件陣列的那個
// 形狀（不帶隔離 flag 時）。production 實際用的 flag 組合下只印最後的
// result 物件，這個函式在那種情況下永遠找不到東西 -- 用量用盡的判定因此
// 實務上全靠 result.is_error + 字串比對那條路徑，不是 rate_limit_event。
function classifyRateLimitEvents(events: StreamEvent[]): boolean {
  return events.some((e) => {
    if (e.type !== "rate_limit_event") return false;
    const info = (e as RateLimitEvent).rate_limit_info;
    return info.status !== "allowed" || info.overageStatus === "rejected";
  });
}

/**
 * 低階 spawn：跑一次 `claude -p`，等它結束，回傳最後的 result 事件。
 * 不做重試、不做角色相關的 prompt 組裝 -- 那些在 agent.ts。
 */
export function runClaude(opts: ClaudeSpawnOptions): Promise<ClaudeRunResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  if (opts.tools) args.push("--tools", opts.tools.join(","));

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          finish({ outcome: "infra_fail", errorDetail: "timed out" });
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      finish({ outcome: "infra_fail", errorDetail: `spawn error: ${err.message}` });
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;

      let events: StreamEvent[];
      try {
        const parsed: unknown = JSON.parse(stdout);
        // 實測發現 --output-format json 的形狀不是恆定的：不帶
        // --setting-sources/--strict-mcp-config/--disable-slash-commands/
        // --permission-mode 時印整個 session 的事件陣列；production 實際
        // 用的參數組合下，印的是「最後那個 result 事件」本身，不包陣列。
        // 兩種都處理，不假設哪一種才是「正常」的。
        events = Array.isArray(parsed) ? parsed : [parsed as StreamEvent];
      } catch {
        const marker = [stdout, stderr].join("\n").toLowerCase();
        if (USAGE_EXHAUSTION_MARKERS.some((m) => marker.includes(m))) {
          finish({ outcome: "usage_exhausted", errorDetail: stderr.slice(-2000) });
        } else {
          finish({
            outcome: "infra_fail",
            errorDetail: `exit ${code}, unparseable output: ${stderr.slice(-2000) || stdout.slice(-2000)}`,
          });
        }
        return;
      }

      const result = events.find((e): e is ResultEvent => e.type === "result");
      if (!result) {
        finish({ outcome: "infra_fail", errorDetail: "no result event in output" });
        return;
      }

      if (classifyRateLimitEvents(events)) {
        finish({
          outcome: "usage_exhausted",
          sessionId: result.session_id,
          errorDetail: "rate_limit_event reported non-allowed status",
        });
        return;
      }

      if (result.is_error) {
        const detail = `${result.subtype} ${result.api_error_status ?? ""}`.trim();
        const marker = detail.toLowerCase();
        const outcome: ClaudeOutcome = USAGE_EXHAUSTION_MARKERS.some((m) => marker.includes(m))
          ? "usage_exhausted"
          : "infra_fail";
        finish({ outcome, sessionId: result.session_id, errorDetail: detail });
        return;
      }

      if (opts.jsonSchema && result.structured_output === undefined) {
        finish({
          outcome: "infra_fail",
          sessionId: result.session_id,
          errorDetail: "schema requested but structured_output missing",
        });
        return;
      }

      finish({
        outcome: "ok",
        sessionId: result.session_id,
        structuredOutput: result.structured_output,
        usage: {
          durationMs: result.duration_ms,
          inputTokens: result.usage.input_tokens,
          cacheReadTokens: result.usage.cache_read_input_tokens,
          cacheCreationTokens: result.usage.cache_creation_input_tokens,
          outputTokens: result.usage.output_tokens,
          costUsd: result.total_cost_usd,
        },
      });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
