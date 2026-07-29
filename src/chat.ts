import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { Db, Workspace } from "./db.ts";
import { getChatDraft, saveChatDraft, type ChatTurn } from "./db.ts";
import { BASE_ISOLATION_FLAGS, decideOutcome, runClaude, type StreamEvent, type ClaudeRunResult } from "./claude.ts";
import { READ_ONLY_TOOLS } from "./agent.ts";

// 沒有新訊息這麼久就優雅收掉常駐 process（見 DESIGN.md「chat 產 spec」：
// 常駐 process 是效能優化 -- 疊在同一個 process 上的每一輪都吃得到 prompt
// cache，實測 --resume 疊加對話拿不到這份 cache -- 不是正確性要求，
// session_id 已經落 DB，逾時關掉之後下一則訊息照樣能靠 --resume 接上，
// 對話從模型角度沒有斷過，只是那一則會重算一次 cache。
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface LiveProcess {
  child: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  turnEvents: StreamEvent[];
  waiting: ((r: ClaudeRunResult) => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 序列化同一個 process 上的多輪呼叫，避免兩個請求同時寫 stdin 對不上輪次。 */
  queue: Promise<unknown>;
}

const liveProcesses = new Map<number, LiveProcess>();

function spawnChatProcess(cwd: string, sessionId: string | null): ChildProcessWithoutNullStreams {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...BASE_ISOLATION_FLAGS,
    "--tools",
    READ_ONLY_TOOLS.join(","),
  ];
  if (sessionId) args.push("--resume", sessionId);
  return spawn("claude", args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
}

function attachReader(workspaceId: number, handle: LiveProcess): void {
  const rl = createInterface({ input: handle.child.stdout });
  rl.on("line", (line) => {
    let event: StreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return; // 非 JSON 的雜訊行，忽略（同 claude.ts 的 runClaudeStreaming）
    }
    handle.turnEvents.push(event);
    if (event.type !== "result") return;
    const outcome = decideOutcome(handle.turnEvents, undefined) ?? {
      outcome: "infra_fail" as const,
      errorDetail: "no result event",
    };
    handle.turnEvents = [];
    if (outcome.sessionId) handle.sessionId = outcome.sessionId;
    handle.waiting?.(outcome);
    handle.waiting = null;
  });
  handle.child.on("close", () => {
    liveProcesses.delete(workspaceId);
    if (handle.idleTimer) clearTimeout(handle.idleTimer);
    handle.waiting?.({ outcome: "infra_fail", errorDetail: "chat process exited" });
  });
}

function resetIdleTimer(handle: LiveProcess): void {
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => handle.child.stdin.end(), IDLE_TIMEOUT_MS);
}

function getOrSpawn(workspaceId: number, cwd: string, sessionId: string | null): LiveProcess {
  const existing = liveProcesses.get(workspaceId);
  if (existing) return existing;
  const handle: LiveProcess = {
    child: spawnChatProcess(cwd, sessionId),
    sessionId,
    turnEvents: [],
    waiting: null,
    idleTimer: null,
    queue: Promise.resolve(),
  };
  attachReader(workspaceId, handle);
  liveProcesses.set(workspaceId, handle);
  return handle;
}

function runTurn(handle: LiveProcess, text: string): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    handle.waiting = resolve;
    const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    handle.child.stdin.write(line + "\n");
  });
}

export interface ChatMessageResult {
  reply: string;
  transcript: ChatTurn[];
}

/**
 * 送一輪訊息給討論用的常駐 session：第一次呼叫現生一個 process（DB 有記錄
 * 過 session_id 就帶 --resume 接續），之後同一個 workspace 重複用同一個
 * process。process 閒置逾時或意外死掉都不算資料遺失 -- 下一則訊息量測不到
 * 活的 process 就用 --resume 補一個新的，對話從模型角度是連續的。
 */
export async function sendChatMessage(
  db: Db,
  workspace: Pick<Workspace, "id" | "repoPath">,
  message: string,
): Promise<ChatMessageResult> {
  const draft = getChatDraft(db, workspace.id);
  const handle = getOrSpawn(workspace.id, workspace.repoPath, draft.sessionId);

  const turn = handle.queue.then(() => runTurn(handle, message));
  handle.queue = turn;
  const outcome = await turn;
  resetIdleTimer(handle);

  if (outcome.outcome !== "ok") {
    throw new Error(outcome.errorDetail ?? "討論呼叫失敗");
  }

  const now = Date.now();
  const transcript: ChatTurn[] = [
    ...draft.transcript,
    { role: "user", text: message, at: now },
    { role: "assistant", text: outcome.text ?? "", at: now },
  ];
  saveChatDraft(db, workspace.id, { sessionId: handle.sessionId, transcript });
  return { reply: outcome.text ?? "", transcript };
}

/**
 * 定稿前一定要先把常駐 process 收乾淨再等它真的結束（`close`，不是叫了
 * `stdin.end()` 就當作已經結束）-- 實測發現常駐 process 還握著這個 session
 * 時，另一個 process 對同一個 session_id 下 `--resume` 會拿到「找不到這個
 * session」，不是排隊等待。兩個 process 不能同時碰同一個 session。
 */
function endLiveProcess(workspaceId: number): Promise<void> {
  const handle = liveProcesses.get(workspaceId);
  if (!handle) return Promise.resolve();
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  return new Promise((resolve) => {
    handle.child.once("close", () => resolve());
    handle.child.stdin.end();
  });
}

/** server 關閉時優雅收掉所有討論 process，不留孤兒；等到真的都結束才 resolve。 */
export async function stopAllChatProcesses(): Promise<void> {
  await Promise.all([...liveProcesses.keys()].map((id) => endLiveProcess(id)));
}

export interface DraftIssue {
  title: string;
  body: string;
  /** 引用同一份草稿裡其他 issue 的 title -- 定稿時還沒有最終編號，orchestrator 落地時才轉成 id。 */
  blockedBy: string[];
  e2e: boolean;
  needsHuman: boolean;
}

export interface SpecDraft {
  slug: string;
  specMd: string;
  issues: DraftIssue[];
}

// 拆 issue 在同一輪對話裡做，落地時才疊一次 --json-schema 呼叫拿結構化內容
// （DESIGN.md「chat 產 spec」）。跟一般對話輪共用同一個 session（--resume），
// 不是另外派一個 agent，所以不重講一次前情。
const CHAT_FINALIZE_SCHEMA = {
  type: "object",
  properties: {
    slug: { type: "string" },
    spec_md: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          blocked_by: { type: "array", items: { type: "string" } },
          e2e: { type: "boolean" },
          needs_human: { type: "boolean" },
        },
        required: ["title", "body", "blocked_by", "e2e", "needs_human"],
      },
    },
  },
  required: ["slug", "spec_md", "issues"],
};

interface FinalizePayload {
  slug: string;
  spec_md: string;
  issues: { title: string; body: string; blocked_by: string[]; e2e: boolean; needs_human: boolean }[];
}

/**
 * 定稿：疊一次 --resume + --json-schema 的一次性呼叫（不經過常駐 process），
 * 把目前的討論收斂成 {slug, spec_md, issues[]}。orchestrator 負責把這個
 * 結果寫成檔案、編號、commit -- 這裡只管跟 LLM 要內容。
 */
export async function finalizeChatDraft(
  db: Db,
  workspace: Pick<Workspace, "id" | "repoPath">,
): Promise<{ draft: SpecDraft; sessionId: string }> {
  const draft = getChatDraft(db, workspace.id);
  if (!draft.sessionId) throw new Error("討論還沒開始，沒有內容可以定稿");
  await endLiveProcess(workspace.id);

  const result = await runClaude({
    cwd: workspace.repoPath,
    resumeSessionId: draft.sessionId,
    prompt:
      "把目前討論出的內容整理成最終的 spec 與 issue 清單，照 schema 回報。issue 要照執行順序排列。",
    jsonSchema: CHAT_FINALIZE_SCHEMA,
    tools: READ_ONLY_TOOLS,
  });

  if (result.outcome !== "ok" || result.structuredOutput === undefined) {
    throw new Error(result.errorDetail ?? "定稿失敗");
  }
  const payload = result.structuredOutput as FinalizePayload;

  return {
    sessionId: result.sessionId ?? draft.sessionId,
    draft: {
      slug: payload.slug,
      specMd: payload.spec_md,
      issues: payload.issues.map((i) => ({
        title: i.title,
        body: i.body,
        blockedBy: i.blocked_by,
        e2e: i.e2e,
        needsHuman: i.needs_human,
      })),
    },
  };
}
