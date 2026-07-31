import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { serve, type ServerType } from "@hono/node-server";

import { writeIssueFrontMatter, writeSpecFrontMatter } from "./frontmatter.ts";
import { createServer, type LoomServer } from "./server.ts";
import { DEFAULT_TEMPLATES } from "./prompts.ts";
import { SPECS_DIR, type AgentRunner, type AgentResponse } from "./orchestrator.ts";

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

  const specDir = join(repoPath, SPECS_DIR, "demo");
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
    assert.equal(workspace.mainBranch, "main", "unspecified fields fall back to db.ts defaults");

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
    const insideBody = await inside.json();
    assert.equal(insideBody.isRepo, true);
    // 唯一的用途是選 repo，那個選取器從家目錄開始，全列會被 .cache 那些淹掉。
    // spec 資料夾固定成 .loom/specs 之後沒有第二個呼叫端要看隱藏資料夾。
    assert.equal(
      insideBody.dirs.some((d: { name: string }) => d.name.startsWith(".")),
      false,
      ". 開頭的一律不列",
    );

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
  const specDir = join(repoPath, SPECS_DIR, "demo");
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
      "/api/workspaces/nope/chat/messages",
      "/api/workspaces/nope/chat/finalize",
    ];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, { method: "POST" });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: "no such workspace" }, `${path} must hit a handler, not a route miss`);
    }

    for (const path of ["/api/workspaces/nope/settings", "/api/workspaces/nope/prompts/coder"]) {
      const res = await fetch(`${base}${path}`, { method: "PUT" });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: "no such workspace" }, `${path} must hit a handler, not a route miss`);
    }

    for (const path of ["/api/workspaces/nope/board", "/api/workspaces/nope/settings", "/api/workspaces/nope/prompts", "/api/workspaces/nope/chat"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: "no such workspace" }, `${path} must hit a handler, not a route miss`);
    }
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("prompts: defaults are served until edited, edits stick, reset falls back to the built-in", async () => {
  const repoPath = initRepoWithDraftSpec();
  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  try {
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });

    const initial = await (await fetch(`${base}/api/workspaces/demo-ws/prompts`)).json();
    assert.deepEqual(
      initial.roles.map((r: { role: string }) => r.role),
      ["coder", "issue_reviewer", "spec_reviewer", "chat"],
      "the settings page edits four roles",
    );
    const coder = initial.roles.find((r: { role: string }) => r.role === "coder");
    assert.equal(coder.isDefault, true, "a fresh workspace has no rows in prompts, it reads the built-in");
    assert.equal(coder.template, DEFAULT_TEMPLATES.coder);
    assert.ok(coder.variables.includes("spec_md"));
    assert.deepEqual(
      Object.keys(coder.schema.properties),
      ["done", "summary", "filesChanged"],
      "the output schema is exposed so the page can show it read-only",
    );

    const saved = await fetch(`${base}/api/workspaces/demo-ws/prompts/coder`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "just do it {issue_md}" }),
    });
    assert.equal(saved.status, 200);

    const edited = await (await fetch(`${base}/api/workspaces/demo-ws/prompts`)).json();
    const editedCoder = edited.roles.find((r: { role: string }) => r.role === "coder");
    assert.equal(editedCoder.template, "just do it {issue_md}");
    assert.equal(editedCoder.isDefault, false, "the page uses this to enable 還原預設");

    const reset = await fetch(`${base}/api/workspaces/demo-ws/prompts/coder`, { method: "DELETE" });
    assert.equal((await reset.json()).template, DEFAULT_TEMPLATES.coder);
    const afterReset = await (await fetch(`${base}/api/workspaces/demo-ws/prompts`)).json();
    assert.equal(afterReset.roles.find((r: { role: string }) => r.role === "coder").isDefault, true);

    const empty = await fetch(`${base}/api/workspaces/demo-ws/prompts/coder`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "   " }),
    });
    assert.equal(empty.status, 400, "an empty template would silently break every run");

    const badRole = await fetch(`${base}/api/workspaces/demo-ws/prompts/nope`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "x" }),
    });
    assert.equal(badRole.status, 400);
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("settings: reports repo config, the CLAUDE.md/CONTEXT.md checks, and the project's scripts", async () => {
  const repoPath = initRepoWithDraftSpec();
  writeFileSync(join(repoPath, "CLAUDE.md"), "# project rules\n");
  writeFileSync(
    join(repoPath, "package.json"),
    JSON.stringify({ name: "x", scripts: { dev: "vite", test: "vitest run", build: "tsc" } }),
  );

  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  try {
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });

    const s = await (await fetch(`${base}/api/workspaces/demo-ws/settings`)).json();
    assert.equal(s.workspace.repoPath, repoPath);
    assert.deepEqual(s.checks, { claudeMd: true, contextMd: false });
    assert.deepEqual(
      s.scripts,
      { dev: "vite", test: "vitest run", build: "tsc" },
      "the settings page lists every script the project has, not a loom-specific subset",
    );
    assert.deepEqual(
      s.stages,
      { typecheck: null, test: "test", e2e: null },
      "which script each stage picked comes from testrunner.ts rather than being decided in ui.html",
    );
    // 設定頁把主分支畫成選單，選項得從這裡來。spec 資料夾固定成 .loom/specs
    // 之後不是設定項，所以這個回應裡既沒有那一欄也沒有資料夾清單。
    assert.deepEqual(s.branches, ["main"]);
    assert.equal(s.workspace.specsDir, undefined);
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("settings: 存下可編輯的那幾欄，handle 換掉之後排程器讀到新值", async () => {
  const repoPath = initRepoWithDraftSpec();
  sh(repoPath, "git", ["branch", "release"]);

  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  try {
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });

    const res = await fetch(`${base}/api/workspaces/demo-ws/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mainBranch: "release",
        portRangeStart: 5000,
        portRangeEnd: 5010,
        parallelLimit: 3,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mainBranch, "release");

    const s = await (await fetch(`${base}/api/workspaces/demo-ws/settings`)).json();
    assert.equal(s.workspace.mainBranch, "release");
    assert.equal(s.workspace.portRangeStart, 5000);
    assert.equal(s.workspace.parallelLimit, 3);
    // spec 資料夾固定，不跟著設定跑：看板讀的還是 .loom/specs 底下那個 spec。
    const board = await (await fetch(`${base}/api/workspaces/demo-ws/board`)).json();
    assert.deepEqual(board.specs.map((s: { spec: string }) => s.spec), ["demo"]);
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("settings: rejects a bad branch name and a backwards port range, leaving the stored config alone", async () => {
  const repoPath = initRepoWithDraftSpec();
  const { loom, base, httpServer } = await startTestServer({ agent: stubAgent() });
  try {
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });
    const ok = { mainBranch: "main", portRangeStart: 4300, portRangeEnd: 4399, parallelLimit: 2 };
    const put = (body: Record<string, unknown>) =>
      fetch(`${base}/api/workspaces/demo-ws/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ok, ...body }),
      });

    // mainBranch 這個字串會進 git 的參數列。
    assert.equal((await put({ mainBranch: "-x" })).status, 400);
    assert.equal((await put({ mainBranch: "" })).status, 400);
    assert.equal((await put({ portRangeStart: 5000, portRangeEnd: 4000 })).status, 400);
    assert.equal((await put({ portRangeStart: 80 })).status, 400);
    assert.equal((await put({ parallelLimit: 0 })).status, 400);
    assert.equal((await put({ parallelLimit: 1.5 })).status, 400);

    const s = await (await fetch(`${base}/api/workspaces/demo-ws/settings`)).json();
    assert.equal(s.workspace.mainBranch, "main");
    assert.equal(s.workspace.portRangeStart, 4300);
  } finally {
    await stopTestServer(loom, httpServer);
  }
});

test("settings: refuses to edit while a spec is mid-flight, then accepts once it lands", async () => {
  const repoPath = mkdtempSync(join(scratchRoot, "repo-"));
  sh(repoPath, "git", ["init", "-q", "-b", "main"]);
  sh(repoPath, "git", ["config", "user.email", "t@t"]);
  sh(repoPath, "git", ["config", "user.name", "t"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  const issuesDir = join(repoPath, SPECS_DIR, "demo", "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    join(repoPath, SPECS_DIR, "demo", "spec.md"),
    writeSpecFrontMatter("# demo\n\nproblem statement.\n", { merged: false, blockedReason: null }),
  );
  writeFileSync(
    join(issuesDir, "01-issue.md"),
    writeIssueFrontMatter("# 01 issue\n\ndo the thing.\n", { status: "ready", e2e: false, blockedBy: [] }),
  );
  sh(repoPath, "git", ["add", "-A"]);
  sh(repoPath, "git", ["commit", "-q", "-m", "init"]);

  // 第一次 coder 呼叫卡住不回應，把排程器釘在 driveSpec 裡面 -- 那正是
  // 「有東西正在跑」的狀態，設定不該在這時候被抽換。
  const inner = stubAgent();
  let coderCalled!: () => void;
  const entered = new Promise<void>((r) => { coderCalled = r; });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let firstCall = true;
  const agent: AgentRunner = async (req) => {
    if (req.role === "coder" && firstCall) {
      firstCall = false;
      coderCalled();
      await held;
    }
    return inner(req);
  };

  const { loom, base, httpServer } = await startTestServer({ agent });
  try {
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-ws", repoPath }),
    });
    await entered;

    const body = JSON.stringify({
      mainBranch: "main",
      portRangeStart: 4300,
      portRangeEnd: 4399,
      parallelLimit: 2,
    });
    const busy = await fetch(`${base}/api/workspaces/demo-ws/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(busy.status, 409);

    release();
    await waitFor(async () => {
      const res = await fetch(`${base}/api/workspaces/demo-ws/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      return res.status === 200;
    }, 15_000);
  } finally {
    release();
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
