# Agent 角色與拓撲

push 派工拓撲、五個 LLM 角色、planning 與確定性工作的分界、為何沒有 tester。

## Agent

### 拓撲

orchestrator 持有狀態並依狀態 spawn 對應的 subprocess。不是 coder 呼叫下一棒，也不是 agent 自己輪詢搶單。

不用 coder 呼叫下一棒的理由：狀態會被藏進黑箱，orchestrator 不知道跑到哪一步，kanban 沒東西可顯示；崩潰無法續跑；reviewer 作為 coder 的子 agent 會繼承 coder 的 context 和它對自己實作的信心，那不叫 review。

不用 agent 輪詢的理由：那需要常駐 daemon 各自掃狀態、各自搶單、處理兩個 agent 抓到同一個 issue。push 模型只有一個寫入者，沒有競爭者，體感一樣而實作少一半。

### 五個 LLM 角色

| 角色 | 輸入 | `--json-schema` 輸出 |
| --- | --- | --- |
| chat | 對話，cwd 在 main checkout，`--tools Read,Glob,Grep` | rough draft：`{group_md, issues:[{title, body}]}` |
| planning | chat 的 rough draft + orchestrator 餵的活 issue 檔案範圍 + base branch code | `{groups:[{slug, group_md, issues:[{title, body, blocked_by[], e2e, needs_human, touches[]}]}]}` |
| coder | group 描述 + issue + 交接紀錄（`{handover_log}`） | `{done, summary, files_changed[]}` |
| issue reviewer | group 描述 + issue + `git diff <base_sha>..HEAD` | `{verdict, comments[]}` |
| group reviewer | group 描述 + 全部 issue + `git diff <base-branch>...issue-group/<NNNN>-<slug>` | `{comments[]}`，沒有 verdict，因為它不決定流程 |

coder 在交棒前自己跑一次 typecheck 與 unit test。這是 self-check，不是呼叫 tester；把編譯不過的東西丟給下一棒是浪費一整輪。

reviewer 的乾淨 context 是它獨立性的來源，不是缺點。它只該看 diff 和需求，不該看 coder 的辯解。

reviewer 同時負責判定測試品質：這些測試是在測行為還是在測實作細節、覆蓋夠不夠。不足就 `verdict: reject` 附 comment。

### planning agent：語意工作與確定性工作的分界

orchestrator 的決策一律確定性、不用 LLM 做流程判斷（見 [core/concepts.md](../core/concepts.md) 的「派工與執行」）。所以產 issue 的工作拆成兩半，各自落在做得了的那一側：

**planning agent（LLM）負責語意判斷：**

- 從討論拆出要做哪些 issue
- 分群：哪些 issue 適合綁在同一個 group（可一起 review、合併 simplify）
- 預測每個 issue 會碰哪些檔（`touches[]`）
- 判定 `e2e`／`needs_human` 旗標
- 重複偵測：對照 base branch 的 code，判斷討論要做的事是不是已經有了（不比 issue 清單，直接讀 code）

**orchestrator（確定性）負責機械工作：**

- 用 `touches[]` 算檔案重疊，判定跨 group 與 group 內的 block 關係
- 拓撲排序
- 配 group 序號與 issue 全域號、生 front matter、寫檔、commit

這個 split 跟既有設計一致：chat 產結構化 draft、`createGroupFromDraft` 做寫入。差別是中間多一道 planning，把原本「chat 直接定稿」拆成「chat 產 rough draft → planning 產最終 group(s) → orchestrator 落地」。

**為什麼不擴充 chat。** planning 需要讀 orchestrator 餵的活 issue 檔案範圍，那是運行時狀態。把運行時狀態塞進 chat 的常駐對話會污染它、也讓 chat 的工具限制（只讀 repo code）變得不清。planning 是一次性呼叫、吃結構化狀態、不做對話，跟 chat 的常駐雙向串接是兩種形狀。

**planning 只建議不寫入。** 跟 chat 同一份 `--tools Read,Glob,Grep` 限制：讀 base branch code、讀討論 draft、產結構化建議，不寫檔、不 commit。人看過、調整過，按定稿按鈕才落地。拆 issue 與排依賴是人最該介入的決策點，不該讓 LLM 自動生效。

**planning 不負責估算成本時程，也不改寫討論措辭。** 成本要依賴實際 codebase 大小與歷史 run 資料，不是討論內容推得出來的；措辭潤飾等於讓 LLM 自己加 spec，跟 coder「不重新規劃 group」是同一條規則的延伸。

### 沒有 tester agent

`reviewing` 的 `test_verification` phase 裡的測試由 orchestrator 的 subprocess 跑，不是 LLM；狀態機裡沒有獨立的 testing 狀態。

拆解原本要給 tester 的四項職責：跑測試由 orchestrator 執行指令看 exit code，比 LLM 可靠且免費；測試覆蓋判定由 reviewer 承接，它已經在讀含測試檔的完整 diff；挑相關測試省下的時間比不上 LLM 呼叫的成本，挑錯還會漏測；失敗診斷由 coder 自己做，它在 worktree 裡有 Bash。

四項都有更便宜的承接者，tester 沒有不可替代的職責。

特別是「跑測試」不該給 LLM：coder 說測試通過和測試真的通過是兩件事，orchestrator 自己跑指令才是驗證，再派一個 LLM 去跑同一個指令只是多一個會說謊的環節。

測試由 coder 跟實作一起寫。獨立的 tester 寫測試能解決 confirmation bias，但會引入 coder 改實作迎合測試、tester 改測試迎合實作的對打，而自動流程裡沒有仲裁者，人不在時會空轉到重試上限。confirmation bias 有更便宜的解：reviewer 讀 diff 時判斷測試是否測到真正該測的行為。
