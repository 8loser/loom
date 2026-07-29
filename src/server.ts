import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  openDb,
  listWorkspaces,
  insertWorkspace,
  getWorkspace,
  getPrompt,
  getPrompts,
  setPrompt,
  deletePrompt,
  type Workspace,
} from "./db.ts";
import { createClaudeAgentRunner, ROLE_SCHEMAS } from "./agent.ts";
import { DEFAULT_TEMPLATES, TEMPLATE_VARIABLES, type PromptRoleName } from "./prompts.ts";
import { createDevServerTestRunner } from "./devserver.ts";
import {
  listSpecs,
  getSpecBoardDetail,
  getWorkspaceSummary,
  attemptMerge,
  redoIssue,
  acknowledgeStale,
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

  function registerWorkspace(workspace: Workspace): void {
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
    handles.set(workspace.name, { ctx, scheduler });
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

  // 設定頁上半部：專案路徑、spec 資料夾、限制，加上兩個純資訊性的檢查項
  // （DESIGN.md「不為詞彙表與規範文件開設定欄位」-- 只看有沒有，不是必填、
  // 也不擋執行），以及從專案 package.json 實際讀到的 loom:* 指令。
  app.get("/api/workspaces/:name/settings", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const ws = handle.ctx.workspace;

    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(ws.repoPath, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([k]) => k.startsWith("loom:")));
    } catch {
      scripts = {};
    }

    return c.json({
      workspace: ws,
      checks: {
        claudeMd: existsSync(join(ws.repoPath, "CLAUDE.md")),
        contextMd: existsSync(join(ws.repoPath, "CONTEXT.md")),
      },
      scripts,
    });
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
  //事件或重連時的第一次 fetch 自然會拿到最新狀態，不用維護一份事件歷史。
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
