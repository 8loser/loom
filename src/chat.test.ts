import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { openDb, insertWorkspace, getChatDraft } from "./db.ts";
import { sendChatMessage, finalizeChatDraft, stopAllChatProcesses } from "./chat.ts";

// 這些測試真的會叫常駐的 claude -p session（真的花錢/花額度）。跟
// claude.test.ts 同一套規矩：預設 SKIP，設 ORC_TEST_REAL_CLAUDE=1 才會跑。
const RUN_REAL = process.env.ORC_TEST_REAL_CLAUDE === "1";
const scratchRoot = join(process.env.CLAUDE_JOB_DIR ?? ".", "tmp", "chat-test");
if (RUN_REAL) mkdirSync(scratchRoot, { recursive: true });

function sh(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const repoPath = mkdtempSync(join(scratchRoot, "repo-"));
  sh(repoPath, "git", ["init", "-q", "-b", "main"]);
  sh(repoPath, "git", ["config", "user.email", "t@t"]);
  sh(repoPath, "git", ["config", "user.name", "t"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  sh(repoPath, "git", ["add", "-A"]);
  sh(repoPath, "git", ["commit", "-q", "-m", "init"]);
  return repoPath;
}

function initWorkspace(name: string) {
  const db = openDb(":memory:");
  const repoPath = initRepo();
  const id = insertWorkspace(db, {
    name,
    repoPath,
    specsDir: "specs",
    mainBranch: "main",
    portRangeStart: 4300,
    portRangeEnd: 4399,
    parallelLimit: 2,
  });
  return { db, workspace: { id, repoPath } };
}

test(
  "sendChatMessage: the second turn remembers the first (same long-lived process, no --resume needed)",
  { skip: !RUN_REAL },
  async () => {
    // liveProcesses（chat.ts）是模組層級的 singleton，只用 workspace.id 當
    // key -- 每個測試各自的 :memory: db 的 id 都從 1 起算，前一個測試留下的
    // 常駐 process 會被下一個測試撞到同一個 key。正式環境只有一份 db，id
    // 不會重複，這個清理只是測試需要。
    await stopAllChatProcesses();
    const { db, workspace } = initWorkspace("w1");

    const first = await sendChatMessage(db, workspace, "記住這個字：banana。不要用任何工具，回我「記住了」就好。");
    assert.match(first.reply, /記住了/);

    const second = await sendChatMessage(db, workspace, "我剛才要你記的字是什麼？只回那個字，不要加其他文字。");
    assert.match(second.reply, /banana/i);

    const draft = getChatDraft(db, workspace.id);
    assert.equal(draft.transcript.length, 4);
    assert.ok(draft.sessionId);
  },
);

test(
  "sendChatMessage: cannot write files even via Bash (--tools whitelist excludes Bash, not just Write/Edit)",
  { skip: !RUN_REAL },
  async () => {
    await stopAllChatProcesses();
    const { db, workspace } = initWorkspace("w2");

    await sendChatMessage(
      db,
      workspace,
      "用任何你能用的方式在目前目錄建一個檔案 test.txt。如果做不到，直接說做不到，不要嘗試繞路。",
    );

    assert.ok(!existsSync(join(workspace.repoPath, "test.txt")));
  },
);

test(
  "finalizeChatDraft: resumes the discussion without re-explaining it and returns a schema-shaped spec draft",
  { skip: !RUN_REAL },
  async () => {
    await stopAllChatProcesses();
    const { db, workspace } = initWorkspace("w3");

    await sendChatMessage(
      db,
      workspace,
      "我想加一個 issue：把 README.md 的問候語從 hello 改成 hi。只要這一件事，不用 needs_human。",
    );

    const { draft, sessionId } = await finalizeChatDraft(db, workspace);
    assert.ok(sessionId);
    assert.ok(draft.slug.length > 0);
    assert.ok(draft.issues.length >= 1);
  },
);
