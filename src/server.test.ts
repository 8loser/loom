import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { serve, type ServerType } from "@hono/node-server";

import { writeIssueFrontMatter, writeSpecFrontMatter } from "./frontmatter.ts";
import { createServer, type LoomServer } from "./server.ts";
import type { AgentRunner, AgentResponse } from "./orchestrator.ts";

// 只測 HTTP/SSE 這一層的接線：workspace CRUD、board 讀模型、merge/redo 動作
// 觸發 SSE、排程器真的把一個 ready issue 推到 done。orchestrator 本身的狀態
// 機邏輯（重試、失敗分類、聚合順序……）已經在 orchestrator.test.ts 覆蓋，
// 這裡用同一支 stub agent 換掉真的 claude -p，不重複驗證那些規則，只驗證
// 「排程器真的會自己動、REST 看得到、SSE 真的會推」。
const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "server-test");
mkdirSync(scratchRoot, { recursive: true });

function sh(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

const USAGE = {
  durationMs: 10,
  inputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 1,
  costUsd: 0.0001,
};

function stubAgent(): AgentRunner {
  return async (req) => {
    if (req.role === "coder") {
      writeFileSync(join(req.worktreePath, "output.txt"), "done\n");
      const resp: AgentResponse = {
        outcome: "ok",
        usage: USAGE,
        coder: { done: true, summary: "did it", filesChanged: ["output.txt"] },
      };
      return resp;
    }
    if (req.role === "issue_reviewer") {
      const resp: AgentResponse = { outcome: "ok", usage: USAGE, issueReview: { verdict: "pass", comments: [] } };
      return resp;
    }
    const resp: AgentResponse = { outcome: "ok", usage: USAGE, specReview: { comments: [] } };
    return resp;
  };
}

/** repo 上先鋪一個 draft 狀態的 issue -- 排程器看到不會派工，安全地測 board/CRUD 而不驚動任何 agent。 */
function initRepoWithDraftSpec(): string {
  const repoPath = mkdtempSync(join(scratchRoot, "repo-"));
  sh(repoPath, "git", ["init", "-q", "-b", "main"]);
  sh(repoPath, "git", ["config", "user.email", "t@t"]);
  sh(repoPath, "git", ["config", "user.name", "t"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");

  const specDir = join(repoPath, "specs", "demo");
  const issuesDir = join(specDir, "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    join(specDir, "spec.md"),
    writeSpecFrontMatter("# demo\n\nproblem statement.\n", { merged: false, blockedReason: null }),
  );
  writeFileSync(
    join(issuesDir, "01-issue.md"),
    writeIssueFrontMatter("# 01 issue\n\nnot finalized yet.\n", { status: "draft", e2e: false, blockedBy: [] }),
  );
  sh(repoPath, "git", ["add", "-A"]);
  sh(repoPath, "git", ["commit", "-q", "-m", "init"]);
  return repoPath;
}

async function startTestServer(
  overrides: Parameters<typeof createServer>[0] = {},
): Promise<{ loom: LoomServer; base: string; httpServer: ServerType }> {
  const loom = createServer({
    dbPath: ":memory:",
    worktreesRoot: mkdtempSync(join(scratchRoot, "worktrees-")),
    pollMs: 30,
    ...overrides,
  });
  let httpServer!: ServerType;
  const port = await new Promise<number>((resolve) => {
    httpServer = serve({ fetch: loom.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
  });
  return { loom, base: `http://127.0.0.1:${port}`, httpServer };
}

function stopTestServer(loom: LoomServer, httpServer: ServerType): Promise<void> {
  loom.stop();
  // SSE 連線是長駐的 keep-alive -- Node 的 close() 要等所有連線自然結束才會
  // resolve，client 端 abort() 是否即時反映到 server 端的 socket 不保證，
  // 測試不該賭那個時序。closeAllConnections 直接砍掉還開著的 socket。
  // @hono/node-server 的 ServerType 型別涵蓋 http2，其宣告沒有這個方法，
  // 但這裡起的一定是 node:http 的 Server（沒有傳 createServer: http2 選項）。
  (httpServer as unknown as { closeAllConnections(): void }).closeAllConnections();
  return new Promise((resolve) => httpServer.close(() => resolve()));
}

test("workspace CRUD: create then list", async () => {
  const repoPath = initRepoWithDraftSpec();
  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  try {
    const created = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });
    assert.equal(created.status, 201);
    const workspace = await created.json();
    assert.equal(workspace.name, "demo-ws");
    assert.equal(workspace.specsDir, "specs", "unspecified fields fall back to db.ts defaults");

    const listed = await fetch(`${base}/api/workspaces`);
    const workspaces = await listed.json();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, "demo-ws");

    const dup = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });
    assert.equal(dup.status, 409);
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("browse lists sub-directories and flags which ones are git repos", async () => {
  const repoPath = initRepoWithDraftSpec();
  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  try {
    const res = await fetch(`${base}/api/browse?path=${encodeURIComponent(dirname(repoPath))}`);
    const body = await res.json();
    assert.equal(body.path, resolve(dirname(repoPath)), "回的是 resolve 過的絕對路徑");
    const entry = body.dirs.find((d: { name: string }) => d.name === basename(repoPath));
    assert.ok(entry, "the repo we just created shows up under its parent");
    assert.equal(entry.isRepo, true, ".git is what marks a directory as pickable");

    const inside = await fetch(`${base}/api/browse?path=${encodeURIComponent(repoPath)}`);
    assert.equal((await inside.json()).isRepo, true);

    const missing = await fetch(`${base}/api/browse?path=${encodeURIComponent(join(repoPath, "no-such-dir"))}`);
    assert.equal(missing.status, 400, "unreadable path is an error, not an empty listing");
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("board reflects a draft issue and the scheduler leaves it alone (no agent call)", async () => {
  const repoPath = initRepoWithDraftSpec();
  let calls = 0;
  const countingAgent: AgentRunner = async (req) => {
    calls++;
    return stubAgent()(req);
  };
  const { loom, base, httpServer } = await startTestServer({ agent: countingAgent });
  try {
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });

    // 給排程器兩個 poll 週期的時間，確認它真的跑過但沒有動任何東西。
    await new Promise((r) => setTimeout(r, 100));

    const board = await (await fetch(`${base}/api/workspaces/demo-ws/board`)).json();
    assert.equal(board.paused, false);
    assert.equal(board.specs.length, 1);
    assert.equal(board.specs[0].status, "draft");
    assert.equal(calls, 0, "draft issue must never reach the agent");
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("end to end: scheduler drives a ready issue to done on its own, board and SSE both see it", async () => {
  const repoPath = mkdtempSync(join(scratchRoot, "repo-"));
  sh(repoPath, "git", ["init", "-q", "-b", "main"]);
  sh(repoPath, "git", ["config", "user.email", "t@t"]);
  sh(repoPath, "git", ["config", "user.name", "t"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  const specDir = join(repoPath, "specs", "demo");
  const issuesDir = join(specDir, "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    join(specDir, "spec.md"),
    writeSpecFrontMatter("# demo\n\nproblem statement.\n", { merged: false, blockedReason: null }),
  );
  writeFileSync(
    join(issuesDir, "01-issue.md"),
    writeIssueFrontMatter("# 01 issue\n\ndo the thing.\n", { status: "ready", e2e: false, blockedBy: [] }),
  );
  sh(repoPath, "git", ["add", "-A"]);
  sh(repoPath, "git", ["commit", "-q", "-m", "init"]);

  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  const controller = new AbortController();
  let reader: Promise<void> | undefined;
  try {
    const events: { event: string | undefined; data: string }[] = [];
    reader = (async () => {
      const res = await fetch(`${base}/api/events`, { signal: controller.signal });
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body!) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1] ?? "";
          events.push({ event, data });
        }
      }
    })().catch(() => {});

    // 必須先確定 SSE 真的連上（收到 connected）才建 workspace -- stub agent
    // 幾乎零延遲，driveSpec 可能在 SSE 連線建立前就把整個 spec 跑完，順序
    // 反過來會讓 board-changed 事件在還沒人訂閱時就發生，永遠等不到。
    await waitFor(() => events.some((e) => e.event === "connected"));

    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });

    await waitFor(async () => {
      const board = await (await fetch(`${base}/api/workspaces/demo-ws/board`)).json();
      return board.specs[0]?.status === "mergeable";
    }, 15_000);

    const board = await (await fetch(`${base}/api/workspaces/demo-ws/board`)).json();
    assert.equal(board.specs[0].issues[0].status, "done");
    assert.equal(board.specs[0].status, "mergeable");

    // 用 waitFor 而不是立刻斷言：board 從 REST 讀到 mergeable 跟 SSE reader
    // 把對應的 board-changed 事件解析進 events 陣列是兩條獨立路徑，中間有
    // 微小的排程時間差，立刻比對會是假陽性的 race。
    await waitFor(() =>
      events.some((e) => e.event === "board-changed" && JSON.parse(e.data).workspace === "demo-ws"),
    );

    const merged = await (
      await fetch(`${base}/api/workspaces/demo-ws/specs/demo/merge`, { method: "POST" })
    ).json();
    assert.deepEqual(merged, { merged: true });
  } finally {
    // reader 的 fetch 內部已經 catch 掉 abort 造成的錯誤，這裡只是確保它
    // 真的收尾，不管 try 區塊是正常結束還是中途斷言失敗 -- 否則失敗路徑會
    // 留下一個沒 await 的 pending promise，讓 node --test 卡住不退出。
    controller.abort();
    await reader;
    await stopTestServer(loom, httpServer);
  }
});

test("GET / serves the board page, and every endpoint that page calls is a real route", async () => {
  const { loom, base, httpServer } = await startTestServer();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /id="grid"/, "ui.html must actually be the thing being served");
    assert.match(html, /new EventSource\("\/api\/events"\)/);

    // 這份清單是 ui.html 打得出來的每一種 URL 形狀，手動同步。改 route 而
    // 忘了改 ui.html（或反過來）時，這裡會看到 Hono 的 route-miss 404 而不是
    // handler 自己回的 {"error":"no such workspace"}，測試就紅。
    const paths = [
      "/api/workspaces/nope/pause",
      "/api/workspaces/nope/resume",
      "/api/workspaces/nope/specs/s/merge",
      "/api/workspaces/nope/specs/s/issues/01/redo",
      "/api/workspaces/nope/specs/s/issues/01/acknowledge-stale",
    ];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, { method: "POST" });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: "no such workspace" }, `${path} must hit a handler, not a route miss`);
    }

    const board = await fetch(`${base}/api/workspaces/nope/board`);
    assert.equal(board.status, 404);
    assert.deepEqual(await board.json(), { error: "no such workspace" });
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: condition never became true");
}
