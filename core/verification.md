# 驗證機制

兩層 review、group review 處理、test_verification phase、失敗資訊傳遞。

## 驗證

分兩層，便宜的檢查密集跑，昂貴的只在該跑時跑。

**每個 issue**：coder 在 `implementing` 結尾自跑 typecheck／unit test；進 `reviewing` 後先跑 issue review；review 通過後，orchestrator 在 `test_verification` phase 重跑 typecheck／unit test。

**issue front matter 宣告 `e2e: true` 的**：該 issue 也跑一次 e2e。

**group 所有 issue done 後**：跑一次完整 e2e，以及一次 group review，過了才進 mergeable。七個各自綠燈的 issue 疊起來未必綠。

### 兩層 review 抓的是不同的東西

不是同一件事的不同時機，是結構上看得見的範圍不同。

| 角色 | 讀的 diff | 唯一能抓到的 |
| --- | --- | --- |
| issue reviewer | `git diff <base_sha>..HEAD` | 細節：這個改動有沒有做對自己的事、測試有沒有測到行為 |
| group reviewer | `git diff <base-branch>...issue-group/<NNNN>-<slug>` | 跨 issue 的一致性：重複的抽象、殘留的死碼、七個各自合理但疊起來歪掉的架構 |

issue reviewer 不能省：group reviewer 的 diff 太大看不清細節，而且錯誤在序列鏈上會複利。group reviewer 每個 group 只跑一次，七個 issue 的 group 總共多一次 LLM 呼叫。

**兩者失敗的處理不同，而且刻意不同：**

- **整體 e2e 紅了**：orchestrator 自動開一個新 issue（客觀失敗，一定要修）。
- **group review 有意見**：只附在 mergeable 的 group 上給人看，不自動開 issue。

group review 不自動開工作，是因為架構層面的意見「要不要現在修」本身就是人的判斷 -- 可能值得，也可能該留到下一個 group。讓 LLM 自動決定加工作是把判斷權放錯地方。這同時消掉了「LLM 傾向找得到東西、每個 group 都自動長出新 issue、永遠收斂不了」的風險，不需要任何次數上限之類的補丁。

merge 按鈕已經是人的閘門，那些意見正好是按下去之前該讀的東西。

**group reviewer 的 diff 由 orchestrator 算好傳進 prompt，整份送。** reviewer 只有 `Read`/`Glob`/`Grep`（唯讀），自己跑不出 `git diff`。整份送是因為這個角色要找的正是「不同 issue 各自引入了重複的抽象」「issue 03 建的東西被 issue 06 淘汰但沒刪」，那些只有攤開全貌才看得見；截斷等於廢掉它存在的理由，而逐個 issue 的 diff 已經被 issue reviewer 看過了。

成本上也不需要省：實測一個七個 commit 的分支約 130KB（約 38k token），在 200k context 裡佔不到五分之一，而一個 group 只跑一次 group review，同一個 group 的 coder 與 issue reviewer 加起來是十幾次呼叫。

**排除產生檔，不截斷。** `package-lock.json`、`*.snap`、`dist/` 那類對「這個改動做對了嗎」零價值，卻很容易佔掉 diff 的九成。清單寫死在 `git.ts`，不開設定欄位（理由同「不為詞彙表與規範文件開設定欄位」）。超過上限時才降級成檔案清單加行數，讓 reviewer 用它的 Read 自己挑要看的 -- 它的 cwd 就是完整 checkout。那條路徑是給大型改名散佈到幾百個檔案的極端情況，平常不會走到。

### group review 意見的處理

意見存 DB。點 lane 標頭時右側面板顯示 group 層細節：整體 e2e 結果、review 意見清單、merge 按鈕。

只有兩個動作：

- **轉成 issue**：那條意見變成一個 issue 加進當前 group 末尾，group 退出 mergeable 回去跑。做完重新進 verifying，會再跑一次整體 e2e 與 group review。這個循環由人觸發，不會失控。
- **直接 merge**：意見留在 DB 的歷史裡，不再提醒。

**不做「之後再說」的暫存。** 要存成 draft issue 就得掛在某個 group 底下，而那個 group 已經 merged、在看板上收起來了，人永遠看不到；要讓它可見就得改「已合併」的判定規則，為一個很少用的功能弄複雜整個聚合邏輯。

而且「之後再說」在實務上就是忘記。真的想留就去 chat 開一個新 group，開的時候會重新判斷那件事還值不值得做，那個重新判斷比一條躺在待辦裡的舊意見有價值。

整批做完才驗證的問題不是省時間，是錯誤在序列鏈上會複利：issue 03 壞了但在 07 做完才發現，中間四個 issue 全建立在壞基礎上。而且 reviewer 讀七個 issue 疊起來的 diff，品質會明顯掉。

### reviewing 裡的 test_verification phase 跑什麼

coder 在 `implementing` 結尾已經自跑 typecheck 與 unit test；那是 self-check。issue 進 `reviewing` 後先跑 `llm_review` phase。review 通過後才進 `test_verification` phase，由 orchestrator 依 lockfile 裝依賴（agent 可能加了新的）、重跑 `typecheck`、重跑 `test`、必要時跑 `e2e`。每個指令都自成一個 process group，逾時就整組收掉。

**loom 不起 dev server。** 需要 server 的測試由測試指令自己起 -- Playwright 的 `webServer` 就是做這件事，而且它自己負責關掉。loom 起一份的話等於要求專案再宣告一個「給 loom 用的 dev 指令」，還要 loom 去猜每個框架怎麼吃 port，而 e2e 框架早就有這個功能。

**loom 只保證 `PORT` 唯一，其餘隔離由專案的 script 負責。** 多個 group 平行跑測試時，共用資源不只 port -- 本機資料庫、共用檔案、固定的瀏覽器 profile 都會互相污染。要獨立資料庫就從 `$PORT` 衍生一個名稱。隔離責任放在最清楚狀況的地方，loom 不需要理解任何專案的測試環境。真的隔離不了的專案把平行上限設 1。

**實作在 `src/testrunner.ts`。** 認得的 script 是 `typecheck`、`test`、`e2e`（`e2e` 找不到時退回 `test:e2e`）；安裝指令一律由 lockfile 決定（`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `package-lock.json`），沒有 lockfile 就不裝。根層沒有某個階段的 script 時會往 workspaces 的子 package 找，見 [impl.md](../impl.md) 的「執行指令由 package.json 提供」。

typecheck 先跑：編譯不過就沒必要花時間跑後面兩段。

**回傳值分三種，不是兩種。** `pass: true`；`failure: "domain"`（測試真的紅了，issue 進 `failed` 終端、自動開接手 issue）；`failure: "infra"`（安裝失敗、任何一段超時，照失敗與重試的表格直接 blocked）。混成一種的話，一次基礎設施故障會被當成 domain 失敗，白白終端化一個可能沒問題的 issue、多燒一個接手 issue。

**「沒有可跑的東西」（沒有 `package.json`、沒有 typecheck/test/e2e script）回傳 `pass: true`**，但 output 明確寫出是哪一種並存進 `runs.summary`。這是刻意的取捨：非 Node 專案不該讓整條流水線卡死，但也不該讓人以為測試真的跑過。設定頁的「測試階段會跑」那一欄同時把這件事標成警告，讓人在派工之前就看得到。**worktree 目錄根本不存在則是拋錯**讓排程器停住 -- 那是環境壞了，不是「這個專案沒有測試」，兩者都走 `pass` 的話 issue 會在沒有程式碼可測的情況下變成 done。

process 生命週期不交給 LLM 的理由：agent 超時被殺、自己崩掉、忘記 kill，spawn 出來的東西就變孤兒佔住 port，症狀出現在下一個不相干的 group 上，而且要手動 `lsof` 才找得到。orchestrator 是唯一確定知道「這一輪結束了」的角色，所以測試指令由它 spawn、由它 kill 整個 process group。

### 失敗時的資訊傳遞

orchestrator 把測試 stdout 存進 DB，coder 下一輪的 prompt 帶最後 200 行，加一句「完整輸出自己重跑 test_command 看」。

全塞進 context 太貴，完全不給又逼它多跑一次。
