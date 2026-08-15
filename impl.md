# 實作與工程決策

技術棧、資料存放、提示詞可調、workspace、開發迴圈、人手寫 issue、執行指令、觀測與用量顯示。claude CLI 的呼叫路徑、flag 隔離、result 事件判讀、用量偵測見 [docs/claude-cli.md](docs/claude-cli.md)。

## 實作

全 TypeScript，單一 Node process。web server 與 orchestrator 同 process、同事件迴圈，狀態直接共享，不需要 IPC 或第二個 store。

orchestrator 必須是單一事件迴圈：對 base branch 的 commit 必須序列化，且它是唯一的狀態寫入者。

| 項目 | 選擇 |
| --- | --- |
| server | Hono 或 Express，送 SSE |
| 前端 | React + Vite，build 成靜態檔由同一個 server 提供 |
| 資料 | `node:sqlite`（零依賴，會噴 ExperimentalWarning） |
| agent 執行 | `spawn('claude', [...])`，headless |
| 監聽 | `127.0.0.1`，無認證。要遠端就開 SSH tunnel |

### 驗證方式

兩種都能跑，差別只在啟動 `claude` 時的環境變數，不需要抽象層。

**訂閱制（OAuth）**：官方支援，`claude -p` 與 Agent SDK 的用量算進訂閱額度（[Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)）。代價是會撞到 5 小時與每週的用量視窗，見 [core/failure-retry.md](core/failure-retry.md) 的「用量視窗用盡是全域事件」。

**API key**：沒有時間視窗，只有花費。無人值守整晚時比較穩。

**決定：預設用訂閱制，接受下列已知風險。** API key 是備援路徑，需要時只是換環境變數，不影響任何其他設計。

三件要記著的事：

1. Consumer Terms 第 3 條字面禁止「透過 bot、script 等自動化方式存取服務」，例外是「透過 API Key，或另有明確允許」。上述 Help Center 文章應構成明確允許，但沒有官方頁面把兩份文件交叉引用。

2. **`--bare` 明說跳過 OAuth、只吃 `ANTHROPIC_API_KEY`，而官方說它「will become the default for `-p` in a future release」**（[headless 文件](https://code.claude.com/docs/en/headless)）。那個版本一到，不明確關掉 bare 的話訂閱制就不能用了。升級 Claude Code 時要檢查。

3. **防濫用系統可能因用量模式停權，這與驗證方式無關。** 2026-04 有第三方 harness 作者被自動停權的案例，Anthropic 工程師公開說是 abuse filter 誤判並撤銷；當事人聲稱當時已改用 API 計費，代表觸發點是流量形狀不是驗證方式。loom 的形狀正是那一類：連續數小時、無停頓、規律間隔、單一帳號高併發。

   注意這跟另一類封鎖不同：把 `~/.claude` 的 OAuth token 抽出來自己打 API 的第三方工具，會拿到 `This credential is only authorized for use with Claude Code`。loom 不碰 token，spawn 官方 CLI，不會踩到那一類。

### 資料存放

SQLite 存兩類東西：

**運行時資料**：base_sha、session_id、review 意見全文、失敗紀錄、耗時、成本、重試計數。

**設定**：workspace 清單與每個 workspace 的 `base_branch`、`port_range`、平行上限。在 web UI 上編輯。新增 workspace 時只輸入 repo 路徑。issues 資料夾與 worktree 位置不在內，它們固定在 `.loom/` 底下（見 [core/concepts.md](core/concepts.md) 的「核心概念」與 [core/git.md](core/git.md) 的「git 拓撲」）。

執行指令不存在設定裡，見下節。

**`name` 與 `repo_path` 建立後不可改。** `name` 是 handle 的 key；`repo_path` 換掉等於換一個專案，而 `runs`、`issue_state`、`group_state` 全都掛在同一個 `workspace_id` 上，issue 檔案與 worktree 也都推導自它。那兩件事該是新增一個 workspace，不是編輯這一個。

**改設定要等當前那一輪跑完（`PUT /settings` 回 409）。** `ctx.workspace` 是註冊當下的快照，所以存檔後整個 handle 換掉：舊排程器 `stop()`、用新的 workspace 重新 `registerWorkspace`，暫停狀態跟著搬過去。但 `stop()` 只清 timer -- 正在 `await` 的 `driveParent` 攔不住，它會拿著舊的 `base_branch` 把 rebase 與 merge 做完，跟剛存下去的設定對不上。所以有東西在跑時直接拒絕，不做中止：中止一個跑到一半的 coder 要處理 worktree 殘留與半完成的 commit，比「等它跑完」貴得多。

**issue 資料夾固定成 `.loom/issues`，不是設定。** 可設的值域實際上只有一個，卻要養一條路徑驗證（`..`、絕對路徑、指到 repo 根三種寫法都得擋，因為那個字串會被 `join` 進 `repo_path` 再交給 `git add`）加一整套設定 UI 與換資料夾時的確認流程。固定之後這些全部消失，`PUT /settings` 的 trust boundary 只剩 `base_branch`（會進 git 的參數列，限制在英數與 `. _ - /`）與三個數字欄位。

固定路徑要成立的前提是 `.loom/issues` 沒有被 `.gitignore` 蓋掉，這一點由 `commitStateChange` 的 `git add` 自己保證，見 [core/git.md](core/git.md) 的「目錄自我忽略」。

### 提示詞在 web UI 上可調

四個角色各一份可編輯的模板，存 DB，per-workspace。沒有繼承或覆寫的兩層邏輯。

**只有被編輯過的角色才在 DB 裡有一列**，沒有那一列就讀內建預設。原本寫的是「新增 workspace 時複製一份內建預設」，實作時改成這樣：複製的話，內建預設之後有任何修正都不會傳播到已存在的 workspace，而那些 workspace 的擁有者根本沒動過那個角色的模板；而且「這份是不是還停在出廠預設」得拿內容跟預設做字串比對才知道，改成有沒有那一列就直接是答案。「還原預設」因此是刪掉那一列，不是複製一份預設寫回去。

**預設內容是 loom 自己的出廠版本**（見 [agents/prompts.md](agents/prompts.md) 的「提示詞」），整份可編輯。每個角色下方列出可用變數，設定頁附「還原預設」把它復原成內建的出廠版本。

模板大致的形狀：

```
Read the issue group and issue below before changing code.
Implement only the requested issue.
交棒前自己跑一次 typecheck 與相關測試。
不要修改 .loom 底下的任何檔案。

<issue_group>{group_md}</issue_group>
<issue>{issue_md}</issue>
<交接紀錄>{handover_log}</交接紀錄>
```

**`--json-schema` 不可編輯，在 UI 上顯示為唯讀。** 那是狀態轉移的判定依據，改壞了 orchestrator 讀不到 verdict 就整條流水線停擺，而症狀會表現成「agent 一直失敗」，很難查到根因。prompt 本體改壞了最多是產出品質變差，還救得回來。

為什麼要可編輯：內嵌的內容是通用的，不知道你這個專案的慣例、不知道 loom 的失敗紀錄要怎麼餵、不知道測試輸出只給 tail 200 行。那些是 loom 與專案的上下文，寫死在程式碼裡就沒得調。

**coder 只有一份模板，不分首次與接手。** `{handover_log}` 為空時那一段就是空的。接手輪其實可以另外設計專用指引，但先不加 -- 多一份模板就多一份要維護的分岔，等接手品質被證明不夠再說。

**不做版本歷史，編輯就是覆蓋。** 因此同一條失敗鏈上的原 issue 與接手 issue 可能用不同版本的模板，`runs` 也不記錄用了哪一版。這是刻意的：看到 coder 一直踩同一個坑、改模板、讓下一個接手 issue 立刻吃到新版，正是這個編輯功能的用途；凍結成「開工當下那一版」會把它變成「改了但這一輪不算」。代價是模板改壞了退不回上一版，只能重打或按還原預設回出廠版。

**實作：** 出廠預設在 `src/prompts.ts`（四個角色的 loom 自有版本）；per-workspace 的編輯版存在 `prompts` table。`agent.ts` 每次呼叫才讀 DB，不快取 -- 那是「當前重試立刻吃到新版」的實作方式。「還原預設」是把那一列刪掉，讀取時自然落回內建預設，不是複製一份預設寫回去，所以 `isDefault` 永遠等於「DB 裡沒有這一列」。變數替換認得的變數才換，不認得的原樣留著（打錯字時看得到 `{spce_md}` 留在 prompt 裡，比默默變成空字串好查）。

### 新增 workspace 時的資料夾選取

`repoPath` 要的是絕對路徑，但瀏覽器的資料夾選取（`webkitdirectory`、`showDirectoryPicker()`）基於安全設計一律不給絕對路徑。server 跟瀏覽器在同一台機器上，所以由 `GET /api/browse` 列目錄、前端拿它做選取器。只回目錄名稱與「含不含 `.git`」，不碰檔案內容。

**不限制可瀏覽的根目錄。** `POST /api/workspaces` 本來就收任意絕對路徑並在那裡跑 agent，列目錄名是嚴格更小的權限；限制在 `homedir` 之下只會擋掉 repo 放 `/mnt`、`/srv` 的正常用法，而且手動輸入完全不受那個限制，等於只擋 UI 不擋 API。前提是 server 綁 `127.0.0.1` 且沒有 CORS header（跨站網頁送得出這個 GET 但讀不到回應）。要對外開的話，這條跟 `/api/workspaces` 都得先有驗證，而後者是更急的那個。

### loom 自己的開發迴圈

`npm run dev` 用 Node 內建的 `--watch` 監看 `src/`，改動自動重啟。這是 loom 自己這個 server，跟被編排的專案怎麼起 server 沒有關係（見 [core/verification.md](core/verification.md) 的「reviewing 裡的 test_verification phase 跑什麼」）。

server 進程啟動時產生一個 `BOOT_ID`，SSE 的 `connected` 事件帶上它。server 重啟後瀏覽器的 `EventSource` 本來就會自動重連，前端發現 `bootId` 換了就 `location.reload()`。這樣改 `ui.html`（它是 `readFileSync` 讀的，不在 import 圖譜上，所以要 `--watch-path=src` 才追得到）不用手動重整，而且不需要另外接一套 hot reload 通道。一般手動重啟 server 也會觸發前端重載，那是對的行為：舊 UI 配新後端就是該重載。

### 人手寫的 issue group

issue group 固定放 `<repo>/.loom/issues/`。人可以直接在底下建 `<NNNN>-<slug>/`，放 group 的描述檔與各 issue 檔，不必經過「討論」分頁。

**issue 檔沒有 front matter 時就地補一份 `status: draft`、`e2e: false`、`blocked_by: []`。** 補寫做在 `loadIssues` 裡，它是所有讀取路徑的共同入口 -- 另開一個 normalize 步驟就得在每個呼叫端記得先跑一次，漏掉一個就是一條會讀到沒有 front matter 的檔案而炸掉的路徑。補上的內容不另外 commit：這條路徑包含唯讀的看板查詢，那份 front matter 由下一次狀態轉移的 `git add` 一併帶走。落點是 draft，所以補完也不會有東西自己跑起來。

**不讀 body 裡的任何欄位。** 早期版本會讀 markdown body 的 `**Status:**` 與 `**Blocked by:**` 行映射成 loom 的狀態，拿掉了。兩邊的值域對不上：那五個 triage 標籤（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）沒有一個表示「已完成」，而 loom 的 issue 有十個狀態，映射只在「還沒開工」那一端說得通。`Blocked by` 更糟 -- 實際寫法會帶括號註解（`01(共用純模組，由 01 建立骨架)`），逗號切分產出的是指向不存在 id 的 blocker，而 `blocked_by` 只在 frontier 卡住、止血機制要判斷哪些下游可以頂替時才被讀（見 [core/git.md](core/git.md) 的「Blocked by」），所以那種錯誤會安靜地等到第一次有 issue blocked 才發作，且症狀是「該擋的沒擋」。

手寫的 issue 要宣告依賴就自己寫 front matter 的 `blocked_by`。正常執行照 issue 檔名（全域號）排序走，順序排對了空著也能跑。

**採用 loom 之前就做完的 group：在 group 的狀態檔寫 `merged: true`。** 所有 issue 都 done 的 group 會聚合成 verifying，而 verifying 用的 worktree 只在派工時建立，那種 group 從沒派工過，路徑不存在。`merged: true` 讓它直接落進已合併那一列，也誠實描述事實 -- 那些程式碼早就在 base branch 了，沒有 diff 可驗、沒有 e2e 該跑。

### 執行指令由 package.json 提供

loom 認慣例名稱，專案不必為了 loom 新增任何 script：

| 階段 | 取哪個 |
| --- | --- |
| 安裝 | 由 lockfile 決定（`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `package-lock.json`），沒有就不裝 |
| typecheck | `typecheck` |
| test | `test` |
| e2e | `e2e`，沒有就 `test:e2e` |

執行時 `PORT` 由 orchestrator 放進環境變數，要不要用它起一個 server 是指令自己的事。

這樣解決三件事：

- **設定漂移消失。** 這是「設定存 DB 不存 repo」唯一的已知代價。改測試工具就改那行 script，loom 自動跟上，不需要任何同步動作或偵測按鈕。
- **非典型專案自然支援。** script 裡可以寫任何東西，例如先起 docker compose。
- **零設定就能跑。** 這些名稱多數 Node 專案本來就有。要求專案先加幾行 `loom:*` 才會動的話，沒加的專案走的是「沒有可跑的東西 → `pass: true`」那條路，也就是契約沒人履行、而懲罰是假綠燈把 issue 推成 done。

**monorepo：根層沒有的階段往子 package 找。** 根層有該階段的 script 就只跑根層 -- 專案自己寫的 `pnpm -r test` 或 `turbo run test` 是明確意圖，再遞迴一次等於同一批測試跑兩遍。根層沒有才展開 workspaces（`package.json` 的 `workspaces`，含 yarn v1 的 `{ packages: [...] }` 寫法；pnpm 則讀 `pnpm-workspace.yaml`），每個有該 script 的子 package 依目錄排序依序跑，各自以自己的目錄為 cwd，第一個紅的就停下並在 summary 裡標出是哪個 package。

子 package 一律用 `npm run`，不去偵測套件管理器的遞迴語法（`pnpm -r` / `yarn workspaces foreach` / `npm --workspaces`）：`npm run` 只是讀那一份 `package.json` 的 scripts 再交給 sh，pnpm 那種 symlink 的 `node_modules/.bin` 一樣認得，而安裝早就在根層用 lockfile 選出的套件管理器做完了。安裝維持只在根層做一次，monorepo 本來就是這樣裝的。

不做這件事的話，前後端分在 `apps/web`、`apps/api` 的專案在 loom 眼裡是「沒有 typecheck/test/e2e」，走的是 `pass: true` 那條路。那是所有假綠燈裡最貴的一種：看起來一切正常，實際上一行測試都沒跑。

早期版本認的是 `loom:setup` / `loom:dev` / `loom:typecheck` / `loom:test` / `loom:e2e`，理由是 port 注入沒有通則（Vite 吃 `--port`，Next 吃 `-p`）。拿掉了：port 注入只有 loom 自己要起 dev server 時才是問題，而那件事本來就該由 e2e 框架做（見 [core/verification.md](core/verification.md) 的「reviewing 裡的 test_verification phase 跑什麼」）。loom 自己的 `package.json` 一個 `loom:*` 都沒有，跑的就是慣例名稱。

代價：專案的 `test` 如果是 watch mode（`vitest` 不加 `run`），這裡會一路跑到逾時才被砍成 infra failure。症狀看得見，不是假綠燈，而 CI 本來也跑不了 watch mode，所以這種 script 早晚要改。

壞掉的條件：非 Node 專案沒有 `package.json`。`pnpm-workspace.yaml` 寫成 flow 形式（`packages: ['a', 'b']`）認不出來，會落回「不是 monorepo」-- 手寫解析只認 block 形式的清單，換不到為了一個欄位裝 YAML 依賴。

### 觀測

agent 的 stream-json 即時轉發到 SSE，web 上看得到 agent 現在在做什麼。跑二十分鐘完全看不見裡面是不可接受的，而這幾乎免費。

**完整輸出不落地。** 一個 issue 的 stream-json 可能幾 MB，乘上 issue 數與重試次數會把 DB 撐爆。只存摘要（耗時、成本、files_changed、verdict），失敗時才存完整 stdout，那時才需要它。

**實作現況：** `claude.ts` 的 `runClaude` 有給 `onEvent` 才切換成 `--output-format stream-json --verbose` 逐行解析，沒給就維持既有的 `--output-format json` 一次性路徑，行為不變。事件粒度是「一個 assistant 內容區塊」，不追蹤 token-level 的 partial delta（不帶 `--include-partial-messages`）、不等 tool_result 回來（那些只換得到 tool_use_id 對應的額外狀態，換不到「看得懂 agent 在幹嘛」這個目標）。orchestrator 用一個純記憶體的 `LiveOutputStore`（key 是 run id）暫存，run 一結束就 `clear()`，完全不落地，跟上面「完整輸出不落地」一致。

接上的有 coder、issue_reviewer、以及測試階段的指令（`testrunner.ts` 透過同一條管線報 `kind:"port"` 與跑了哪個 script）。group reviewer 與 group 層的 e2e 沒接：它們的 issue 是 null，看板目前沒有它們的顯示位置。

**事件形狀已實測**（`claude-stream.test.ts`，預設 SKIP，`ORC_TEST_REAL_CLAUDE=1` 才跑）：`assistant` 事件的 `message.content[]` 會有 `thinking` / `text` / `tool_use` 三種區塊，工具名稱就是 `Read`、`Edit`、`Bash` 這些原名，`Read` 的 `input.file_path` 是絕對路徑。`--json-schema` 強迫呼叫的 `StructuredOutput` 也會以 `tool_use` 出現，那是 loom 自己要求的回報動作不是 agent 在做事，轉發時濾掉。

### 用量與花費

result 事件帶完整用量（欄位形狀見 [docs/claude-cli.md](docs/claude-cli.md)），訂閱制照樣回傳，不是空的。loom 每次 agent 跑完記一列，就能按 issue、group、角色、日期任意切。

顯示：頂列今日 token 與花費；issue 面板本輪花費與 token；group 面板總花費與 token。

**token 顯示成「輸入 / 輸出」兩個數字**，輸入是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 的總和。分成兩個是因為它們的意義不同：輸出是真正的生成量，輸入大部分是快取重讀。同時看得到花費和這兩個數字，才能分辨「這次很貴」是快取沒命中還是真的生成很多。

三個判讀上的陷阱要記著：

- **`input_tokens` 不是輸入量。** 真正的輸入是 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 三項相加，只看 `input_tokens` 會低估好幾千倍（快取命中時它常只有個位數）。
- **token 總量與金額是兩條曲線。** 四類 token 單價不同（output 最貴、cache read 最便宜），一個 group 可能 token 多但便宜（大量快取命中），也可能 token 少但貴。要比較就分開記。
- **訂閱制下金額不是帳單。** 那是「如果走 API 會花多少」的等價換算，用途是相對比較（這個 group 比那個貴三倍、這次重試燒掉半個 group 的量），不是預測還能跑多久 -- 5 小時與每週視窗官方沒公布 token 換算。

使用者層的固定開銷實測約 +2565 token/次（`--setting-sources user` 相對 `""`），量測見 [docs/claude-cli.md](docs/claude-cli.md)。
