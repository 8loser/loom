# 狀態機與來源過期偵測

issue 狀態機、issue group 聚合、看板呈現、來源過期偵測。

## 狀態機

狀態機有兩個層次：issue 帶自己的 9 狀態機，issue group 的看板狀態由它內部的 issue 聯合算出。

主狀態就是看板上的位置。testing 不再是主狀態，也不再是看板欄位；測試驗證是 `reviewing` 裡的 phase，用 badge 呈現。

| 看板欄位 | issue 主狀態 |
| --- | --- |
| 待處理 | `ready` |
| 實作中 | `implementing` |
| 審查中 | `review_ready`、`reviewing` |
| 完成 | `done` |

### issue 的狀態機

```
draft ──finalize──▶ ready
ready ──派工──▶ implementing
implementing ──ok / self-check pass──▶ review_ready ──派工──▶ reviewing[llm_review]
  reviewing[llm_review] ──pass──▶ reviewing[test_verification]
  reviewing[test_verification] ──pass──▶ done
  reviewing[*] ──reject / test fail / build fail──▶ failed（終端；自動開接手 issue）
中間狀態（implementing / review_ready / reviewing）
  ──infra error 超過重試上限──▶ blocked ──人工──▶ ready
blocked ──人按「先收目前進度」──▶ dropped
failed 的接手 issue 也 failed，同一條鏈累計 2 次──▶ group blocked（retry_loop）
human ──人做完手動標──▶ done
human ──人改主意──▶ ready
```

十個狀態。`done`、`dropped`、`failed` 是終端狀態，聚合時都算「不必再做」（`failed` 的延續由接手 issue 承接，原 issue 不復活）。

**`reviewing` 不是單一動作，而是同一欄位裡的兩個 phase。** 先由 reviewer 看 diff；review 通過後，同一張卡仍留在「審查中」欄，phase 變成 `test_verification`，顯示「驗證中」badge，由 orchestrator 重跑 typecheck／unit（必要時 e2e）。兩個 phase 都過才進 `done`；任一 phase 失敗就進 `failed` 終端（見下）。testing 不是主狀態，只是 `reviewing` 裡的驗證 phase。

**`failed` 是 domain 失敗的終端，落實公設 2。** review reject、test fail、build fail 任一發生，issue 不退回重做，而是進 `failed` 終端；orchestrator 在同一個 group 自動開一個接手 issue，從 base_sha 三段式清理後乾淨重寫，帶著失敗紀錄當 `last_failure`。同一條失敗鏈累計 2 個接手 issue 為上限，第 3 次把 group 標成 `blocked_reason: retry_loop` 等人看，理由同 e2e 迴圈。**單一 issue 上沒有「第 N 次嘗試」這個欄位**——重試次數屬於 group 層級的失敗鏈計數，在看板上顯示為 lane 的 badge，不是 card 的屬性。

`draft` 只用於人手寫丟進 issues 資料夾的 issue（見 [impl.md](../impl.md) 的「人手寫的 issue group」）。chat 定稿產出的 issue 直接進 `ready` 或 `human`。

**`human` 是不派工的狀態。** chat 產 issue 時標記 `needs_human` 的那些：需要判斷、需要外部存取、需要手動測試的 issue。loom 不 spawn 任何 agent，看板上獨立顯示等人處理，人做完手動標 done，序列繼續。

沒有這個狀態的話，這類 issue 會被 agent 抓走、失敗、開接手 issue、又失敗，浪費兩個 issue 才得到「這件事本來就不該自動做」這個結論。

**`dropped` 是「先收目前進度」的落點。** blocked 的 issue 與所有直接或間接依賴它的未開工 issue 一起標成 `dropped`，issue group 隨即進 verifying，跑整體 e2e 與 group review，通過才進 mergeable。沒被丟掉的部分照常合併，未完成的部分由 group review 的意見帶到人面前。

這解掉 all-or-nothing 的風險：issue #0005 失敗到 retry_loop 上限時，人按「先收」把它與下游標 dropped，#0001 到 #0004 的成果不會一起卡在 branch 上落不了地。

diff 為空不算失敗，送 reviewer 判定是「確實已被前一個 issue 解決」還是「根本沒做」。

### issue group 的狀態（聚合）

```
所有 issue 到達終端（done、dropped 或 failed）──▶ verifying（跑整體 e2e 與 group review）
  綠 ──▶ mergeable（等人點按鈕）
  紅 ──▶ orchestrator 產生一個新 issue 進清單，group 回到執行中
mergeable ──人點按鈕──▶ merged
git 操作失敗 ──▶ group 層 blocked（寫 blocked_reason）──人處理完──▶ 回原狀態
```

**issue group 的狀態檔只有兩個欄位：`merged` 與 `blocked_reason`。** 其餘全部由 issue 狀態聚合算出。

這兩個欄位存在的理由相同：**它們是 issue 推不出來的 group 事實**。所有 issue 都 done 不等於人按過合併；而 rebase 衝突、最終 merge 衝突、agent 越界改到 issues 這三種失敗都發生在「沒有任何 issue 處於中間狀態」的時刻 -- issue 之間，或所有 issue 完成之後。通往 blocked 的邊從那些時刻出發，沒有單一 issue 可以承載它。

`blocked_reason` 的值域：`rebase_conflict`、`merge_conflict`、`issues_touched`、`e2e_loop`、`retry_loop`。

聚合表**由上而下 first-match**，第一列命中就停：

| 順序 | 顯示狀態 | 判斷方式 |
| --- | --- | --- |
| 1 | merged | 狀態檔的 `merged` |
| 2 | group blocked | 狀態檔的 `blocked_reason` 非空 |
| 3 | blocked | 任一 issue 是 `blocked` |
| 4 | 等人動手 | 下一個該做的 issue 是 `human` |
| 5 | 執行中 | 任一 issue 在 implementing、review_ready、reviewing |
| 6 | verifying / mergeable | 所有 issue 到達終端，再看 DB 裡整體 e2e 與 group review 的結果 |
| 7 | 排隊中 | 至少一個 `ready`，且沒有任何 issue 在中間狀態 |
| 8 | 草稿 | 全部 `draft` |

first-match 是必要的：`blocked` 與「執行中」可以同時成立（`Blocked by` 止血讓不相干的 issue 在別的 issue blocked 時繼續跑），`blocked` 與「等人動手」也可以。互斥寫法無解，優先序才有。

第 7 列的述詞是「至少一個 ready」而不是「全部 ready」，因為 done 與 ready 混合是設計自己製造的常態：group review 意見轉成 issue、整體 e2e 紅開新 issue，兩條路徑都往全 done 的 group 加一個 ready。

**中間狀態一律用列舉，不用 `*ing` 字面。** `review_ready` 是有自己派工轉移的持久狀態，字面上不含 ing，用萬用字元寫會漏掉它 -- orchestrator 因用量視窗暫停時整批狀態會凍在那裡。崩潰恢復的掃描用同一份列舉。

整體 e2e 失敗產生的 issue 由 orchestrator 用模板寫：標題是失敗的測試名稱，body 是 tail 輸出，**並且一律帶 `e2e: true`**。沒有這個旗標的話，這個為了修 e2e 而生的 issue 只會被 typecheck、unit test、review 驗證，coder 交出看起來合理但沒真正修好的改動就能通過，回到 verifying 又紅，再開一個新 issue，每個新 issue 帶全新的重試計數，永遠不收斂。

**同一個 group 因整體 e2e 紅自動開 issue 累計 2 次為上限**，第 3 次改成把 group 標成 `blocked_reason: e2e_loop` 等人看。理由跟 group review 不自動開 issue 一樣：自動加工作的迴圈一定要有終止條件。

### 看板呈現

顯示 issue 卡片，issue group 當 swimlane。視覺/互動原型見 [mockup.html](../mockup.html)。

**看板只放需要人或機器動作的 issue group。** 展開的 lane 是 blocked、mergeable、執行中、排隊中；draft 與 merged 各收成一行，點開才展開。

離開看板的時機是 **merged，不是所有 issue 都 done**。全綠但還沒合併的 group 需要人動手，lane 要留著讓人翻看那幾張卡再決定。

不做這個切分的話，跑一個月就是四十條全是 done 卡片的 lane 把工作區淹掉。已合併的 group 要查就去 issues 資料夾或 git log，不另做歷史檢視。

**看板是跨 workspace 的單一視圖，靠上方的專案篩選縮窄。** topbar 的 meters（今日 token／花費／執行中）與 attention 橫條都是跨所有 workspace 聚合，不看篩選；篩選只窄化看板本身。一個 issue group 屬於哪個 workspace 是它身上帶的 `workspace_id`，跨 workspace 的聚合查詢就是同一批表不加 workspace 條件（見 [impl.md](../impl.md) 的「資料存放」）。

不做拖拉。人能觸發的轉移有六條，每一條對應一顆按鈕，兩邊互為檢查：

| 按鈕 | 對應的邊 |
| --- | --- |
| 草稿 group 放行開跑 | `draft ──▶ ready`（該 group 全部 issue） |
| blocked 恢復 | `blocked ──▶ ready` |
| blocked 先收目前進度 | `blocked ──▶ dropped`（含所有下游未開工 issue） |
| group blocked 恢復 | 清除 `blocked_reason`，回原狀態 |
| human 標為完成 | `human ──▶ done` |
| human 退回 ready | `human ──▶ ready` |
| mergeable 觸發 merge | `mergeable ──▶ merged` |

（七顆按鈕對應六條 issue 層的邊加一條 group 層的清除動作。）

做拖拉就要實作一套「哪些拖動合法」的規則，而這些用按鈕表達更清楚，而且拖拉在手機上難用。

### 來源過期偵測

issue group 的描述在開跑後還是可以改（`--resume` 回原對話討論、或直接編輯）。已經 done 的 issue 是照舊版做的，沒有任何東西指出這件事。「開跑後只能改還沒開始的 issue」這條規則只約束 issue 檔，而且沒有執行機制。

**機制**：`issue_state` 存一欄 `source_hash`，在每次 `doImplement` 開頭記下 `sha256(group 描述 body + 該 issue 檔 body)`。讀取時比對當前值，不同就標過期。

三條限制：

1. **過期是 derived boolean，不是第十二個狀態。** 不進 front matter、不動 `transition`／`aggregateParentStatus`。
2. **只對 done 有意義。** 還在跑的 issue 下一輪本來就會讀到新內容。
3. **不擋 merge。** 錯字修正不該擋 merge，跟 group review 意見同一層級：看板上的徽章，不是門禁。

hash 的是 **body 不是整檔**。front matter 由 orchestrator 自己寫，`merged: true` 在 merge 那一刻寫入，拿整檔算 hash 會讓所有 issue 同時變過期。

group 描述與 issue 檔合成一個 hash，不分兩欄：人的處置不分兩種，而且舊版長什麼樣 git 已經有了（每個 issue done 時 orchestrator 都 commit 過 issues），不需要另存內容。

人有兩個動作：**重做**（該 issue 回 ready，清掉 base_sha 讓下一輪重新開工）與 **忽略**（把 `source_hash` 更新成當前值）。重做只退那一個 issue，不自動連坐下游 -- 下游有沒有真的受影響只有人判斷得出來，自動連坐會在無人值守的時段把本來正確的東西重跑一遍。

因為 `source_hash` 必須跨輪存活，`clearIssueState` 是把 `base_sha` 與重試計數歸零，不是整列 DELETE。

`group reviewer` 做不到這件事：它看「當前 code 對當前 group 描述」，沒有時間維度，抓得到 code 與新 group 描述牴觸，抓不到 code 只是沒實作新 group 描述多出來的約束（那種缺漏沒有矛盾可偵測）。而且它在整個 group 完成後才跑一次，那時要重做的 issue 底下已經疊了後面所有 issue。
