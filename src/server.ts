import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  openDb,
  listWorkspaces,
  insertWorkspace,
  getWorkspace,
  getPrompt,
  getPrompts,
  setPrompt,
  deletePrompt,
  getChatDraft,
  updateWorkspaceSettings,
  type Workspace,
  type WorkspaceSettings,
} from "./db.ts";
import { createClaudeAgentRunner, ROLE_SCHEMAS } from "./agent.ts";
import { DEFAULT_TEMPLATES, TEMPLATE_VARIABLES, type PromptRoleName } from "./prompts.ts";
import { createDevServerTestRunner, readKnownScripts, KNOWN_SCRIPT_NAMES } from "./devserver.ts";
import { sendChatMessage, finalizeChatDraft, stopAllChatProcesses } from "./chat.ts";
import { listBranches } from "./git.ts";
import {
  listSpecs,
  getSpecBoardDetail,
  getWorkspaceSummary,
  attemptMerge,
  redoIssue,
  acknowledgeStale,
  createSpecFromDraft,
  startScheduler,
  createLiveOutputStore,
  type Ctx,
  type Scheduler,
  type AgentRunner,
  type TestRunner,
} from "./orchestrator.ts";

// 看板頁。啟動時讀一次，跟著 server.ts 一起發佈，沒有 build step。改了它要重啟
// server 才生效 -- npm run dev 的 --watch 會自動做這件事。
const UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

// 這個進程的識別碼。server 一重啟（改程式碼、--watch 觸發），瀏覽器的
// EventSource 會自己重連，前端比對這個值就知道背後換了新進程、手上這份
// ui.html 可能過期，該重載。省掉一套獨立的 hot reload 通道。
const BOOT_ID = randomUUID();

interface WorkspaceHandle {
  ctx: Ctx;
  scheduler: Scheduler;
}

function defaultDbPath(): string {
  const dir = join(homedir(), ".loom");
  mkdirSync(dir, { recursive: true });
  return join(dir, "loom.db");
}

type SseSend = (event: string, data: unknown) => void;

function toInt(v: unknown): number | null {
  const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/**
 * 設定頁送上來的值，`PUT /settings` 的 trust boundary。特別是 specsDir：
 * 它會被 join 進 repoPath 再交給 `git add`（見 git.ts 的 commitStateChange），
 * 所以要求解出來的絕對路徑落在 repo 底下 -- 絕對路徑與 `..` 因此一起擋掉。
 * 存回去的是正規化過的相對路徑（`specs/`、`./specs` 都變 `specs`）。
 */
function parseWorkspaceSettings(
  body: Record<string, unknown>,
  repoPath: string,
): { ok: WorkspaceSettings } | { error: string } {
  const root = resolve(repoPath);
  const raw = typeof body.specsDir === "string" ? body.specsDir.trim() : "";
  const abs = raw === "" ? root : resolve(root, raw);
  if (abs === root || !abs.startsWith(root + sep)) {
    return { error: "spec 資料夾要是 repo 底下的相對路徑" };
  }
  const specsDir = relative(root, abs).split(sep).join("/");

  const mainBranch = typeof body.mainBranch === "string" ? body.mainBranch.trim() : "";
  // git 的 refname 規則比這個寬，但寬出來的部分（中文、`@{`、非 ASCII）
  // 在分支名上沒有正當用途，而這個字串會進 git 的參數列。
  if (!/^[\w.][\w./-]*$/.test(mainBranch) || mainBranch.includes("..")) {
    return { error: "主分支只能用英數與 . _ - /，且不以 - 或 / 開頭" };
  }

  const portRangeStart = toInt(body.portRangeStart);
  const portRangeEnd = toInt(body.portRangeEnd);
  if (
    portRangeStart === null || portRangeEnd === null ||
    portRangeStart < 1024 || portRangeEnd > 65535 || portRangeStart > portRangeEnd
  ) {
    return { error: "連線埠要是 1024 到 65535 之間、由小到大的整數" };
  }

  const parallelLimit = toInt(body.parallelLimit);
  if (parallelLimit === null || parallelLimit < 1 || parallelLimit > 16) {
    return { error: "同時執行要是 1 到 16 的整數" };
  }

  return { ok: { specsDir, mainBranch, portRangeStart, portRangeEnd, parallelLimit } };
}

/**
 * spec 資料夾的候選清單。掃兩層就停，也不列 .git / node_modules --
 * 這只是省去手打 `specs`、`docs/specs` 這種常見值，不是檔案總管，而且
 * 資料夾還不存在時仍然要能直接輸入（所以前端用 datalist 不是 select）。
 */
function listSubdirs(root: string, depth = 2, prefix = ""): string[] {
  if (depth === 0) return [];
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      return [path, ...listSubdirs(root, depth - 1, path)];
    });
}

export interface LoomServer {
  app: Hono;
  /** 停掉所有 workspace 的排程器 timer，測試用；正式執行靠 SIGINT/SIGTERM。 */
  stop(): void;
}

export interface CreateServerOptions {
  dbPath?: string;
  /** 覆寫真的 claude -p 呼叫，只給測試用（見 orchestrator.ts 的 worktreesRoot）。 */
  agent?: AgentRunner;
  test?: TestRunner;
  worktreesRoot?: string;
  pollMs?: number;
}

/** app 工廠：不在這裡呼叫 serve()，方便測試用真的 fetch 打，不用真的開 port。 */
export function createServer(opts: CreateServerOptions = {}): LoomServer {
  const db = openDb(opts.dbPath ?? defaultDbPath());
  const handles = new Map<string, WorkspaceHandle>();
  const sseClients = new Set<SseSend>();

  function broadcast(workspace: string): void {
    for (const send of sseClients) send("board-changed", { workspace });
  }

  function registerWorkspace(workspace: Workspace): WorkspaceHandle {
    const ctx: Ctx = {
      db,
      workspace,
      // 每次呼叫才讀 DB，不快取：設定頁改完模板，當前正在重試的那一輪就該
      // 立刻吃到新版（DESIGN.md「不做版本歷史，編輯就是覆蓋」的用途正是這個）。
      agent:
        opts.agent ??
        createClaudeAgentRunner({
          templates: (workspaceId, role) => getPrompt(db, workspaceId, role) ?? DEFAULT_TEMPLATES[role],
        }),
      test: opts.test ?? createDevServerTestRunner(),
      worktreesRoot: opts.worktreesRoot,
      // 每個即時輸出事件都直接觸發 broadcast，讓「即時輸出」名副其實 --
      // board 端點本來就便宜（SQLite 查詢，沒有重運算），這個 tool call
      // 等級的頻率換不到值得另外做節流的成本。
      live: createLiveOutputStore(() => broadcast(workspace.name)),
    };
    const scheduler = startScheduler(ctx, { pollMs: opts.pollMs, onChange: () => broadcast(workspace.name) });
    const handle = { ctx, scheduler };
    handles.set(workspace.name, handle);
    return handle;
  }

  for (const w of listWorkspaces(db)) registerWorkspace(w);

  const app = new Hono();

  app.get("/", (c) => c.html(UI));

  app.get("/api/workspaces", (c) => c.json(listWorkspaces(db)));

  // 新增 workspace 要的是 repo 的絕對路徑，但瀏覽器的資料夾選取（webkitdirectory
  // / showDirectoryPicker）基於安全設計一律不給絕對路徑。server 跟瀏覽器在同一台
  // 機器上，所以改由這裡列目錄，前端拿它做選取器。只回目錄名稱，不碰檔案內容。
  // 不限制可瀏覽的根目錄：POST /api/workspaces 本來就收任意絕對路徑並在那裡跑
  // agent，列目錄名是更小的權限，限制在 homedir 之下反而擋掉 repo 放 /mnt、
  // /srv 的正常用法。前提是 server 綁 127.0.0.1（見檔案最後的 serve()）--
  // 哪天要對外開，這條跟 workspaces 那條都得先有驗證。
  app.get("/api/browse", (c) => {
    const path = resolve(c.req.query("path") || homedir());
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, isRepo: existsSync(join(path, e.name, ".git")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(path);
    return c.json({ path, parent: parent === path ? null : parent, dirs, isRepo: existsSync(join(path, ".git")) });
  });

  app.post("/api/workspaces", async (c) => {
    const body = await c.req.json();
    if (typeof body.name !== "string" || typeof body.repoPath !== "string") {
      return c.json({ error: "name and repoPath are required" }, 400);
    }
    if (handles.has(body.name)) {
      return c.json({ error: "workspace name already exists" }, 409);
    }
    insertWorkspace(db, {
      name: body.name,
      repoPath: body.repoPath,
      specsDir: body.specsDir ?? "specs",
      mainBranch: body.mainBranch ?? "main",
      portRangeStart: body.portRangeStart ?? 4300,
      portRangeEnd: body.portRangeEnd ?? 4399,
      parallelLimit: body.parallelLimit ?? 2,
    });
    const workspace = getWorkspace(db, body.name)!;
    registerWorkspace(workspace);
    return c.json(workspace, 201);
  });

  // 設定頁：四個角色的模板、可用變數、唯讀的輸出 schema，以及這一份是不是
  // 還停在出廠預設（決定「還原預設」要不要 enable）。
  app.get("/api/workspaces/:name/prompts", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const saved = getPrompts(db, handle.ctx.workspace.id);
    const roles = (Object.keys(DEFAULT_TEMPLATES) as PromptRoleName[]).map((role) => ({
      role,
      template: saved[role] ?? DEFAULT_TEMPLATES[role],
      isDefault: saved[role] === undefined,
      variables: TEMPLATE_VARIABLES[role],
      schema: ROLE_SCHEMAS[role],
    }));
    return c.json({ roles });
  });

  app.put("/api/workspaces/:name/prompts/:role", async (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const role = c.req.param("role") as PromptRoleName;
    if (!(role in DEFAULT_TEMPLATES)) return c.json({ error: "no such role" }, 400);
    const body = await c.req.json();
    if (typeof body.template !== "string" || body.template.trim() === "") {
      return c.json({ error: "template must be a non-empty string" }, 400);
    }
    setPrompt(db, handle.ctx.workspace.id, role, body.template);
    return c.json({ ok: true });
  });

  // 還原預設 = 把那一列刪掉，讀取時自然落回內建預設，不是複製一份預設回去。
  app.delete("/api/workspaces/:name/prompts/:role", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const role = c.req.param("role") as PromptRoleName;
    if (!(role in DEFAULT_TEMPLATES)) return c.json({ error: "no such role" }, 400);
    deletePrompt(db, handle.ctx.workspace.id, role);
    return c.json({ ok: true, template: DEFAULT_TEMPLATES[role] });
  });

  // 討論分頁：目前草稿的完整逐字稿，重整頁面用這個還原畫面。真正的對話
  // 歷史活在 claude 那個 session 裡，這裡存的只是給人看的副本。
  app.get("/api/workspaces/:name/chat", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const draft = getChatDraft(db, handle.ctx.workspace.id);
    return c.json({ transcript: draft.transcript });
  });

  app.post("/api/workspaces/:name/chat/messages", async (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const body = await c.req.json();
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    try {
      const result = await sendChatMessage(db, handle.ctx.workspace, body.text);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // 定稿：把目前討論收斂成 spec，寫檔、commit、喚醒排程器。定稿按鈕就是
  // 開跑按鈕（DESIGN.md「chat 產 spec」），沒有另外的 draft review 步驟。
  app.post("/api/workspaces/:name/chat/finalize", async (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    try {
      const { draft, sessionId } = await finalizeChatDraft(db, handle.ctx.workspace);
      const slug = createSpecFromDraft(handle.ctx, draft, sessionId);
      handle.scheduler.wake();
      broadcast(c.req.param("name"));
      return c.json({ slug });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // 設定頁上半部：專案路徑、spec 資料夾、限制，加上兩個純資訊性的檢查項
  // （DESIGN.md「不為詞彙表與規範文件開設定欄位」-- 只看有沒有，不是必填、
  // 也不擋執行），以及從專案 package.json 實際讀到的 loom:* 指令。
  app.get("/api/workspaces/:name/settings", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const ws = handle.ctx.workspace;
    return c.json({
      workspace: ws,
      checks: {
        claudeMd: existsSync(join(ws.repoPath, "CLAUDE.md")),
        contextMd: existsSync(join(ws.repoPath, "CONTEXT.md")),
      },
      // 認得哪些 script 是 devserver.ts 的事，這裡不重寫一份判斷 -- 否則
      // 加一個階段（例如 typecheck）要改兩個地方，而設定頁少列一個沒人會發現。
      scriptNames: KNOWN_SCRIPT_NAMES,
      scripts: readKnownScripts(ws.repoPath),
      // 這兩欄的選項。分支是封閉集合（選單），spec 資料夾可以是還沒建的
      // 新資料夾（可輸入的建議清單）。
      branches: listBranches(ws.repoPath),
      specDirs: listSubdirs(ws.repoPath),
    });
  });

  // 建立後可改的那幾欄（DESIGN.md「資料存放」）。ctx.workspace 是註冊當下的
  // 快照，所以存完要把整個 handle 換掉，否則排程器會繼續用舊的 specsDir。
  // 暫停狀態跟著搬過去 -- 改設定不該順便把停住的 workspace 放出去跑。
  app.put("/api/workspaces/:name/settings", async (c) => {
    const name = c.req.param("name");
    const handle = handles.get(name);
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const parsed = parseWorkspaceSettings(await c.req.json(), handle.ctx.workspace.repoPath);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    // 跑到一半的那一輪攔不住：scheduler.stop() 只清 timer，正在 await 的
    // driveSpec 會拿著舊 ctx 把 spec.md、issue 檔、狀態 commit 寫完，那些
    // 寫入會落在舊的 specsDir。所以要人等這一輪結束，不做中止。
    if (handle.scheduler.isDriving()) {
      return c.json({ error: "有 spec 正在跑，等這一輪結束再改" }, 409);
    }
    updateWorkspaceSettings(db, handle.ctx.workspace.id, parsed.ok);
    const wasPaused = handle.scheduler.isPaused();
    handle.scheduler.stop();
    const next = registerWorkspace(getWorkspace(db, name)!);
    if (wasPaused) next.scheduler.pause();
    broadcast(name);
    return c.json(next.ctx.workspace);
  });

  app.get("/api/workspaces/:name/board", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const specs = listSpecs(handle.ctx).map((spec) => {
      try {
        return getSpecBoardDetail(handle.ctx, spec);
      } catch (err) {
        // 還沒 import（沒有 front matter）或格式不對，board 上顯示出來但不
        // 是排程器該處理的狀態，交給「匯入既有 specs 資料夾」那條路。
        return {
          spec,
          status: "import_needed" as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    return c.json({
      paused: handle.scheduler.isPaused(),
      error: handle.scheduler.getError(),
      summary: getWorkspaceSummary(handle.ctx),
      specs,
    });
  });

  app.post("/api/workspaces/:name/pause", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    handle.scheduler.pause();
    broadcast(c.req.param("name"));
    return c.json({ paused: true });
  });

  app.post("/api/workspaces/:name/resume", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    handle.scheduler.resume();
    broadcast(c.req.param("name"));
    return c.json({ paused: false });
  });

  app.post("/api/workspaces/:name/specs/:spec/merge", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const result = attemptMerge(handle.ctx, c.req.param("spec"));
    broadcast(c.req.param("name"));
    return c.json(result);
  });

  app.post("/api/workspaces/:name/specs/:spec/issues/:issue/redo", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    redoIssue(handle.ctx, c.req.param("spec"), c.req.param("issue"));
    handle.scheduler.wake();
    broadcast(c.req.param("name"));
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:name/specs/:spec/issues/:issue/acknowledge-stale", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    acknowledgeStale(handle.ctx, c.req.param("spec"), c.req.param("issue"));
    broadcast(c.req.param("name"));
    return c.json({ ok: true });
  });

  // 只送「哪個 workspace 變了」，不送完整 board 內容 -- 前端收到後自己重打
  // GET board。這樣漏掉的事件（分頁背景、短暫斷線）不需要補發機制：下一個
  // 事件或重連時的第一次 fetch 自然會拿到最新狀態，不用維護一份事件歷史。
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const send: SseSend = (event, data) => {
        if (stream.closed) return;
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      sseClients.add(send);

      // 自己管的 timer，不用 stream.sleep()：對方斷線時 stream.sleep() 排的
      // setTimeout 不會提早結束，這支 handler 的 promise 會繼續掛到 25 秒
      // 到期才收尾 -- clearTimeout 是唯一能讓它立刻真的解決的辦法。
      let onAborted: () => void;
      const aborted = new Promise<void>((resolve) => {
        onAborted = resolve;
      });
      stream.onAbort(() => {
        sseClients.delete(send);
        onAborted();
      });

      await stream.writeSSE({ event: "connected", data: JSON.stringify({ bootId: BOOT_ID }) });
      while (!stream.closed) {
        const woke = await new Promise<"timer" | "aborted">((resolve) => {
          const timer = setTimeout(() => resolve("timer"), 25_000);
          void aborted.then(() => {
            clearTimeout(timer);
            resolve("aborted");
          });
        });
        if (woke === "aborted") break;
        if (!stream.closed) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });

  return {
    app,
    stop() {
      for (const handle of handles.values()) handle.scheduler.stop();
      stopAllChatProcesses();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4300);
  const loom = createServer();
  const httpServer = serve({ fetch: loom.app.fetch, port, hostname: "127.0.0.1" });
  console.log(`loom listening on http://127.0.0.1:${port}`);
  const shutdown = () => {
    loom.stop();
    // /api/events 的 SSE 連線是長駐的 keep-alive -- Node 的 close() 要等所有
    // 連線自然結束才會呼叫 callback，瀏覽器分頁還開著看板時永遠不會結束，
    // Ctrl+C 就卡住不會真的退出。closeAllConnections 直接砍掉還開著的 socket
    // （見 server.test.ts 的 stopTestServer，這裡是同一個問題的正式執行路徑）。
    // ServerType 涵蓋 http2，其宣告沒有這個方法，但這裡起的一定是
    // node:http 的 Server（serve() 沒有傳 createServer: http2 選項）。
    (httpServer as unknown as { closeAllConnections(): void }).closeAllConnections();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
