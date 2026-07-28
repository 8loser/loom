import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { openDb, listWorkspaces, insertWorkspace, getWorkspace, type Workspace } from "./db.ts";
import { createClaudeAgentRunner, DEFAULT_PROMPTS } from "./agent.ts";
import {
  listSpecs,
  getSpecBoard,
  attemptMerge,
  redoIssue,
  acknowledgeStale,
  startScheduler,
  type Ctx,
  type Scheduler,
  type AgentRunner,
  type TestRunner,
} from "./orchestrator.ts";

// ponytail: 真的 dev server 生命週期（loom:test/loom:e2e、port 分配）還沒做
// （見 DESIGN.md「dev server 生命週期」），testing 階段先全部當綠燈通過，
// 讓 doTest 這條路徑走得通。等那塊做了在這裡換掉就好，orchestrator 不用動。
const stubTestRunner: TestRunner = {
  async runIssueTests() {
    return { pass: true, output: "" };
  },
  async runSpecE2E() {
    return { pass: true, output: "" };
  },
};

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
      agent: opts.agent ?? createClaudeAgentRunner(DEFAULT_PROMPTS),
      test: opts.test ?? stubTestRunner,
      worktreesRoot: opts.worktreesRoot,
    };
    const scheduler = startScheduler(ctx, { pollMs: opts.pollMs, onChange: () => broadcast(workspace.name) });
    handles.set(workspace.name, { ctx, scheduler });
  }

  for (const w of listWorkspaces(db)) registerWorkspace(w);

  const app = new Hono();

  app.get("/", (c) => c.json({ ok: true, workspaces: handles.size }));

  app.get("/api/workspaces", (c) => c.json(listWorkspaces(db)));

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

  app.get("/api/workspaces/:name/board", (c) => {
    const handle = handles.get(c.req.param("name"));
    if (!handle) return c.json({ error: "no such workspace" }, 404);
    const specs = listSpecs(handle.ctx).map((spec) => {
      try {
        return getSpecBoard(handle.ctx, spec);
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
    return c.json({ paused: handle.scheduler.isPaused(), error: handle.scheduler.getError(), specs });
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

      await stream.writeSSE({ event: "connected", data: "{}" });
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
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
