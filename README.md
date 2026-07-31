# loom

狀態機驅動的本地多 Agent 編排系統。設計說明見 `DESIGN.md`。

## 需求

- Node.js >= 24（用到原生 TypeScript 執行與 `node:sqlite`，不需要 build step）
- `claude` CLI 已安裝並登入（agent 執行靠 `claude -p`）
- `git`

## 啟動

```bash
npm install
npm start                 # 預設 http://127.0.0.1:4300
PORT=5000 npm start       # 換 port
```

開瀏覽器到 `http://127.0.0.1:4300` 看看板。狀態存在 `~/.loom/loom.db`，worktree 開在 `~/.loom/worktrees/`。

## 新增 workspace

在看板頁按「新增 workspace」（已經有 workspace 時是選單旁的 `+`），用「瀏覽…」選 repo 資料夾，含 `.git` 的會標記出來。

也可以用 API：

```bash
curl -X POST http://127.0.0.1:4300/api/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"myproj","repoPath":"/abs/path/to/repo"}'
```

可選欄位與預設值：`mainBranch`（`main`）、`portRangeStart`（4300）、`portRangeEnd`（4399）、`parallelLimit`（2）。

建好之後排程器會掃 `<repoPath>/.loom/specs/*/spec.md`，依 front matter 的狀態推進。spec 資料夾的位置固定，不是設定項。

想自己手寫 spec 就在 `.loom/specs/<slug>/` 底下放 `spec.md` 與 `issues/NN-*.md`；issue 檔沒有 front matter 的話 loom 會補一份草稿狀態上去，要它開跑得在看板上按放行。已經做完、只是想登記進去的 spec，在 `spec.md` 寫 `merged: true`。

worktree 開在 `<repoPath>/.loom/worktrees/`，那個目錄自帶 `.gitignore`，不用你自己加。

## 開發

```bash
npm run dev       # 同 start，但 src/ 有變動就自動重啟，瀏覽器也會自己重整
npm test          # node:test
npm run typecheck # tsc --noEmit
```

`npm run dev` 用 Node 內建的 `--watch`。改動任何 `src/` 底下的檔案（含 `ui.html`）會重啟 server，前端的 SSE 重連時發現 `bootId` 換了就自動 `location.reload()`。
