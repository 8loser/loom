# 從 Node 呼叫 claude code agent

這份是實測紀錄，不是官方文件。所有行為都標了實測版本；CLI 升版要回來複驗。

實測環境：claude CLI `2.1.220` / `2.1.221`，訂閱制（OAuth，非 API key），Node 24。

---

## 兩條呼叫路徑

`claude -p` 兩種輸出格式，對應兩種使用情境：

| 格式 | flag | 什麼時候用 |
| --- | --- | --- |
| 一次性 JSON | `--output-format json` | 呼叫結束才需要結果（coder、reviewer、chat 定稿） |
| 逐行串流 | `--output-format stream-json --verbose` | 過程中要即時顯示 agent 在做什麼（看板即時輸出） |

兩者最後都會有一個 `type: "result"` 事件，帶 usage/cost/是否出錯。差別只在串流版「過程事件」會逐行進來，一次性版整包最後才 parse。

### 一次性 JSON 的形狀不是恆定的

`--output-format json` 吐的不一定是陣列。實測兩種形狀都會出現：

- 整個 session 的事件陣列
- 只有最後那個 result 事件本身、不包陣列

成因是使用者層設定 `verbose: true` 會被載入。兩種都得處理：

```ts
const parsed = JSON.parse(stdout);
const events = Array.isArray(parsed) ? parsed : [parsed];
```

### 串流版要配 `--verbose`

沒加 `--verbose` 的話 `stream-json` 不會吐 `assistant` 事件，逐行解析收不到 agent 的說話與工具呼叫。這顆 flag 不是 debug 開關，是串流路徑必要的。

---

## `--json-schema` 與 StructuredOutput 工具

帶 `--json-schema '{...}'` 時，CLI 會**強迫 agent 呼叫一個名叫 `StructuredOutput` 的工具**回報結果。result 事件上同時有：

- `result`：JSON 字串
- `structured_output`：已經 parse 好的物件

用後者，不要自己再 parse 一次。

陷阱：`StructuredOutput` 是 loom 自己要求的回報機制，不是 agent 在做事。即時輸出要過濾掉它，不然會把 structured output 的完整內容洩到看板上。

```ts
const REPORTING_TOOL = "StructuredOutput";
// 只轉發非 StructuredOutput 的 tool_use 事件
if (b.type === "tool_use" && b.name && b.name !== REPORTING_TOOL) { ... }
```

---

## 隔離 flag 基底集合

每次呼叫都帶這組，目的是把 agent 的環境收窄到只剩 loom 的提示詞控制：

```ts
const BASE_ISOLATION_FLAGS = [
  "--setting-sources", "user",       // 只載入使用者層，專案層不載入
  "--strict-mcp-config",              // 不載入任何 MCP
  "--disable-slash-commands",
  "--permission-mode", "bypassPermissions",
];
```

### `--setting-sources` 的實測矩陣

探針放在獨立 HOME 底下，用 hook 自己 touch 的標記檔判定是否觸發（不靠 agent 自述）：

| setting-sources | 全域 CLAUDE.md | 專案 CLAUDE.md |
| --- | --- | --- |
| 預設（不帶） | 載入 | 載入 |
| `user` | 載入 | 不載入 |
| `project` | 載入 | 載入 |
| `project,local` | 載入 | 載入 |
| `""` | 不載入 | 不載入 |

選 `user` 的理由：專案那側 agent 看到什麼只由 loom 的提示詞決定（`.loom/context.md` 是唯一管道），使用者層則是這台機器擁有者對所有 agent 的偏好，刻意讓它進來。

### 這顆 flag 是整層開關，不是 CLAUDE.md 的開關

`user` 之下 `~/.claude/` 的 hook、permissions、env、skills 四項全部一起進來，沒辦法只挑一項。

兩個會咬人的細節：

- **`permissions.deny` 在 `bypassPermissions` 之下照樣生效。** bypass 只跳過詢問，不跳過 deny。個人 deny 清單擋掉的路徑 coder 一樣讀不到，症狀只會表現成品質變差，不會標成權限問題。
- **個人 hook 對每個 coder 生效。** 流水線行為因此掛在一個不在版控裡、也不在任何 run 記錄裡的檔案上。agent 反覆失敗時要往那裡查。

### 使用者層的固定開銷

同一組 flag、`--tools ""` 的空白呼叫實測：

- `--setting-sources ""`：3297 token
- `--setting-sources user`：5862 token

差額 +2565 token，主要來自全域 CLAUDE.md 與 `~/.claude/skills/` 清單。每次呼叫都付。

### 版本陷阱

舊註記（2.1.220）寫 `project,local` 不載入全域 CLAUDE.md。2.1.221 實測是載入的。要縮回「什麼都不載入」是把值改回 `""`，不是改成 `local`。

---

## `--resume`：在同一個 session 上疊一輪

`--resume <session_id>` 接續既有 session，不重講前情。chat 定稿用：先在常駐對話裡討論，結束常駐 process 後，用一次性呼叫 `--resume` 疊一輪 `--json-schema` 拿結構化輸出。

兩個限制：

- **`--resume` 也綁 cwd。** 同一個 session 用不同 cwd 去 resume 會「找不到這個 session」。
- **兩個 process 不能同時碰同一個 session。** 定稿前一定要先把常駐 process 完全結束（等 `close` 事件，不是叫了 `stdin.end()` 就當結束），再 `--resume`。

---

## result 事件的用量與成本

最後那個 `type: "result"` 事件帶完整帳：

```ts
interface ResultEvent {
  type: "result";
  subtype: string;          // "success" 等
  is_error: boolean;
  api_error_status?: string | number | null;
  session_id: string;
  total_cost_usd: number;   // 這一次呼叫的美元成本
  duration_ms: number;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
  result?: string;           // 純文字回覆（沒帶 schema 時靠這個）
  structured_output?: unknown; // 已 parse 的物件（帶 schema 時用這個）
}
```

訂閱制照樣回傳 cost，不是空的。

---

## 判定 outcome：ok / infra_fail / usage_exhausted

三條規則，由上而下：

```ts
// 1. rate_limit_event 報非 allowed 狀態 → usage_exhausted
// 2. result.is_error → 看 subtype 字串，撞到用量關鍵字算 usage_exhausted，否則 infra_fail
// 3. 帶了 schema 但沒 structured_output → infra_fail（schema 沒被履行）
// 4. 否則 ok
```

### rate_limit_event 的兩個陷阱

串流版每次呼叫都會吐 `rate_limit_event`，它的欄位很容易被誤判：

**陷阱一：`overageStatus: "rejected"` 是常態，不是用量用盡。**

```json
{
  "status": "allowed",
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "overageDisabledReason": "out_of_credits",
  "isUsingOverage": false
}
```

`overageStatus:"rejected"` 只代表這個帳號沒開超額付費。曾經把它當判定條件，結果一改用 stream-json，每次呼叫都被判成用量用盡，orchestrator 第一次呼叫就停住。

**陷阱二：`status: "allowed_warning"` 還是 allowed。**

```json
{
  "status": "allowed_warning",
  "rateLimitType": "five_hour",
  "utilization": 0.93,
  "surpassedThreshold": 0.9
}
```

這是「快到 5 小時視窗門檻了」的提醒，呼叫本身完全成功。只認字面 `"allowed"` 會誤判。

結論：**只看 `status`，而且只認 `"allowed"` 與 `"allowed_warning"` 兩個值。** 真的撞到上限時 status 會是什麼值還沒有樣本，所以維持保守預設：判不出來走 `infra_fail`（重試三次），不是 `usage_exhausted`（整條停住）。

### 為什麼保守預設是 infra_fail

誤判成本不對稱：

- 誤判成 infra_fail：多重試三次，浪費一點額度
- 誤判成 usage_exhausted：整個 orchestrator 停住等人，半夜用完額度會看到一整排停住的 issue

落在保守那一邊。

### 沒有 result 事件的收尾

串流被中斷、stdout parse 不了時，靠 stderr 字串比對猜用量用盡：

```ts
const USAGE_EXHAUSTION_MARKERS = [
  "usage limit", "rate limit", "5-hour limit", "weekly limit",
];
```

刻意**不放 `out_of_credits`**：它是 rate_limit_event 的 overageDisabledReason 值，而那個事件每次呼叫都會出現，放進清單會把正常輸出誤判成用量用盡。

buffered 路徑可以比對 stdout（stdout 本身就是錯誤訊息）；串流路徑**不能比對 stdout**（那是一堆合法 JSON 事件行，rate_limit_event 每次都有，撞上就誤判）。

---

## stdin 餵 prompt

prompt 走 stdin，不走 command line argument。避免 shell escape 與 argument 長度限制：

```ts
child.stdin.write(opts.prompt);
child.stdin.end();
```

---

## 逾時與 process 清理

逾時用 `SIGKILL` 整個 process 收掉，不是送 SIGTERM 等它自己關。agent 超時被殺、自己崩掉、忘記 kill，spawn 出來的東西會變孤兒佔住 port，症狀出現在下一個不相干的 group 上。

```ts
const timeout = opts.timeoutMs
  ? setTimeout(() => {
      child.kill("SIGKILL");
      finish({ outcome: "infra_fail", errorDetail: "timed out" });
    }, opts.timeoutMs)
  : null;
```

finish 用 `settled` 旗標保證只 resolve 一次：逾時與 close 可能都觸發，不能讓 promise 被 resolve 兩次。

---

## 完整 snippet

以下是未刪減的實作，註解完整保留。不是 production-ready 函式庫，是「這些行為實測過、這樣寫會動」的參照。

### `claude.ts`

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// 一次 claude 呼叫的用量與成本紀錄。原本放在 db.ts，清架構時跟 claude 整合
// 收在一起（純型別，零執行期影響）。
export interface RunUsage {
	durationMs: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
	costUsd: number;
}

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
	rate_limit_info: {
		status: string;
		overageStatus?: string;
		isUsingOverage?: boolean;
	};
}

export type StreamEvent =
	| ResultEvent
	| RateLimitEvent
	| { type: string; [k: string]: unknown };

// 看板「即時輸出」用的事件粒度：一個 assistant 內容區塊一筆，不追蹤
// token-level 的 partial delta（沒帶 --include-partial-messages），也不等
// tool_result 回來 -- 呼叫本身發生的當下就夠讓人看懂 agent 在幹嘛，等結果
// 只是多一層狀態要追蹤（tool_use_id 對應），換不到看板需要的東西。
// "port" 不是 claude 產生的，是 testrunner.ts 把這一輪分配到的 PORT 交給測試
// 指令時發的（看板要顯示「連線埠」欄位）。共用同一條管線是因為它跟工具呼叫
// 一樣是「這一輪 run 期間發生的事」，另外拉一條 store 只為了一個數字不划算。
export type LiveEventKind =
	| "say"
	| "read"
	| "edit"
	| "bash"
	| "search"
	| "tool"
	| "port";

export interface LiveEvent {
	at: number;
	kind: LiveEventKind;
	text: string;
}

export interface ClaudeSpawnOptions {
	cwd: string;
	prompt: string;
	jsonSchema?: object;
	/** 覆寫預設的 --tools（見 createClaudeAgentRunner 裡每個角色給的清單）。 */
	tools?: string[];
	model?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** 接續既有 session（`claude --resume`），用於 chat 定稿：不重講一次前情
	 * 就能疊加一次 --json-schema 呼叫拿結構化輸出（實測見 claude-stream.test.ts）。 */
	resumeSessionId?: string;
	/**
	 * 有給的話改叫 `--output-format stream-json` 逐行解析，每個 assistant
	 * 內容區塊（說話或呼叫工具）即時回呼一次；沒給就維持 `--output-format
	 * json` 一次性解析的既有路徑，行為完全不變。事件形狀跟這裡用的隔離 flag
	 * 組合都實測過（`claude-stream.test.ts`，預設 SKIP）。解析失敗的行直接
	 * 略過，不影響 result 事件的判讀（見 runClaudeStreaming）。
	 */
	onEvent?: (event: LiveEvent) => void;
}

export type ClaudeOutcome = "ok" | "infra_fail" | "usage_exhausted";

export interface ClaudeRunResult {
	outcome: ClaudeOutcome;
	sessionId?: string;
	usage?: RunUsage;
	structuredOutput?: unknown;
	/** result 事件的純文字回覆。沒帶 --json-schema 的呼叫（chat 的一般對話輪）
	 * 靠這個拿回覆內容；帶了 schema 的呼叫該用 structuredOutput，不必理會這欄。 */
	text?: string;
	/** infra_fail / usage_exhausted 時附上，方便看板顯示與除錯，不是穩定介面。 */
	errorDetail?: string;
}

// DESIGN.md「用量視窗用盡是全域事件」：判定依據是 result 事件的 subtype/
// is_error，加一份 stderr/事件字串比對清單；判定不出來的一律歸 infra_fail
// （安全預設 -- 誤判成 infra 只是多重試三次，誤判成用量用盡會讓整個
// orchestrator 白白停住）。這份清單沒有真的撞到用量上限驗證過，是保守的
// 起點，之後遇到真實案例要回來補。
//
// 這裡刻意不放 out_of_credits：它是 rate_limit_event 的 overageDisabledReason
// 值，而那個事件在每一次成功的 stream-json 呼叫裡都會出現（見下面
// classifyRateLimitEvents 的實測樣本）。放進來的話，任何沒印出 result 事件
// 就結束的 stream 都會因為 stdout 裡有這個字串而被判成用量用盡。
const USAGE_EXHAUSTION_MARKERS = [
	"usage limit",
	"rate limit",
	"5-hour limit",
	"weekly limit",
];

// 只看 status。實測（claude 2.1.220，stream-json）一次完全成功的呼叫長這樣：
//
//   { status: "allowed", rateLimitType: "five_hour", resetsAt: ...,
//     overageStatus: "rejected", overageDisabledReason: "out_of_credits",
//     isUsingOverage: false }
//
// overageStatus:"rejected" 只代表這個帳號沒有開啟超額付費，是常態設定，跟
// 用量用不用得完無關 -- 曾經把它當成判定條件，結果是每一次呼叫都被判成用量
// 用盡。--output-format json 的路徑看不到 rate_limit_event 所以沒事，一改用
// stream-json 就會讓整個 orchestrator 在第一次呼叫就停住（DESIGN.md「誤判成
// 用量用盡會讓整個 orchestrator 白白停住」講的正是這個）。
//
// 第二個實測樣本（帳號當時用到 five_hour 視窗 93%）：
//
//   { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: ...,
//     utilization: 0.93, isUsingOverage: false, surpassedThreshold: 0.9 }
//
// 呼叫本身 is_error:false、subtype:success，跟真的 "allowed" 沒有兩樣，只是
// 多一個「快到門檻了」的提醒。原本只認字面 "allowed" 一種值的話，這裡會被
// 誤判成用量用盡 -- 跟 overageStatus:"rejected" 曾經犯過的是同一種錯：把
// 「還在可用範圍內的附加資訊」當成了「不可用」。
//
// 真的撞到上限時 status 會是什麼值還沒有樣本，所以維持保守預設：判不出來就
// 讓它走 infra_fail（重試三次），不是 usage_exhausted（整條停住）。
const ALLOWED_RATE_LIMIT_STATUSES = ["allowed", "allowed_warning"];

function classifyRateLimitEvents(events: StreamEvent[]): boolean {
	return events.some((e) => {
		if (e.type !== "rate_limit_event") return false;
		return !ALLOWED_RATE_LIMIT_STATUSES.includes(
			(e as RateLimitEvent).rate_limit_info.status,
		);
	});
}

// 兩個 spawn 路徑（一次性 JSON / 逐行 stream-json）跑完都會走到「有沒有
// result 事件」這個判斷 -- 抽出來共用，不是各自重寫一遍用量用盡/is_error/
// schema 缺漏這三條規則。
export function decideOutcome(
	events: StreamEvent[],
	jsonSchema: object | undefined,
): ClaudeRunResult | null {
	const result = events.find((e): e is ResultEvent => e.type === "result");
	if (!result) return null;

	if (classifyRateLimitEvents(events)) {
		return {
			outcome: "usage_exhausted",
			sessionId: result.session_id,
			errorDetail: "rate_limit_event reported non-allowed status",
		};
	}

	if (result.is_error) {
		const detail = `${result.subtype} ${result.api_error_status ?? ""}`.trim();
		const marker = detail.toLowerCase();
		const outcome: ClaudeOutcome = USAGE_EXHAUSTION_MARKERS.some((m) =>
			marker.includes(m),
		)
			? "usage_exhausted"
			: "infra_fail";
		return { outcome, sessionId: result.session_id, errorDetail: detail };
	}

	if (jsonSchema && result.structured_output === undefined) {
		return {
			outcome: "infra_fail",
			sessionId: result.session_id,
			errorDetail: "schema requested but structured_output missing",
		};
	}

	return {
		outcome: "ok",
		sessionId: result.session_id,
		structuredOutput: result.structured_output,
		text: result.result,
		usage: {
			durationMs: result.duration_ms,
			inputTokens: result.usage.input_tokens,
			cacheReadTokens: result.usage.cache_read_input_tokens,
			cacheCreationTokens: result.usage.cache_creation_input_tokens,
			outputTokens: result.usage.output_tokens,
			costUsd: result.total_cost_usd,
		},
	};
}

/**
 * 沒有 result 事件可判的收尾路徑，靠字串比對猜是不是用量用盡。
 *
 * `matchStdout` 只有 buffered 路徑該開：那裡的 stdout 是一坨 parse 不了的
 * 東西，本身就是錯誤訊息。stream-json 路徑的 stdout 是一堆合法的 JSON 事件
 * 行，把它丟進字串比對等於拿 CLI 的正常輸出去猜錯誤 -- `rate_limit_event`
 * 每次呼叫都會出現，比對清單只要有一個詞撞上就會誤判成用量用盡、讓整個
 * orchestrator 停住。
 */
function decideUnparseableOutcome(
	stdout: string,
	stderr: string,
	code: number | null,
	matchStdout: boolean,
): ClaudeRunResult {
	const marker = (
		matchStdout ? [stdout, stderr].join("\n") : stderr
	).toLowerCase();
	if (USAGE_EXHAUSTION_MARKERS.some((m) => marker.includes(m))) {
		return { outcome: "usage_exhausted", errorDetail: stderr.slice(-2000) };
	}
	return {
		outcome: "infra_fail",
		errorDetail: `exit ${code}, no result event: ${stderr.slice(-2000) || stdout.slice(-2000)}`,
	};
}

// 隔離 flag 的基底集合，跟 chat.ts 的長駐雙向 process 共用 -- 兩邊都得
// 用同一份設定來源（DESIGN.md「agent 繼承什麼環境」），只有一份維護，不是
// 兩份可能漂移的複本。
//
// `--setting-sources user` 只載入使用者層（`~/.claude/`），專案層不載入。
// 分界是：專案那側 agent 看到什麼只由 loom 的提示詞決定（`.loom/context.md`
// 是唯一管道），使用者層則是這台機器的擁有者對所有 agent 的偏好，刻意讓它
// 進來。
//
// 實測（claude 2.1.221，探針放在一個獨立的 HOME 底下，hook 是否觸發用它
// 自己 touch 出來的標記檔判定，不靠 agent 自述）：
//
//   | setting-sources | 全域 CLAUDE.md | 專案 CLAUDE.md |
//   |-----------------|----------------|----------------|
//   | 預設（不帶）    | 載入           | 載入           |
//   | user            | 載入           | 不載入         |
//   | project         | 載入           | 載入           |
//   | project,local   | 載入           | 載入           |
//   | ""              | 不載入         | 不載入         |
//
// 這顆 flag 是整層開關，不是 CLAUDE.md 的開關：`user` 之下 `~/.claude/` 的
// hook、`permissions`、`env`、`skills/` 四項全部一起進來（`""` 之下四項全部
// 沒有）。兩個會咬人的細節：
//   - `permissions.deny` 在 `--permission-mode bypassPermissions` 之下照樣
//     生效，bypass 只跳過詢問。個人 deny 清單擋掉的路徑 coder 一樣讀不到，
//     而症狀只會表現成品質變差，不會標成權限問題。
//   - 個人 hook 對每個 coder 生效。流水線行為因此掛在一個不在版控裡、也不
//     在任何 run 記錄裡的檔案上，agent 反覆失敗時要往那裡查。
//
// 使用者層的固定開銷實測 +2565 token（同一組 flag、`--tools ""` 的空白呼叫，
// 3297 -> 5862）。
//
// 舊註記（2.1.220）寫 `project,local` 不載入全域 CLAUDE.md，2.1.221 實測是
// 載入的。要縮回「什麼都不載入」是把值改回 `""`，不是改成 `local`。
export const BASE_ISOLATION_FLAGS = [
	"--setting-sources",
	"user",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--permission-mode",
	"bypassPermissions",
];

function isolationArgs(opts: ClaudeSpawnOptions): string[] {
	const args = [...BASE_ISOLATION_FLAGS];
	if (opts.model) args.push("--model", opts.model);
	if (opts.jsonSchema)
		args.push("--json-schema", JSON.stringify(opts.jsonSchema));
	if (opts.tools) args.push("--tools", opts.tools.join(","));
	if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
	return args;
}

/**
 * 兩條路徑（一次性 JSON / 逐行 stream-json）共用的 spawn 外殼：逾時、
 * spawn 失敗、只 settle 一次、把 prompt 寫進 stdin。差別只有 stdout 怎麼收
 * （整份 buffer vs 逐行）與收完怎麼判，那兩件事由呼叫端給。
 */
interface SpawnHandlers {
	onStdout(child: ChildProcessWithoutNullStreams): void;
	onClose(code: number | null, stderr: string): ClaudeRunResult;
}

function spawnClaude(
	opts: ClaudeSpawnOptions,
	formatArgs: string[],
	handlers: SpawnHandlers,
): Promise<ClaudeRunResult> {
	const args = ["-p", ...formatArgs, ...isolationArgs(opts)];

	return new Promise((resolve) => {
		const child = spawn("claude", args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stderr = "";
		let settled = false;
		const finish = (result: ClaudeRunResult): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(result);
		};

		const timeout = opts.timeoutMs
			? setTimeout(() => {
					child.kill("SIGKILL");
					finish({ outcome: "infra_fail", errorDetail: "timed out" });
				}, opts.timeoutMs)
			: null;

		handlers.onStdout(child);
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (err) =>
			finish({
				outcome: "infra_fail",
				errorDetail: `spawn error: ${err.message}`,
			}),
		);
		child.on("close", (code) => {
			if (settled) return;
			finish(handlers.onClose(code, stderr));
		});

		child.stdin.write(opts.prompt);
		child.stdin.end();
	});
}

/**
 * 低階 spawn：跑一次 `claude -p`，等它結束，回傳最後的 result 事件。
 * 不做重試、不做角色相關的 prompt 組裝 -- 那些在 agent.ts。
 */
export function runClaude(opts: ClaudeSpawnOptions): Promise<ClaudeRunResult> {
	return opts.onEvent
		? runClaudeStreaming(opts, opts.onEvent)
		: runClaudeBuffered(opts);
}

function runClaudeBuffered(opts: ClaudeSpawnOptions): Promise<ClaudeRunResult> {
	let stdout = "";
	return spawnClaude(opts, ["--output-format", "json"], {
		onStdout: (child) => child.stdout.on("data", (chunk) => (stdout += chunk)),
		onClose: (code, stderr) => {
			let events: StreamEvent[];
			try {
				const parsed: unknown = JSON.parse(stdout);
				// 實測發現 --output-format json 的形狀不是恆定的：印整個 session 的
				// 事件陣列，或只印「最後那個 result 事件」本身、不包陣列。成因是
				// 設定裡的 verbose -- 改用 --setting-sources user 之後，使用者層
				// 的 "verbose": true 會被載入，同一組 flag 也會變成陣列形狀。
				// 兩種都處理，不假設哪一種才是「正常」的。
				events = Array.isArray(parsed) ? parsed : [parsed as StreamEvent];
			} catch {
				return decideUnparseableOutcome(stdout, stderr, code, true);
			}
			return (
				decideOutcome(events, opts.jsonSchema) ??
				decideUnparseableOutcome(stdout, stderr, code, true)
			);
		},
	});
}

// 實測確認 Read/Edit/Write 的 file_path 是絕對路徑，看板顯示成相對於
// worktree 比較好讀。resolve 是因為呼叫端不保證給絕對路徑（測試會給相對）。
function relPath(cwd: string, p: unknown): string {
	if (typeof p !== "string") return String(p ?? "");
	const base = resolve(cwd);
	return p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
}

// ponytail: Edit/Write 只顯示檔名，不算真的 +/- 行數（要嘛自己實作 diff
// 演算法要嘛每次多 spawn 一個 git diff，兩者都換不到「看得懂 agent 在幹嘛」
// 這個目標）；搜尋只顯示 pattern，不等 tool_result 回來算命中數。要補的話
// 是在編輯事件的檔名後面接上 +N / -M。
function describeToolUse(
	cwd: string,
	name: string,
	input: Record<string, unknown>,
): { kind: LiveEventKind; text: string } {
	switch (name) {
		case "Read":
			return { kind: "read", text: relPath(cwd, input.file_path) };
		case "Edit":
		case "Write":
			return { kind: "edit", text: relPath(cwd, input.file_path) };
		case "Bash": {
			const cmd = String(input.command ?? "");
			const firstLine = cmd.split("\n")[0];
			return {
				kind: "bash",
				text: firstLine.length < cmd.length ? `${firstLine} …` : firstLine,
			};
		}
		case "Grep":
		case "Glob":
			return {
				kind: "search",
				text: String(input.pattern ?? input.query ?? ""),
			};
		default:
			return { kind: "tool", text: name };
	}
}

// --json-schema 會強迫 agent 呼叫這個工具回報結果。它是 loom 自己要求的，
// 不是 agent 在做事，出現在即時輸出上只是雜訊（而且會把 structured output
// 的完整內容洩到看板上）。thinking 區塊同理不轉發：內容常常是空的，而且那
// 不是「做了什麼」。
const REPORTING_TOOL = "StructuredOutput";

function emitLiveEvents(
	cwd: string,
	message: unknown,
	onEvent: (event: LiveEvent) => void,
): void {
	const content = (message as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return;
	const at = Date.now();
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as {
			type?: string;
			text?: string;
			name?: string;
			input?: Record<string, unknown>;
		};
		if (b.type === "text" && b.text) {
			onEvent({ at, kind: "say", text: b.text });
		} else if (b.type === "tool_use" && b.name && b.name !== REPORTING_TOOL) {
			onEvent({ at, ...describeToolUse(cwd, b.name, b.input ?? {}) });
		}
	}
}

function runClaudeStreaming(
	opts: ClaudeSpawnOptions,
	onEvent: (event: LiveEvent) => void,
): Promise<ClaudeRunResult> {
	const events: StreamEvent[] = [];
	let stdoutRaw = "";
	return spawnClaude(opts, ["--output-format", "stream-json", "--verbose"], {
		onStdout: (child) => {
			const rl = createInterface({ input: child.stdout });
			rl.on("line", (line) => {
				stdoutRaw += line + "\n";
				let event: StreamEvent;
				try {
					event = JSON.parse(line);
				} catch {
					return; // 非 JSON 的雜訊行，忽略；用量用盡的保底判定仍靠 stderr 字串比對
				}
				events.push(event);
				if (event.type === "assistant") {
					emitLiveEvents(
						opts.cwd,
						(event as { message?: unknown }).message,
						onEvent,
					);
				}
			});
		},
		onClose: (code, stderr) =>
			decideOutcome(events, opts.jsonSchema) ??
			decideUnparseableOutcome(stdoutRaw, stderr, code, false),
	});
}

```

### `claude.test.ts`（含實測 fixture）

```ts
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

test("decideOutcome: status 'allowed_warning' (near the 5-hour window threshold) is NOT usage exhaustion", () => {
  // 實測樣本：帳號當時用到 five_hour 視窗 93%，呼叫本身完全成功
  // （is_error:false, subtype:success），只是多一個「快到門檻了」的提醒。
  const events: StreamEvent[] = [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1785313200,
        rateLimitType: "five_hour",
        utilization: 0.93,
        isUsingOverage: false,
        surpassedThreshold: 0.9,
      },
    } as StreamEvent,
    OK_RESULT,
  ];

  const result = decideOutcome(events, { type: "object" });
  assert.equal(result?.outcome, "ok", "allowed_warning is still an allowed call, not exhaustion");
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

test("decideOutcome: no schema requested surfaces the plain-text reply via `text` (chat's ordinary turns have no --json-schema)", () => {
  const plainReply: StreamEvent = { ...(OK_RESULT as Record<string, unknown>), result: "hello back" } as StreamEvent;
  delete (plainReply as Record<string, unknown>).structured_output;
  const result = decideOutcome([plainReply], undefined);
  assert.equal(result?.outcome, "ok");
  assert.equal(result?.text, "hello back");
  assert.equal(result?.structuredOutput, undefined);
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

```

### `claude-stream.test.ts`（串流形狀實測）

```ts
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

```
