# 失敗、重試與崩潰恢復

infra/domain 失敗分類、用量視窗、接手 issue、崩潰恢復。

## 失敗與重試

| 類別 | 事件 | 處理 |
| --- | --- | --- |
| domain | review reject、test fail、build fail | 進 `failed` 終端，自動開接手 issue（同一條失敗鏈上限 2） |
| domain | diff 為空 | 送 reviewer 判定，不計 |
| infra | subprocess 非零退出、API error、輸出不符 schema | 原地重跑，獨立計數加 backoff |
| infra | 超時、setup 失敗 | 直接 blocked |
| git | rebase 衝突、越界改到 issues、最終 merge 衝突 | 寫 group 的 `blocked_reason`，不動任何 issue |
| 用量 | 訂閱用量視窗用盡 | 不動 issue 狀態，整個 orchestrator 暫停到視窗重置 |

git 這一類寫 group 層而不是 issue 層，因為它們全部發生在沒有 issue 處於中間狀態的時刻。詳見 [core/state-machine.md](state-machine.md) 的「issue group 的狀態（聚合）」那節。

三條原則：

- **infra 重試原地、domain 失敗終端化，兩者獨立。** API 掛掉重連三次不該把一個好 issue 判死：infra 原地重跑；domain 失敗才進 `failed`、開接手 issue。兩條路互不吃額度。
- **infra 重試的前提是「再跑一次可能不同」。** API error 成立；超時不成立（同樣的工作量會同樣超）；git 衝突更不成立（同樣的樹會同樣衝）。不成立的一律直接 blocked。
- **e2e 紅了先原地重跑一次**，兩次都紅才算 domain fail。不這樣做的話一次 flaky 就吃掉一格接手額度。unit test 不需要這層。

### 用量視窗用盡是全域事件

以訂閱制執行時（OAuth 登入，不是 API key），額度是帳號層級的時間視窗，不是單次呼叫的問題。

它不能歸進 infra error：那個 issue 沒有錯，而且下一個 issue spawn 也會一樣失敗。照 infra 規則處理的話，額度在半夜用完，早上會看到一整排 blocked 的 issue，而實際上視窗二十分鐘後就重置了。

處理方式是暫停整個 orchestrator，issue 停在原狀態，看板顯示暫停原因與預估恢復時間，視窗重置後自動繼續。

**但辨識規則必須寫死，否則這條路走不到。** 額度用盡在 orchestrator 眼裡也是「subprocess 非零退出」，跟 infra error 是同一個現象。判定依據：result 事件的 `subtype` 與 `is_error`，加上一份 stderr 字串比對清單。**判定不出來的一律歸 infra**，這是安全的預設 -- 誤判成 infra 只是多重試三次，誤判成用量用盡會讓整個 orchestrator 白白停住。

這條判定依賴外部工具的錯誤訊息形狀，屬於「升級 Claude Code 時要檢查」的假設之一。所以看板上要有一個**手動的「暫停 / 恢復 orchestrator」開關**，讓判定失效那天人有辦法止血，不必去改 code。

### 接手 issue 策略

domain 失敗後開的接手 issue 一律從 base_sha 三段式清理後乾淨重寫，帶著前一個 issue 的失敗紀錄當警示，不繼承它的半成品 code。

理由：agent 反覆修同一份 code 時，裡面通常堆滿互相矛盾的嘗試痕跡，從頭寫比繼續補容易；公設 2 要求失敗不退回，接手 issue 從乾淨狀態重來就是這條原則的落實。同一條失敗鏈累計 2 個接手 issue 為上限，第 3 次把 group 標 `retry_loop` 等人看，避免自動加工作的迴圈失控。

### 崩潰恢復

orchestrator 重啟後做兩件事，順序不能顛倒。

**一、對每個未 merged 的 group worktree 跑一次一致性檢查**，不管它的 issue 處於什麼狀態。檢查 `.git/rebase-merge` 與 `.git/rebase-apply` 是否存在、`git status --porcelain` 是否乾淨。不乾淨就跑三段式清理。

只看 issue 狀態會漏掉一整類情況：每個 issue 完成後的 rebase 發生在「前一個已 done、下一個還是 ready」的時刻，沒有任何 issue 在中間狀態。orchestrator 死在那裡，恢復邏輯不會碰這個 group，下一個 issue 直接在 rebase 中途的樹上開工，記下的 base_sha 是 rebase 中途的 HEAD。

**二、依中間狀態分兩種處理，不是一律回捲：**

| 卡住的狀態 | 處理 |
| --- | --- |
| implementing | 三段式清理退回 base_sha，回 `ready`，不計重試 |
| review_ready、reviewing | 退回 `review_ready` 重派 reviewer 並重跑測試，**不動 code** |

一律回捲是錯的：reviewer 只讀 diff 不寫檔，測試的執行者是 orchestrator 的 subprocess 不是 LLM，兩者都不會留下「半改而 agent 不知道」的樹。orchestrator 在整體 e2e 期間崩潰是常見情形（e2e 很容易把機器打爆），照一律回捲會把已經通過 review 的 commit 全部丟掉，issue 從 ready 重跑一整輪。崩潰不構成 domain 失敗，不會終端化 issue。無人值守整晚時這是白燒一次完整實作。

implementing 要回捲，因為那是唯一可能死在 tool call 中間、留下半改工作樹的狀態。

不用 `--resume` 接回中斷的 session：process 可能死在 tool call 中間，worktree 是半改狀態而 agent 不知道自己被中斷過。乾淨重來可預測得多。
