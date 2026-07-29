# loom

狀態機驅動的本地多 Agent 編排系統。

## 目標

以 spec 資料夾為輸入，自動驅動 coder 與 reviewer 完成實作與驗證，最終由人決定是否 merge。

無人值守是核心目標：晚上啟動一個 spec，隔天早上看結果。所有設計取捨在「減少人工介入次數」與「其他考量」衝突時，優先前者。

## 核心概念

| 概念 | 定義 |
|---|---|
| workspace | 一個 git repo 加上它的 specs 路徑與執行設定 |
| spec | `/to-spec` 與 `/to-tickets` 的產物，一個資料夾，含 `spec.md` 與 `issues/NN-*.md` |
| issue | 唯一的工作單元，狀態機作用在這一層 |

spec 不是狀態機的主體。它提供四件事：agent 的 prompt context、衝突域宣告（同 spec 的 issue 序列執行）、kanban swimlane、merge 單位。

## 提示詞的來源

loom 不依賴 [mattpocock/skills](https://github.com/mattpocock/skills) 這個 plugin，而是把它的內容裁剪後**內嵌成 loom 的預設提示詞**。MIT 授權，vendored 的模板頂部保留版權聲明。

不裝 plugin 的理由：loom 的流水線行為若依賴外部 plugin，上游一更新 coder 和 reviewer 的行為就變了，而 loom 這邊沒有任何訊號。內嵌之後提示詞是 loom 自己的資產，可編輯、可裁剪、版本固定。

**價值在詞彙。** 他的 skill 裡是壓縮過的工程術語：`tracer bullet`、`vertical slice`、`blast radius`、`expand–contract`、`seam`、`deep module`、`frontier`。每個都是一段話的縮寫而 agent 認得。這決定了 loom 自己那層外框要多薄 -- **外框只負責遞交材料，不重講一遍怎麼做事**。把 `tracer bullet` 展開成「請把工作切成能獨立驗證的小塊」等於把壓縮效果丟掉，還跟內嵌的說法打架。

| loom 的提示詞 | 內嵌來源 |
|---|---|
| chat | `to-spec` 的 spec 模板（含 Testing Decisions）+ `to-tickets` 的 vertical slice 規則、expand–contract、`Blocked by` |
| coder | `implement` + `tdd`（攤平） |
| issue reviewer | `code-review` |
| spec reviewer | `code-review` + `codebase-design` 的深模組與 seam 視角 |

### 攤平時要改的一條規則

`tdd` 要求「Test only at pre-agreed seams. Before writing any test, confirm them with the user」。無人值守流程裡沒有 user 可以確認。

他自己已經解了：`to-spec` 的流程要求先勾勒 seam 並與人確認，spec 模板有 **Testing Decisions** 一節。所以 seam 在 chat 階段（人在場）決定並寫進 `spec.md`，coder 從那裡讀。攤平時把「跟使用者確認」改寫成「seam 已定義在 spec.md 的 Testing Decisions，照那個做，不要自己新增」。

因此 chat 的提示詞有一條硬性要求：**必須產出 Testing Decisions**。

### 不內嵌的部分

`triage`、`grilling`、`domain-modeling`、`research`、`prototype` 是 HITL 或在 loom 流水線之外，人自己在終端機用就好。

**`wayfinder` 尤其不融。** 它是規劃階段：決策票、fog of war、一次一個決定，產出的是「路怎麼走清楚了」，之後才輪到 spec。loom 的輸入在那之後兩層。硬融進來會讓看板同時裝決策票和實作票兩種本質不同的卡片。

### 專案自己的詞彙表

他的 skill 反覆引用 `CONTEXT.md` 與 `docs/adr/`。對省 token 來說這層比通用工程術語更有效 -- 通用術語是他的專業，`slot`、`occupancy`、`week strip` 在你這裡是什麼意思是你的專業。

loom 不需要注入這些內容，agent 有 Read 工具，提示詞裡一句「先讀 `CONTEXT.md` 與相關 ADR」就夠。

**不為詞彙表與規範文件開設定欄位。** 三層已經蓋住：

1. **`CLAUDE.md` 是免費的。** coder 的 cwd 是 worktree，裡面有完整 checkout，Claude Code 自動往上找 `CLAUDE.md` 載入。專案規範寫在那裡，loom 完全不參與。（`--bare` 會跳過 CLAUDE.md 自動探索，這是不用 bare 的另一個理由。）
2. **詞彙表路徑寫在提示詞裡**，而提示詞已經可編輯 -- 路徑本身就是設定。另開欄位等於同一件事有兩個地方可以改，遲早不一致。
3. **路徑不在慣例位置時，在 `CLAUDE.md` 寫一行指路。** agent 自動載入就知道了。

設定頁的檢查項是純資訊性的：看慣例位置有沒有 `CLAUDE.md` 與 `CONTEXT.md`，缺了提示先跑 `/domain-modeling`，不是必填欄位，也不擋執行。

人在終端機用他的 plugin 手動跑 `/to-spec` 產 spec，loom 照樣讀得到那些檔案，兩者不衝突。

## 狀態機

### issue 層

```
draft ──finalize──▶ ready
ready ──派工──▶ implementing
implementing ──ok──▶ review_ready ──派工──▶ reviewing
  reviewing ──pass──▶ test_ready ──▶ testing
  reviewing ──reject──▶ implementing
  testing ──pass──▶ done
  testing ──fail / build fail──▶ implementing
中間狀態（implementing / review_ready / reviewing / test_ready / testing）
  ──error 或超過重試上限──▶ blocked ──人工──▶ ready
blocked ──人按「先收目前進度」──▶ dropped
human ──人做完手動標──▶ done
human ──人改主意──▶ ready
```

十一個狀態。`done` 與 `dropped` 是終端狀態，聚合時都算「不必再做」。

`draft` 只用於人手寫丟進 specs 資料夾的 issue。`/to-tickets` 產出的 issue 帶 `**Status:** ready-for-agent`，匯入後直接進 `ready`。

**`human` 是不派工的狀態。** 來自 `/triage` 的 `ready-for-human`，或 chat 產 issue 時標記的 `needs_human`：需要判斷、需要外部存取、需要手動測試的 issue。loom 不 spawn 任何 agent，看板上獨立顯示等人處理，人做完手動標 done，序列繼續。

沒有這個狀態的話，這類 issue 會被 agent 抓走、撞牆三次、進 blocked，浪費三輪完整實作才得到「這件事本來就不該自動做」這個結論。

**`dropped` 是「先收目前進度」的落點。** blocked 的 issue 與所有直接或間接依賴它的未開工 issue 一起標成 `dropped`，spec 隨即進 verifying，跑整體 e2e 與 spec review，通過才進 mergeable。沒被丟掉的部分照常合併，未完成的部分由 spec review 的意見帶到人面前。

這解掉 B 方案的 all-or-nothing 風險：issue 05 反覆失敗時，01 到 04 的成果不會一起卡在 branch 上落不了地。

diff 為空不算失敗，送 reviewer 判定是「確實已被前一個 issue 解決」還是「根本沒做」。

### spec 層

```
所有 issue 到達終端（done 或 dropped）──▶ verifying（跑整體 e2e 與 spec review）
  綠 ──▶ mergeable（等人點按鈕）
  紅 ──▶ orchestrator 產生一個新 issue 進清單，spec 回到執行中
mergeable ──人點按鈕──▶ merged
git 操作失敗 ──▶ spec 層 blocked（寫 blocked_reason）──人處理完──▶ 回原狀態
```

**`spec.md` 的 front matter 只有兩個欄位：`merged` 與 `blocked_reason`。** 其餘全部由 issue 狀態聚合算出。

這兩個欄位存在的理由相同：**它們是 issue 推不出來的事實**。所有 issue 都 done 不等於人按過合併；而 rebase 衝突、最終 merge 衝突、agent 越界改到 specs 這三種失敗都發生在「沒有任何 issue 處於中間狀態」的時刻 -- issue 之間，或所有 issue 完成之後。通往 blocked 的邊從中間狀態出發，那些時刻沒有 issue 可以承載它。

`blocked_reason` 的值域：`rebase_conflict`、`merge_conflict`、`specs_touched`、`e2e_loop`。

聚合表**由上而下 first-match**，第一列命中就停：

| 順序 | 顯示狀態 | 判斷方式 |
|---|---|---|
| 1 | merged | front matter 的 `merged` |
| 2 | spec blocked | front matter 的 `blocked_reason` 非空 |
| 3 | blocked | 任一 issue 是 `blocked` |
| 4 | 等人動手 | 下一個該做的 issue 是 `human` |
| 5 | 執行中 | 任一 issue 在 implementing、review_ready、reviewing、test_ready、testing |
| 6 | verifying / mergeable | 所有 issue 到達終端，再看 DB 裡整體 e2e 與 spec review 的結果 |
| 7 | 排隊中 | 至少一個 `ready`，且沒有任何 issue 在中間狀態 |
| 8 | 草稿 | 全部 `draft` |

first-match 是必要的：`blocked` 與「執行中」可以同時成立（`Blocked by` 止血讓不相干的 issue 在別的 issue blocked 時繼續跑），`blocked` 與「等人動手」也可以。互斥寫法無解，優先序才有。

第 7 列的述詞是「至少一個 ready」而不是「全部 ready」，因為 done 與 ready 混合是設計自己製造的常態：spec review 意見轉成 issue、整體 e2e 紅開新 issue，兩條路徑都往全 done 的 spec 加一個 ready。

**中間狀態一律用列舉，不用 `*ing` 字面。** `review_ready` 與 `test_ready` 是有自己派工轉移的持久狀態，字面上不含 ing，用萬用字元寫會漏掉它們 -- orchestrator 因用量視窗暫停時整批狀態會凍在那裡。崩潰恢復的掃描用同一份列舉。

整體 e2e 失敗產生的 issue 由 orchestrator 用模板寫：標題是失敗的測試名稱，body 是 tail 輸出，**並且一律帶 `e2e: true`**。沒有這個旗標的話，這個為了修 e2e 而生的 issue 只會被 typecheck、unit test、review 驗證，coder 交出看起來合理但沒真正修好的改動就能通過，回到 verifying 又紅，再開一個新 issue，每個新 issue 帶全新的重試計數，永遠不收斂。

**同一個 spec 因整體 e2e 紅自動開 issue 累計 2 次為上限**，第 3 次改成把 spec 標成 `blocked_reason: e2e_loop` 等人看。理由跟 spec review 不自動開 issue 一樣：自動加工作的迴圈一定要有終止條件。

### kanban

顯示 issue 卡片，spec 名稱當 swimlane。

**看板只放需要人或機器動作的 spec。** 展開的 lane 是 blocked、mergeable、執行中、排隊中；draft 與 merged 各收成一行，點開才展開。

離開看板的時機是 **merged，不是所有 issue 都 done**。全綠但還沒合併的 spec 需要人動手，lane 要留著讓人翻看那幾張卡再決定。

不做這個切分的話，跑一個月就是四十條全是 done 卡片的 lane 把工作區淹掉。已合併的 spec 要查就去 specs 資料夾或 git log，不另做歷史檢視。

不做拖拉。人能觸發的轉移有六條，每一條對應一顆按鈕，兩邊互為檢查：

| 按鈕 | 對應的邊 |
|---|---|
| 草稿 spec 放行開跑 | `draft ──▶ ready`（該 spec 全部 issue） |
| blocked 恢復 | `blocked ──▶ ready` |
| blocked 先收目前進度 | `blocked ──▶ dropped`（含所有下游未開工 issue） |
| spec blocked 恢復 | 清除 `blocked_reason`，回原狀態 |
| human 標為完成 | `human ──▶ done` |
| human 退回 ready | `human ──▶ ready` |
| mergeable 觸發 merge | `mergeable ──▶ merged` |

（七顆按鈕對應六條 issue 層的邊加一條 spec 層的清除動作。）

做拖拉就要實作一套「哪些拖動合法」的規則，而這些用按鈕表達更清楚，而且拖拉在手機上難用。

## git 拓撲

| 項目 | 決定 |
|---|---|
| 分支 | 一個 spec 一條 `spec/<name>`，一個 worktree |
| worktree 位置 | `~/.loom/worktrees/<workspace>/<spec>`，放 repo 外避免被 glob、watcher、test runner 掃到 |
| issue 執行順序 | 同 spec 依編號序列，跨 spec 平行；有 issue 卡住時用 `Blocked by` 判斷哪些後續仍可做 |
| 平行上限 | 預設 2。每個跑動的 spec 佔一個 worktree、一份依賴、可能一個 dev server、一個 claude process |
| merge 粒度 | spec 全綠才一次 merge 回 main，人工觸發 |
| coder 交棒時 | **orchestrator 代 commit**，見下節 |
| 每個 issue 完成後 | rebase spec branch 到最新 main，衝突就寫 `blocked_reason: rebase_conflict` |
| 按下 merge 時 | 先 rebase；若帶進**碰到 specs 以外路徑**的 commit 才退回 verifying 重驗，過了才真的合併 |
| merged 之後 | `git worktree remove` 加 `git branch -d spec/<name>` |

### worktree 那一側的寫入契約

specs 資料夾那側規定得很死（只有 orchestrator 在 main checkout 寫）。spec branch 這側要有對等的規定，否則 review、rebase、reset、merge 四條路徑都預設「coder 的產出已經被固化」而沒人負責固化。

**commit 由 orchestrator 代做，不由 coder 做。** coder subprocess 正常結束且回傳 `done: true` 時，orchestrator 在該 worktree 執行：

```
git add -A
git commit -m "<NN> <issue title>"
```

然後才把 issue 轉成 `review_ready`。

不讓 coder 自己 commit 的理由：coder 忘了 commit 是靜默失敗，而且症狀完全誤導 -- `git diff <base_sha>..HEAD` 恆為空，每個 issue 都會走進「diff 為空送 reviewer 判定」被判成「根本沒做」退回 implementing，而 worktree 裡躺著完整實作；接著 rebase 在髒工作區上失敗。要讓 coder 自己 commit，就得在 schema 加 `commit_sha` 讓 orchestrator 驗證它真的做了，那還不如 orchestrator 直接做。

**清理一律是三段式**，不是單一 reset：

```
git rebase --abort || true
git reset --hard <base_sha>
git clean -fd
```

`git reset --hard` 不刪 untracked 的新檔，也不中止進行中的 rebase。崩潰恢復與 domain 第三次「從乾淨狀態重寫」宣稱的乾淨，只有加上 `rebase --abort` 與 `clean -fd` 才成立。少了 `clean -fd`，agent 死在半路留下的新檔會被下一輪 coder 繼承，而且因為是 untracked，`git diff` 看不到、reviewer 也看不到。

**worktree 在 spec merged 之後回收。** 不回收的話每個跑過的 spec 留下一份完整 checkout 加一份 `loom:setup` 裝出來的依賴，平行上限只限制同時跑幾個、不限制累積幾個。磁碟滿之後 `loom:setup` 與 git 操作開始失敗，被歸成 setup 失敗直接 blocked，早上看到一排像是 agent 做壞的 blocked，根因是磁碟。

### 多個 spec 平行時的三個交互點

**分支漂移**：靠每個 issue 完成後的 rebase 吸收其他 spec 已合併的東西，不會累積成巨大分歧。

**撞車**：兩個 spec 改到同一批檔案，後者的 rebase 會衝突進 blocked。不做預先偵測 -- 那需要 chat 產 spec 時宣告「會動到哪些路徑」，而 agent 經常改到沒預期的檔案，不可靠的預測會給出假的安全感。rebase 衝突本身就是可靠的安全網，代價只是手動把其中一個往後排。看板上要把「blocked 原因是 rebase 衝突」標清楚，讓人一眼看出是撞車不是 agent 做壞。

**過期的驗證結果**：spec 進 mergeable 後等人按按鈕的期間，另一個 spec 可能已經合併。所以按下 merge 時先 rebase，若帶進新 commit 就退回 verifying 重驗。這是「七個綠燈的 issue 疊起來未必綠」同一個論證的延伸：兩個各自綠燈的 spec 疊起來也未必綠。

**但判定必須排除 loom 自己的狀態 commit。** 每個 issue 進 done 時 orchestrator 都往 main 塞一個只動 specs 的 commit，所以另一個 spec 只要還在跑，main 就一直在前進。照「帶進任何新 commit 就重驗」會讓 mergeable 的 spec 被反覆打回 verifying 跑幾分鐘 e2e，而帶進來的東西跟任何 code 無關，每次還要人再按一次按鈕。判定式是：

```
git diff --name-only <old-main>..<new-main> -- . ':!<specs_dir>/'
```

輸出為空就直接合併，不重驗。

merge 本身不需要額外的鎖，orchestrator 是單一事件迴圈，兩個 merge 不可能同時發生。

### Blocked by 只用來止血

`/to-tickets` 強制每個 ticket 宣告 blocking edges：

```
01-fix-e2e-page-object              Blocked by: None
02-extract-slot-timeline-module     Blocked by: None
03-shared-timeline-range            Blocked by: 02
04-split-shared-components-...      Blocked by: 02
05-migrate-modals-to-form-modal     Blocked by: None
06-mobile-layout                    Blocked by: 04
07-mobile-e2e-coverage              Blocked by: 01, 06
```

這個資訊已經在檔案裡，loom 不需要要求任何額外的宣告。

**唯一用途是在有 issue 卡住時，判斷哪些後續不受影響。** 上例中 02 進 blocked，03、04、06、07 都直接或間接依賴它，但 05 可以繼續做，spec 不會整條停擺等人半夜起來處理。

**不用來平行化。** 一個 spec 一個 worktree，兩個 issue 同時改同一份 checkout 會撞。邊只改變「跳過哪些」，不改變「同時幾個在跑」。

**正常路徑上完全不改變行為。** to-tickets 產 ticket 時就是 numbered in dependency order，編號本身已經是拓撲排序，照編號跑永遠合法。

實作範圍因此很小：解析那一行，在 blocked 發生時算一次可達性。不需要排程器，不需要 DAG 執行引擎。

**風險與緩解**：依賴邊是人或 LLM 宣告的，會漏。漏宣告會讓 loom 跳過去做 05，但 05 其實需要 02 的產出。緩解就是上面那條限制 -- 只在有東西卡住時才用邊跳過，正常情況照編號。漏宣告的代價只出現在異常路徑，而異常路徑本來就是人要看的。沒有這一行的 issue（手寫的）預設當成依賴前一個，退回編號序列。

### base_sha

orchestrator 在每個 issue 開工時記下 spec branch 當下的 HEAD，存進 DB。

reviewer 用 `git diff <base_sha>..HEAD`。沒有這個欄位的話只能用 `git diff main..HEAD`，那會包含同 spec 前面所有 issue 的改動，issue 07 的 review 會看到 01 到 06 的全部東西。

base_sha 同時提供「退回 issue 開工前」的能力，重試策略依賴它。

### 狀態寫入

狀態存在 issue 檔案的 front matter，git-tracked，跟著專案走。

強制規則：

1. **只有 orchestrator 在 main checkout 寫 front matter，agent 的 worktree 不碰 specs 資料夾。** 單邊修改 git 自動合併，雙邊寫同一個 YAML 就是衝突。
2. merge 前檢查 diff 是否碰到 specs 路徑，碰到就 blocked。
3. front matter 只放狀態機需要的欄位。review 意見全文、測試輸出、session id、耗時、成本進 DB。那些是幾 KB 的雜訊，塞進 git-tracked 檔案會讓每次狀態轉移的 diff 無法閱讀。
4. 每個 issue 進 done 時一次 commit 狀態到 main。中間轉移只寫檔不 commit，崩潰後從檔案讀，沒有損失。全部轉移都 commit 的話七個 issue 會產生四十幾個雜訊 commit。

### 來源過期偵測

`spec.md` 在開跑後還是可以改（`--resume` 回原對話討論、或直接編輯）。已經 done 的 issue 是照舊版做的，沒有任何東西指出這件事。「開跑後只能改還沒開始的 issue」這條規則只約束 issue 檔，而且沒有執行機制。

**機制**：`issue_state` 存一欄 `source_hash`，在每次 `doImplement` 開頭記下 `sha256(spec.md body + 該 issue 檔 body)`。讀取時比對當前值，不同就標過期。

三條限制：

1. **過期是 derived boolean，不是第十二個狀態。** 不進 front matter、不動 `transition`／`aggregateSpecStatus`。
2. **只對 done 有意義。** 還在跑的 issue 下一輪本來就會讀到新內容。
3. **不擋 merge。** 錯字修正不該擋 merge，跟 spec review 意見同一層級：看板上的徽章，不是門禁。

hash 的是 **body 不是整檔**。front matter 由 orchestrator 自己寫，`merged: true` 在 merge 那一刻寫入，拿整檔算 hash 會讓所有 issue 同時變過期。

spec.md 與 issue 檔合成一個 hash，不分兩欄：人的處置不分兩種，而且舊版長什麼樣 git 已經有了（每個 issue done 時 orchestrator 都 commit 過 specs），不需要另存內容。

人有兩個動作：**重做**（該 issue 回 ready，清掉 base_sha 讓下一輪重新開工）與 **忽略**（把 `source_hash` 更新成當前值）。重做只退那一個 issue，不自動連坐下游 -- 下游有沒有真的受影響只有人判斷得出來，自動連坐會在無人值守的時段把本來正確的東西重跑一遍。

因為 `source_hash` 必須跨輪存活，`clearIssueState` 是把 `base_sha` 與重試計數歸零，不是整列 DELETE。

`spec_reviewer` 做不到這件事：它看「當前 code 對當前 spec」，沒有時間維度，抓得到 code 與新 spec 牴觸，抓不到 code 只是沒實作新 spec 多出來的約束（那種缺漏沒有矛盾可偵測）。而且它在整個 spec 完成後才跑一次，那時要重做的 issue 底下已經疊了後面所有 issue。

## 失敗與重試

| 類別 | 事件 | 處理 |
|---|---|---|
| domain | review reject、test fail、build fail | 退回 implementing，吃 domain 額度 |
| domain | diff 為空 | 送 reviewer 判定，不計 |
| infra | subprocess 非零退出、API error、輸出不符 schema | 原地重跑，獨立計數加 backoff |
| infra | 超時、setup 失敗 | 直接 blocked |
| git | rebase 衝突、越界改到 specs、最終 merge 衝突 | 寫 spec 的 `blocked_reason`，不動任何 issue |
| 用量 | 訂閱用量視窗用盡 | 不動 issue 狀態，整個 orchestrator 暫停到視窗重置 |

git 這一類寫 spec 層而不是 issue 層，因為它們全部發生在沒有 issue 處於中間狀態的時刻。詳見「spec 層」那節。

三條原則：

- **infra 重試與 domain 重試是兩個獨立計數器。** API 掛掉重連三次不該吃掉「agent 改 code 的機會」那三次，否則網路抖一下就把一個好 issue 判死。
- **重試的前提是「再跑一次可能不同」。** API error 成立；超時不成立（同樣的工作量會同樣超）；git 衝突更不成立（同樣的樹會同樣衝）。不成立的一律直接 blocked。
- **e2e 紅了先原地重跑一次**，兩次都紅才算 domain fail。不這樣做的話一次 flaky 就吃掉一格重試額度。unit test 不需要這層。

### 用量視窗用盡是全域事件

以訂閱制執行時（OAuth 登入，不是 API key），額度是帳號層級的時間視窗，不是單次呼叫的問題。

它不能歸進 infra error：那個 issue 沒有錯，而且下一個 issue spawn 也會一樣失敗。照 infra 規則處理的話，額度在半夜用完，早上會看到一整排 blocked 的 issue，而實際上視窗二十分鐘後就重置了。

處理方式是暫停整個 orchestrator，issue 停在原狀態，看板顯示暫停原因與預估恢復時間，視窗重置後自動繼續。

**但辨識規則必須寫死，否則這條路走不到。** 額度用盡在 orchestrator 眼裡也是「subprocess 非零退出」，跟 infra error 是同一個現象。判定依據：result 事件的 `subtype` 與 `is_error`，加上一份 stderr 字串比對清單。**判定不出來的一律歸 infra**，這是安全的預設 -- 誤判成 infra 只是多重試三次，誤判成用量用盡會讓整個 orchestrator 白白停住。

這條判定依賴外部工具的錯誤訊息形狀，屬於「升級 Claude Code 時要檢查」的假設之一。所以看板上要有一個**手動的「暫停 / 恢復 orchestrator」開關**，讓判定失效那天人有辦法止血，不必去改 code。

### domain 重試策略

前兩次在現有 code 上修，第三次用「worktree 那一側的寫入契約」定義的三段式清理退回 base_sha 從乾淨狀態重寫，帶著前兩次的失敗紀錄當警示，再不成才 blocked。

理由是 agent 反覆修同一份 code 到第三次時，裡面通常堆滿互相矛盾的嘗試痕跡，從頭寫比繼續補容易。代價是多燒一次完整實作，而且丟掉的可能已經接近正確。

### 崩潰恢復

orchestrator 重啟後做兩件事，順序不能顛倒。

**一、對每個未 merged 的 spec worktree 跑一次一致性檢查**，不管它的 issue 處於什麼狀態。檢查 `.git/rebase-merge` 與 `.git/rebase-apply` 是否存在、`git status --porcelain` 是否乾淨。不乾淨就跑三段式清理。

只看 issue 狀態會漏掉一整類情況：每個 issue 完成後的 rebase 發生在「前一個已 done、下一個還是 ready」的時刻，沒有任何 issue 在中間狀態。orchestrator 死在那裡，恢復邏輯不會碰這個 spec，下一個 issue 直接在 rebase 中途的樹上開工，記下的 base_sha 是 rebase 中途的 HEAD。

**二、依中間狀態分兩種處理，不是一律回捲：**

| 卡住的狀態 | 處理 |
|---|---|
| implementing | 三段式清理退回 base_sha，回 `ready`，不計重試 |
| review_ready、reviewing | 退回 `review_ready` 重派一次 reviewer，**不動 code** |
| test_ready、testing | 退回 `test_ready` 重跑一次測試，**不動 code** |

一律回捲是錯的：reviewer 只讀 diff 不寫檔，testing 的執行者是 orchestrator 的 subprocess 不是 LLM，兩者都不會留下「半改而 agent 不知道」的樹。orchestrator 在整體 e2e 期間崩潰是常見情形（e2e 很容易把機器打爆），照一律回捲會把已經通過 review 的 commit 全部丟掉，issue 從 ready 重跑一整輪，而且「不計重試次數」代表這次浪費連計數器都不會記住。無人值守整晚時這是白燒一次完整實作。

implementing 要回捲，因為那是唯一可能死在 tool call 中間、留下半改工作樹的狀態。

不用 `--resume` 接回中斷的 session：process 可能死在 tool call 中間，worktree 是半改狀態而 agent 不知道自己被中斷過。乾淨重來可預測得多。

## Agent

### 拓撲

orchestrator 持有狀態並依狀態 spawn 對應的 subprocess。不是 coder 呼叫下一棒，也不是 agent 自己輪詢搶單。

不用 coder 呼叫下一棒的理由：狀態會被藏進黑箱，orchestrator 不知道跑到哪一步，kanban 沒東西可顯示；崩潰無法續跑；reviewer 作為 coder 的子 agent 會繼承 coder 的 context 和它對自己實作的信心，那不叫 review。

不用 agent 輪詢的理由：那需要常駐 daemon 各自掃狀態、各自搶單、處理兩個 agent 抓到同一個 issue。push 模型只有一個寫入者，沒有競爭者，體感一樣而實作少一半。

### 四個 LLM 角色

| 角色 | 輸入 | `--json-schema` 輸出 |
|---|---|---|
| chat | 對話，cwd 在 main checkout，`--disallowedTools Write Edit` | `{spec_md, issues:[{title, body, blocked_by[], e2e, needs_human}]}` |
| coder | spec.md + issue.md + 前次失敗紀錄 | `{done, summary, files_changed[]}` |
| issue reviewer | spec.md + issue.md + `git diff <base_sha>..HEAD` | `{verdict, comments[]}` |
| spec reviewer | spec.md + 全部 issue.md + `git diff main...spec/<name>` | `{comments[]}`，沒有 verdict，因為它不決定流程 |

coder 在交棒前自己跑一次 typecheck 與 unit test。這是 self-check，不是呼叫 tester；把編譯不過的東西丟給下一棒是浪費一整輪。

reviewer 的乾淨 context 是它獨立性的來源，不是缺點。它只該看 diff 和需求，不該看 coder 的辯解。

reviewer 同時負責判定測試品質：這些測試是在測行為還是在測實作細節、覆蓋夠不夠。不足就 `verdict: reject` 附 comment。

### 沒有 tester agent

`testing` 是一個狀態，但執行者是 orchestrator 的 subprocess，不是 LLM。

拆解原本要給 tester 的四項職責：跑測試由 orchestrator 執行指令看 exit code，比 LLM 可靠且免費；測試覆蓋判定由 reviewer 承接，它已經在讀含測試檔的完整 diff；挑相關測試省下的時間比不上 LLM 呼叫的成本，挑錯還會漏測；失敗診斷由 coder 自己做，它在 worktree 裡有 Bash。

四項都有更便宜的承接者，tester 沒有不可替代的職責。

特別是「跑測試」不該給 LLM：coder 說測試通過和測試真的通過是兩件事，orchestrator 自己跑指令才是驗證，再派一個 LLM 去跑同一個指令只是多一個會說謊的環節。

測試由 coder 跟實作一起寫。獨立的 tester 寫測試能解決 confirmation bias，但會引入 coder 改實作迎合測試、tester 改測試迎合實作的對打，而自動流程裡沒有仲裁者，人不在時會空轉到重試上限。confirmation bias 有更便宜的解：reviewer 讀 diff 時判斷測試是否測到真正該測的行為。

## 驗證

分兩層，便宜的檢查密集跑，昂貴的只在該跑時跑。

**每個 issue**：typecheck、unit test、review。

**issue front matter 宣告 `e2e: true` 的**：該 issue 也跑一次 e2e。

**spec 所有 issue done 後**：跑一次完整 e2e，以及一次 spec review，過了才進 mergeable。七個各自綠燈的 issue 疊起來未必綠。

### 兩層 review 抓的是不同的東西

不是同一件事的不同時機，是結構上看得見的範圍不同。

| 角色 | 讀的 diff | 唯一能抓到的 |
|---|---|---|
| issue reviewer | `git diff <base_sha>..HEAD` | 細節：這個改動有沒有做對自己的事、測試有沒有測到行為 |
| spec reviewer | `git diff main...spec/<name>` | 跨 issue 的一致性：重複的抽象、殘留的死碼、七個各自合理但疊起來歪掉的架構 |

issue reviewer 不能省：spec reviewer 的 diff 太大看不清細節，而且錯誤在序列鏈上會複利。spec reviewer 每個 spec 只跑一次，七個 issue 的 spec 總共多一次 LLM 呼叫。

**兩者失敗的處理不同，而且刻意不同：**

- **整體 e2e 紅了**：orchestrator 自動開一個新 issue（客觀失敗，一定要修）。
- **spec review 有意見**：只附在 mergeable 的 spec 上給人看，不自動開 issue。

spec review 不自動開工作，是因為架構層面的意見「要不要現在修」本身就是人的判斷 -- 可能值得，也可能該留到下一個 spec。讓 LLM 自動決定加工作是把判斷權放錯地方。這同時消掉了「LLM 傾向找得到東西、每個 spec 都自動長出新 issue、永遠收斂不了」的風險，不需要任何次數上限之類的補丁。

merge 按鈕已經是人的閘門，那些意見正好是按下去之前該讀的東西。

**spec reviewer 的 diff 由 orchestrator 算好傳進 prompt，整份送。** reviewer 只有 `Read`/`Glob`/`Grep`（唯讀），自己跑不出 `git diff`。整份送是因為這個角色要找的正是「不同 issue 各自引入了重複的抽象」「issue 03 建的東西被 issue 06 淘汰但沒刪」，那些只有攤開全貌才看得見；截斷等於廢掉它存在的理由，而逐個 issue 的 diff 已經被 issue reviewer 看過了。

成本上也不需要省：實測一個七個 commit 的分支約 130KB（約 38k token），在 200k context 裡佔不到五分之一，而一個 spec 只跑一次 spec review，同一個 spec 的 coder 與 issue reviewer 加起來是十幾次呼叫。

**排除產生檔，不截斷。** `package-lock.json`、`*.snap`、`dist/` 那類對「這個改動做對了嗎」零價值，卻很容易佔掉 diff 的九成。清單寫死在 `git.ts`，不開設定欄位（理由同「不為詞彙表與規範文件開設定欄位」）。超過上限時才降級成檔案清單加行數，讓 reviewer 用它的 Read 自己挑要看的 -- 它的 cwd 就是完整 checkout。那條路徑是給大型改名散佈到幾百個檔案的極端情況，平常不會走到。

### spec review 意見的處理

意見存 DB。點 lane 標頭時右側面板顯示 spec 層細節：整體 e2e 結果、review 意見清單、merge 按鈕。

只有兩個動作：

- **轉成 issue**：那條意見變成一個 issue 加進當前 spec 末尾，spec 退出 mergeable 回去跑。做完重新進 verifying，會再跑一次整體 e2e 與 spec review。這個循環由人觸發，不會失控。
- **直接 merge**：意見留在 DB 的歷史裡，不再提醒。

**不做「之後再說」的暫存。** 要存成 draft issue 就得掛在某個 spec 底下，而那個 spec 已經 merged、在看板上收起來了，人永遠看不到；要讓它可見就得改「已合併」的判定規則，為一個很少用的功能弄複雜整個聚合邏輯。

而且「之後再說」在實務上就是忘記。真的想留就去 chat 開一個新 spec，開的時候會重新判斷那件事還值不值得做，那個重新判斷比一條躺在待辦裡的舊意見有價值。

整批做完才驗證的問題不是省時間，是錯誤在序列鏈上會複利：issue 03 壞了但在 07 做完才發現，中間四個 issue 全建立在壞基礎上。而且 reviewer 讀七個 issue 疊起來的 diff，品質會明顯掉。

### dev server 生命週期

由 orchestrator 管理，不交給 agent。

進入 testing 時：跑 `loom:setup`（多數時候 no-op，但 agent 可能加了新依賴）、起 `loom:dev`、輪詢 `http://127.0.0.1:$PORT/` 直到有回應、跑 `loom:test` 以及必要時的 `loom:e2e`、殺掉整個 process group。

**每次進 testing 都重起 server，不跨 issue 重用。** HMR 未必涵蓋 config 變更、新增依賴、build-time 產物，重用會讓 issue 02 的測試跑在 issue 01 的 bundle 上。省下的幾十秒不值得這種假綠燈。

**loom 只保證 `PORT` 唯一，其餘隔離由專案的 script 負責。** 多個 spec 平行跑測試時，共用資源不只 port -- 本機資料庫、共用檔案、固定的瀏覽器 profile 都會互相污染。要獨立資料庫就在 `loom:setup` 裡用 `$PORT` 衍生一個名稱。隔離責任放在最清楚狀況的地方，loom 不需要理解任何專案的測試環境。真的隔離不了的專案把平行上限設 1。

**實作在 `src/devserver.ts`。** 認得的 script 是 `loom:setup`、`loom:typecheck`、`loom:dev`、`loom:test`、`loom:e2e`，後四者找不到時退回慣例名稱（`typecheck`、`dev`、`test`）；沒有 `loom:setup` 時依 lockfile 決定安裝指令（`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `package-lock.json`）。

typecheck 跑在起 dev server 之前：編譯不過就沒必要花幾十秒起一個 server。

**回傳值分三種，不是兩種。** `pass: true`；`failure: "domain"`（測試真的紅了，退回 implementing）；`failure: "infra"`（setup 失敗、任何一段超時、dev server 起不來，照失敗與重試的表格直接 blocked）。混成一種的話，一次基礎設施故障會吃掉 coder 改 code 的三次機會，而且第三次會觸發三階段清除把已經寫好的東西整個丟掉。

**「沒有可跑的東西」（沒有 `package.json`、沒有 typecheck/test/e2e script）回傳 `pass: true`**，但 output 明確寫出是哪一種並存進 `runs.summary`。這是刻意的取捨：非 Node 專案、還沒加 `loom:*` script 的專案不該讓整條流水線卡死，但也不該讓人以為測試真的跑過。**worktree 目錄根本不存在則是拋錯**讓排程器停住 -- 那是環境壞了，不是「這個專案沒有測試」，兩者都走 `pass` 的話 issue 會在沒有程式碼可測的情況下變成 done。

process 生命週期不交給 LLM 的理由：agent 超時被殺、自己崩掉、忘記 kill，server 就變孤兒佔住 port，症狀出現在下一個不相干的 spec 上，而且要手動 `lsof` 才找得到。orchestrator 是唯一確定知道「這一輪結束了」的角色。

### 失敗時的資訊傳遞

orchestrator 把測試 stdout 存進 DB，coder 下一輪的 prompt 帶最後 200 行，加一句「完整輸出自己重跑 test_command 看」。

全塞進 context 太貴，完全不給又逼它多跑一次。

## chat 產 spec

常駐 `claude -p --input-format stream-json --output-format stream-json`，web 端雙向串接，cwd 在 main checkout。

加 `--disallowedTools Write Edit`：它要能讀 repo code 才討論得具體，但不該碰任何檔案。

**拆 issue 在同一輪對話裡做**，不另外派 agent。拆分方式是設計決策：哪些改動綁在一起、誰先誰後、依賴邊怎麼連，這是人最該介入的地方。

落地時 agent 只用 `--json-schema` 產內容，orchestrator 負責編號、生 front matter、寫檔。狀態欄位不能讓 LLM 寫。

schema 裡的 `needs_human` 是分類旗標不是狀態欄位，跟 `e2e` 同一層級 -- 由 orchestrator 決定寫成 `human` 還是 `ready`。沒有它的話，chat 裡討論出「需要判斷、需要外部存取」的 issue 只能標成 ready，然後發生的正是 `human` 狀態要避免的浪費：被 agent 抓走、撞牆三次、進 blocked。

**定稿按鈕就是開跑按鈕。** 剛討論完內容已經看過，再插一道 draft review 是多餘摩擦。手寫丟進資料夾的 draft spec 才需要看板上的放行按鈕。

開跑後只能改還沒開始的 issue，可以追加新 issue，進行中和已完成的鎖住。orchestrator 本來就在派工前才讀 issue 檔案，所以這幾乎零成本。修改走 `--resume` 回到原對話以維持 spec.md 一致性，或直接編輯檔案。

## 實作

全 TypeScript，單一 Node process。web server 與 orchestrator 同 process、同事件迴圈，狀態直接共享，不需要 IPC 或第二個 store。

orchestrator 必須是單一事件迴圈：對 main 的 commit 必須序列化，且它是唯一的狀態寫入者。

| 項目 | 選擇 |
|---|---|
| server | Hono 或 Express，送 SSE |
| 前端 | React + Vite，build 成靜態檔由同一個 server 提供 |
| 資料 | `node:sqlite`（零依賴，會噴 ExperimentalWarning） |
| agent 執行 | `spawn('claude', [...])`，headless |
| 監聽 | `127.0.0.1`，無認證。要遠端就開 SSH tunnel |

### 用到的 claude CLI 能力

| 需求 | flag |
|---|---|
| headless 執行 | `-p` |
| 即時串流輸出 | `--output-format stream-json` |
| chat 雙向串流 | `--input-format stream-json` |
| 結構化回報 | `--json-schema`，state transition 不需要解析自然語言 |
| 角色設定 | 模板本身（見下） |
| 不被權限卡住 | `--permission-mode bypassPermissions`，限 worktree 內 |
| 隔離個人環境 | `--setting-sources project,local`、`--strict-mcp-config`、`--disable-slash-commands` |

預設仍是 `--output-format json`（一次性拿完整結果）；`runClaude()` 另外加了一條 `--output-format stream-json` 逐行解析的路徑，只在呼叫端給了 `onEvent` 回呼時啟用（見「觀測」一節），沒給就完全走原本的路徑，兩者共用同一套 result 事件判讀邏輯。

**角色設定沒有用 `--append-system-prompt`，整份模板走 stdin。** 提示詞改成可編輯之後，模板本身就包含角色說明與材料（`{spec_md}`、`{issue_md}` 那些變數），拆成「system prompt 那半可編輯、user prompt 那半程式組」會讓「一個角色一份模板」這件事變成兩個地方可以改。代價是那些指示落在 user turn 而不是 system prompt。

**實測到一個非文件記載的行為，寫下來省得下次重踩：** `--output-format json` 的輸出形狀不是恆定的。不帶隔離 flag（`--setting-sources`/`--strict-mcp-config`/`--disable-slash-commands`/`--permission-mode`）時印整條 session 的事件陣列；production 實際用的 flag 組合下，只印最後那個 `result` 事件本身，不包陣列。`src/claude.ts` 兩種都處理（`Array.isArray` 判斷）。

**`rate_limit_event` 的 `overageStatus` 不是用量用盡的判定依據。** 實測（2.1.220，stream-json）一次完全成功的呼叫會帶：

```json
{ "status": "allowed", "rateLimitType": "five_hour", "resetsAt": 1785313200,
  "overageStatus": "rejected", "overageDisabledReason": "out_of_credits",
  "isUsingOverage": false }
```

`overageStatus: "rejected"` 只代表這個帳號沒開啟超額付費，是常態設定。曾經把它當成判定條件，在 `--output-format json` 的路徑下沒有症狀（那條路徑看不到 `rate_limit_event`），但一改用 stream-json 就變成每一次呼叫都被判成用量用盡、orchestrator 第一次呼叫就停住。判定只看 `status`。真的撞到上限時 `status` 會是什麼值還沒有樣本，所以維持保守預設：判不出來走 `infra_fail`（重試三次），不是 `usage_exhausted`（整條停住）。

### agent 繼承什麼環境

coder 的 cwd 是 worktree，Claude Code 會自動載入那裡的 `CLAUDE.md` -- 這是想要的，專案規範免費進到每個 agent。

但預設也會把整台機器的個人環境一起帶進來。實測結果（`claude -p` 2.1.220）：

| flags | 專案 `CLAUDE.md` | 全域 `~/.claude/CLAUDE.md` | 個人 SessionStart hook |
|---|---|---|---|
| 預設 `-p` | 載入 | 載入 | 觸發 |
| 加上三個隔離 flag | 載入 | 仍載入 | 關掉 |
| 再加 `--system-prompt` | 載入 | 仍載入 | 關掉 |

**hook、plugin、MCP 可以隔離，全域 `CLAUDE.md` 不行。** `--system-prompt` 擋不掉，它是 memory 不是 system prompt 的一部分。

能全關的有兩個，兩個都不用：`--bare` 只吃 API key，跟訂閱制決定衝突；`--safe-mode` 不強迫換 API key，但它把 `CLAUDE.md`、skills、plugins、hooks、MCP 一起關掉 -- 包含專案自己的 `CLAUDE.md`，而那正是我們想要的東西。為了擋掉個人偏好而連專案規範一起犧牲，不划算。

隔離 hook 特別重要：個人的 SessionStart hook 會對每個 coder 生效，而人不會意識到那跟 loom 有關 -- 調整個人設定就默默改變了流水線行為。

**全域 `CLAUDE.md` 接受它。** 加提示詞說「忽略無關的個人偏好」不可靠，不做。要處理的話是使用者自己把純對話偏好移出 `~/.claude/CLAUDE.md`：那些內容對產出 JSON 和 code 的 headless agent 不適用，卻乘上每個 spec 十五次呼叫。

### 驗證方式

兩種都能跑，差別只在啟動 `claude` 時的環境變數，不需要抽象層。

**訂閱制（OAuth）**：官方支援，`claude -p` 與 Agent SDK 的用量算進訂閱額度（[Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)）。代價是會撞到 5 小時與每週的用量視窗，見「用量視窗用盡是全域事件」。

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

**設定**：workspace 清單與每個 workspace 的 `specs_dir`、`main_branch`、`port_range`、平行上限。在 web UI 上編輯。新增 workspace 時只輸入 repo 路徑。

執行指令不存在設定裡，見下節。

### 提示詞在 web UI 上可調

四個角色各一份可編輯的模板，存 DB，per-workspace。沒有繼承或覆寫的兩層邏輯。

**只有被編輯過的角色才在 DB 裡有一列**，沒有那一列就讀內建預設。原本寫的是「新增 workspace 時複製一份內建預設」，實作時改成這樣：複製的話，內建預設之後有任何修正都不會傳播到已存在的 workspace，而那些 workspace 的擁有者根本沒動過那個角色的模板；而且「這份是不是還停在出廠預設」得拿內容跟預設做字串比對才知道，改成有沒有那一列就直接是答案。「還原預設」因此是刪掉那一列，不是複製一份預設寫回去。

**預設內容就是內嵌自 mattpocock/skills 的攤平版本**（見「提示詞的來源」），整份可編輯。每個角色下方列出可用變數，設定頁附「還原預設」把它復原成內嵌的出廠版本。

模板大致的形狀：

```
[內嵌的 implement + tdd 內容]

seam 已定義在下面 spec 的 Testing Decisions，照那個做，不要自己新增。
交棒前自己跑一次 typecheck 與 unit test。
不要修改 specs 資料夾裡的任何檔案。

<spec>{spec_md}</spec>
<issue>{issue_md}</issue>
<上一輪失敗>{last_failure}</上一輪失敗>
```

**`--json-schema` 不可編輯，在 UI 上顯示為唯讀。** 那是狀態轉移的判定依據，改壞了 orchestrator 讀不到 verdict 就整條流水線停擺，而症狀會表現成「agent 一直失敗」，很難查到根因。prompt 本體改壞了最多是產出品質變差，還救得回來。

為什麼要可編輯：內嵌的內容是通用的，不知道你這個專案的慣例、不知道 loom 的失敗紀錄要怎麼餵、不知道測試輸出只給 tail 200 行。那些是 loom 與專案的上下文，寫死在程式碼裡就沒得調。

**coder 只有一份模板，不分首次與重試。** `{last_failure}` 為空時那一段就是空的。重試輪其實可以加上 `diagnosing-bugs` 的內容，但先不加 -- 多一份模板就多一份要維護的分岔，等重試品質被證明不夠再說。

**不做版本歷史，編輯就是覆蓋。** 因此同一個 issue 的第一次與第三次嘗試可能用不同版本的模板，`runs` 也不記錄用了哪一版。這是刻意的：看到 coder 一直踩同一個坑、改模板、讓當前重試立刻吃到新版，正是這個編輯功能的用途；凍結成「開工當下那一版」會把它變成「改了但這一輪不算」。代價是模板改壞了退不回上一版，只能重打或按還原預設回出廠版。

**實作：** 出廠預設在 `src/prompts.ts`（四個角色的攤平版本，頂部保留 MIT 版權聲明）；per-workspace 的編輯版存在 `prompts` table。`agent.ts` 每次呼叫才讀 DB，不快取 -- 那是「當前重試立刻吃到新版」的實作方式。「還原預設」是把那一列刪掉，讀取時自然落回內建預設，不是複製一份預設寫回去，所以 `isDefault` 永遠等於「DB 裡沒有這一列」。變數替換認得的變數才換，不認得的原樣留著（打錯字時看得到 `{spce_md}` 留在 prompt 裡，比默默變成空字串好查）。

### 新增 workspace 時的資料夾選取

`repoPath` 要的是絕對路徑，但瀏覽器的資料夾選取（`webkitdirectory`、`showDirectoryPicker()`）基於安全設計一律不給絕對路徑。server 跟瀏覽器在同一台機器上，所以由 `GET /api/browse` 列目錄、前端拿它做選取器。只回目錄名稱與「含不含 `.git`」，不碰檔案內容。

**不限制可瀏覽的根目錄。** `POST /api/workspaces` 本來就收任意絕對路徑並在那裡跑 agent，列目錄名是嚴格更小的權限；限制在 `homedir` 之下只會擋掉 repo 放 `/mnt`、`/srv` 的正常用法，而且手動輸入完全不受那個限制，等於只擋 UI 不擋 API。前提是 server 綁 `127.0.0.1` 且沒有 CORS header（跨站網頁送得出這個 GET 但讀不到回應）。要對外開的話，這條跟 `/api/workspaces` 都得先有驗證，而後者是更急的那個。

### loom 自己的開發迴圈

跟「dev server 生命週期」無關，那節講的是**專案的** server。`npm run dev` 用 Node 內建的 `--watch` 監看 `src/`，改動自動重啟。

server 進程啟動時產生一個 `BOOT_ID`，SSE 的 `connected` 事件帶上它。server 重啟後瀏覽器的 `EventSource` 本來就會自動重連，前端發現 `bootId` 換了就 `location.reload()`。這樣改 `ui.html`（它是 `readFileSync` 讀的，不在 import 圖譜上，所以要 `--watch-path=src` 才追得到）不用手動重整，而且不需要另外接一套 hot reload 通道。一般手動重啟 server 也會觸發前端重載，那是對的行為：舊 UI 配新後端就是該重載。

### 匯入既有的 specs 資料夾

採用 loom 之前寫的 spec 沒有 front matter，loom 無法判斷它們做完了沒有。git log 裡沒有 loom 的分支命名慣例，讀 code 對照 spec 要花 LLM 錢而且答錯就是重做一次已完成的工作。

**不推斷，一次性匯入。** 第一次註冊 workspace 時列出所有沒有 front matter 的 spec，預設全部勾成「已完成，不要跑」，人把想繼續跑的取消勾選。確認後 loom 只在 `spec.md` 寫一行 front matter，不碰 issue 檔案，因為已合併的 spec 不需要 issue 狀態。

匯入後每個 `spec.md` 都有 front matter，所以之後任何沒有 front matter 的資料夾一定是新建的，直接當 draft，不需要區分新舊。

預設勾成已完成而非待執行，是因為採用當下資料夾裡壓倒性多數是歷史紀錄。安全性由「什麼都不會自動跑」保證，不是由預設值保證。

**匯入的粒度是 spec，不是 issue。** 做到一半的 spec 只能整個標成「要跑」，再手動把已完成的那幾個 issue front matter 改成 `done`。半完成的 spec 是少數，為它把匯入 UI 從一層變兩層不划算。

### 讀得懂 skills 產出的檔案

loom 自己產的 issue 直接寫 front matter。但人在終端機用 `/to-tickets` 產的、或採用 loom 之前留下的檔案，狀態寫在 markdown body：`**Status:** ready-for-agent`。

**loom 掃到沒有 front matter 的 issue 時讀那一行，轉成 front matter，之後只認 front matter。** 對映：

| skills 的 Status | loom 的 status |
|---|---|
| `ready-for-agent` | `ready` |
| `ready-for-human` | `human` |
| `needs-triage`、`needs-info` | `draft` |
| `wontfix` | 不匯入，忽略該 issue |

body 那一行從此是歷史痕跡，可能跟 front matter 不一致，loom 不再讀它。

**parser 要吃兩種格式。** local tracker 模板寫的是「a `Status:` line near the top」，但 `/to-tickets` 實際產出的是 `**Status:** ready-for-agent`（粗體）。`Blocked by` 同樣有這個差異。兩份模板本身就不一致，parser 兩種都要接受。

理由是兩邊本來就不是同一組詞彙：skills 的 Status 是給人和 `/triage` 用的五個粗粒度標籤，loom 的 issue 狀態機有十一個狀態。當成「匯入時的初始值」比當成「持續同步的欄位」誠實。

同一段轉換邏輯服務三個入口：第一次註冊 workspace、人在終端機用 skills 產的新 spec、手寫丟進資料夾的 spec。

### 執行指令由 package.json 提供

loom 認固定的 script 名稱：

```json
"scripts": {
  "loom:setup": "pnpm install --frozen-lockfile",
  "loom:dev":   "vite --port $PORT",
  "loom:test":  "vitest run",
  "loom:e2e":   "playwright test"
}
```

執行時 `PORT` 由 orchestrator 放進環境變數。找不到 `loom:*` 就退回慣例：`dev`、`test`、依 lockfile 決定安裝指令。健康檢查是輪詢 `http://127.0.0.1:$PORT/` 直到有回應。

這樣解決三件事：

- **port 注入沒有通則。** Vite 吃 `--port`，Next 吃 `-p`，有些框架讀 `PORT` 環境變數。寫在 script 裡由專案自己決定，loom 不需要知道任何框架的差異。
- **設定漂移消失。** 這是「設定存 DB 不存 repo」唯一的已知代價。改測試工具就改那行 script，loom 自動跟上，不需要任何同步動作或偵測按鈕。
- **monorepo 與非典型專案自然支援。** script 裡可以寫任何東西，例如 `pnpm --filter web dev`，或先起 docker compose。

代價是每個專案要在 `package.json` 加四行。這不算引入新的設定系統，scripts 是本來就存在的東西，而且它 git-tracked，跟著專案走。

壞掉的條件：非 Node 專案沒有 `package.json`。

### 觀測

agent 的 stream-json 即時轉發到 SSE，web 上看得到 agent 現在在做什麼。跑二十分鐘完全看不見裡面是不可接受的，而這幾乎免費。

**完整輸出不落地。** 一個 issue 的 stream-json 可能幾 MB，乘上 issue 數與重試次數會把 DB 撐爆。只存摘要（耗時、成本、files_changed、verdict），失敗時才存完整 stdout，那時才需要它。

**實作現況：** `claude.ts` 的 `runClaude` 有給 `onEvent` 才切換成 `--output-format stream-json --verbose` 逐行解析，沒給就維持既有的 `--output-format json` 一次性路徑，行為不變。事件粒度是「一個 assistant 內容區塊」，不追蹤 token-level 的 partial delta、不等 tool_result 回來（那些只換得到 tool_use_id 對應的額外狀態，換不到「看得懂 agent 在幹嘛」這個目標）。orchestrator 用一個純記憶體的 `LiveOutputStore`（key 是 run id）暫存，run 一結束就 `clear()`，完全不落地，跟上面「完整輸出不落地」一致。

接上的有 coder、issue_reviewer、以及測試階段的 `loom:*` 指令（`devserver.ts` 透過同一條管線報 `kind:"port"` 與跑了哪個 script）。spec_reviewer 與 spec 層的 e2e 沒接：它們的 issue 是 null，看板目前沒有它們的顯示位置。

**事件形狀已實測**（`claude-stream.test.ts`，預設 SKIP，`ORC_TEST_REAL_CLAUDE=1` 才跑）：`assistant` 事件的 `message.content[]` 會有 `thinking` / `text` / `tool_use` 三種區塊，工具名稱就是 `Read`、`Edit`、`Bash` 這些原名，`Read` 的 `input.file_path` 是絕對路徑。`--json-schema` 強迫呼叫的 `StructuredOutput` 也會以 `tool_use` 出現，那是 loom 自己要求的回報動作不是 agent 在做事，轉發時濾掉。

### 用量與花費

`--output-format json`（或 stream-json 的最後一個 result 事件）帶完整用量，實測欄位：

```json
{
  "duration_ms": 2115,
  "num_turns": 1,
  "total_cost_usd": 0.0051025,
  "usage": {
    "input_tokens": 2,
    "cache_read_input_tokens": 9985,
    "cache_creation_input_tokens": 0,
    "output_tokens": 4
  },
  "modelUsage": { "<model>": { "costUSD": 0.0051025, ... } }
}
```

訂閱制照樣回傳，不是空的。loom 每次 agent 跑完記一列，就能按 issue、spec、角色、日期任意切。

顯示：頂列今日 token 與花費；issue 面板本輪花費與 token；spec 面板總花費與 token。

**token 顯示成「輸入 / 輸出」兩個數字**，輸入是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 的總和。分成兩個是因為它們的意義不同：輸出是真正的生成量，輸入大部分是快取重讀。同時看得到花費和這兩個數字，才能分辨「這次很貴」是快取沒命中還是真的生成很多。

三個判讀上的陷阱要記著：

- **`input_tokens` 不是輸入量。** 上面那筆 `input_tokens` 是 2 而 `cache_read_input_tokens` 是 9985。真正的輸入是三個欄位相加，只看第一個會低估好幾千倍。
- **token 總量與金額是兩條曲線。** 四類 token 單價不同（output 最貴、cache read 最便宜），一個 spec 可能 token 多但便宜（大量快取命中），也可能 token 少但貴。要比較就分開記。
- **訂閱制下金額不是帳單。** 那是「如果走 API 會花多少」的等價換算，用途是相對比較（這個 spec 比那個貴三倍、這次重試燒掉半個 spec 的量），不是預測還能跑多久 -- 5 小時與每週視窗官方沒公布 token 換算。

那 9985 是一次「只回一個 ok」的空白呼叫的固定開銷：system prompt 加全域 `CLAUDE.md` 加工具定義。這把「全域 CLAUDE.md 每次都載入」的成本變成可量測的數字。

## 明確不做

| 不做 | 加回來的條件 |
|---|---|
| kanban 拖拉 | 人可觸發的轉移多到按鈕列排不下 |
| 認證與授權 | 要在 localhost 以外的地方跑 |
| tester agent | 決定改由獨立角色寫測試 |
| mergeable 自動 merge 白名單 | 人工閘門真的成為瓶頸，且有信任的 spec 類型 |
| `--resume` 接回中斷的 agent | 重跑成本高到不可接受，且驗證過中斷點的行為 |
| 用 `Blocked by` 平行執行同 spec 的 issue | 不加。一個 spec 一個 worktree，平行改同一份 checkout 會撞 |
| 自己發明 spec 與 ticket 模板 | 不加。內嵌 `to-spec` 與 `to-tickets` 的 |
| 依賴 mattpocock/skills plugin | 不加。內嵌後版本固定，上游更新不會靜默改變流水線行為 |
| 內嵌 `wayfinder` | 不加。它是規劃階段，看板不該同時裝決策票和實作票 |
| coder 的重試專用模板（含 `diagnosing-bugs`） | 重試品質被證明不夠時 |
| 詞彙表與規範文件的路徑欄位 | 不加。`CLAUDE.md` 自動載入，詞彙表路徑寫在可編輯的提示詞裡 |
| 讓人編輯 `--json-schema` | 不加。改壞了整條流水線停擺且症狀難查 |
| review 意見寫進 issue 檔案的 `## Comments` | skills 有這個慣例，但每次重試都往 git-tracked 檔案加文字，commit 會吵。想在 loom 外面讀得到歷史時再換 |
| 兩層狀態同步（spec 也有完整狀態機） | 不加。spec 狀態一律由 issue 聚合算出 |
| 多 provider 抽象層 | 要接非 Claude 的執行體 |
| 指令設定欄位（setup / dev / test / e2e / health） | 要接沒有 `package.json` 的專案 |
| issue 粒度的匯入 | 半完成的 spec 多到手改 front matter 變成負擔 |
| 已合併 spec 的歷史檢視 | 需要查跨 spec 的統計，而 specs 資料夾與 git log 答不出來 |
| PR 層的第三次 review | 不加。一個 spec 一次 merge，PR 的 diff 就是 spec review 看過的那一份 |
| spec review 意見的「之後再說」暫存 | 不加。理由見「spec review 意見的處理」 |
