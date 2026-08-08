# loom

狀態機驅動的本地多 Agent 編排系統。

## 目標

以 `.loom/` 底下的 issue 為輸入，自動驅動 coder 與 reviewer 完成實作與驗證，最終由人決定是否 merge。

無人值守是核心目標：晚上啟動一個 parent issue，隔天早上看結果。所有設計取捨在「減少人工介入次數」與「其他考量」衝突時，優先前者。

## 核心概念

| 概念 | 定義 |
| --- | --- |
| workspace | 一個 git repo 加上它的執行設定 |
| issue | 唯一的工作單元，同一種實體，依 parent/child 關係分兩種角色 |
| parent issue | 有 child issue 的 issue（舊設計叫 spec）。狀態由它的 child 聯合算出；一條 `issue/<name>` 分支、一個 worktree、一個 merge 單位 |
| child issue | leaf issue，挂在某個 parent issue 底下（舊設計叫 issue）。狀態機直接作用在這層，是 coder/reviewer 實際處理的單元 |

模型是單一 issue 實體加一層 parent/child，不是兩種不同的東西。**深度固定兩層**：parent 有 child、child 是葉。schema 用 `parent_id` 表達這層關係，但不允許再往下底狀（要更深的結構就拆成獨立的 parent issue、用 `blocked_by` 連，見「Blocked by」）。

parent issue 在結構上提供四件事：agent 的 prompt context、衝突域宣告（同 parent 的 child issue 序列執行）、kanban swimlane、merge 單位。同一個 parent issue 的檔案固定放在 `<repo>/.loom/issues/<parent-slug>/`，parent 的描述與各 child issue 都在裡面；位置固定、不可設，理由同舊設計的 `.loom/specs`。

## 提示詞

loom 的提示詞是內建的出廠預設，per-workspace 可在 web UI 覆寫。內建版本只提供角色邊界與輸入資料的位置，不依賴外部 plugin、不要求專案安裝特定 prompt 套件，也不把外部模板當相容目標。

| loom 的提示詞 | 責任 |
| --- | --- |
| chat | 把粗略想法整理成一個 parent issue 與一組排序後的 child issue |
| coder | 在 worktree 裡實作單一 child issue |
| issue reviewer | 檢查單一 child issue 的 diff 是否符合 parent/child 描述與專案背景 |
| parent issue reviewer | 檢查整個 parent issue 合併後的跨 child 一致性與遺漏 |

chat 的提示詞要產出 parent issue 的問題、目標、限制、測試指引、跨 parent 依賴，以及 child issue 的順序、依賴、人類判斷需求與 e2e 需求。coder 不在無人值守階段新增需求或重新規劃 parent，它只讀 parent/child 描述並完成當前 child。

### 專案背景

**專案背景進 agent 的唯一管道是 `.loom/context.md`。** loom 讀它，填成 `{context_md}` 模板變數，coder 與兩個 reviewer 的提示詞裡都有一個 `<context>` 區塊。專案自己的 `CLAUDE.md`、`CONTEXT.md`、`CODING_STANDARDS.md` 都不參與，提示詞也不叫 agent 自己去找那些檔案 -- 那等於讓專案的環境決定 agent 看到什麼，跟「專案層擋掉」的立場衝突（見「agent 繼承什麼環境」）。

**內容放什麼由使用者決定，loom 不規定。** 提示詞只說「這是這個專案要你先知道的事」，整份原樣塞進 `<context>` 區塊，不解析、不分節、不假設裡面是詞彙表還是編碼規範。loom 只把這份內容交給 agent，不從中推導設定；`<context>` 講到的事情優先於內建提示詞的一般性指引。

**為什麼是 loom 自己的檔案，不是讀專案既有的 `CONTEXT.md`。** 讀既有檔案在技術上更省事，但那是把 loom 的行為綁在「這個 repo 剛好有沒有那個檔案、裡面剛好寫了什麼」上。loom 要能單獨運作，設定空間跟專案既有的分開。要用既有內容就自己複製過去，那是一次明確的決定，不是隱含的耦合。

**為什麼是檔案，不是 DB 欄位。** 跟 `.loom/issues` 同一個理由：進版控、跟著 branch 走、協作者看得到、人可以直接編輯。存 DB 的話它會變成單機的、不在版控裡的第二份真相。

**讀主 checkout 的版本，不是 worktree 的。** 跟 parent issue 的描述一致。某條 parent issue branch 改了 `.loom/context.md` 不該立刻對別條 branch 正在跑的 coder 生效，那會讓同一批平行的 parent issue 拿到不同背景而且沒有訊號。

沒有這個檔案時 `{context_md}` 是空字串，模板留一個空的 `<context>` 區塊，agent 照樣跑。設定頁不回報它在不在：寫不寫是使用者的事，沒有它也不擋執行，多一個欄位只是多一個要維護的東西。

**只有讀，沒有寫。** loom 沒有任何角色寫得了這個檔案：coder 的提示詞禁止碰 `.loom/`（那條規則是為了保護 orchestrator 狀態），chat 的提示詞禁止改任何檔案。要建立或更新就人自己編輯，它在 repo 裡，跟改任何一個 markdown 檔一樣。這是刻意的，理由與代價記在「明確不做」。

## 狀態機

狀態機有兩個層次，都作用在 issue 上：child issue 帶自己的 11 狀態機，parent issue 的狀態由它的 child 聯合算出。

### child issue 的狀態機

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

`draft` 只用於人手寫丟進 issues 資料夾的 child issue（見「人手寫的 parent issue」）。chat 定稿產出的 child issue 直接進 `ready` 或 `human`。

**`human` 是不派工的狀態。** chat 產 child issue 時標記 `needs_human` 的那些：需要判斷、需要外部存取、需要手動測試的 issue。loom 不 spawn 任何 agent，看板上獨立顯示等人處理，人做完手動標 done，序列繼續。

沒有這個狀態的話，這類 issue 會被 agent 抓走、撞牆三次、進 blocked，浪費三輪完整實作才得到「這件事本來就不該自動做」這個結論。

**`dropped` 是「先收目前進度」的落點。** blocked 的 child issue 與所有直接或間接依賴它的未開工 child issue 一起標成 `dropped`，parent issue 隨即進 verifying，跑整體 e2e 與 parent issue review，通過才進 mergeable。沒被丟掉的部分照常合併，未完成的部分由 parent issue review 的意見帶到人面前。

這解掉 all-or-nothing 的風險：child 05 反覆失敗時，01 到 04 的成果不會一起卡在 branch 上落不了地。

diff 為空不算失敗，送 reviewer 判定是「確實已被前一個 child 解決」還是「根本沒做」。

### parent issue 的狀態（聚合）

```
所有 child 到達終端（done 或 dropped）──▶ verifying（跑整體 e2e 與 parent issue review）
  綠 ──▶ mergeable（等人點按鈕）
  紅 ──▶ orchestrator 產生一個新 child issue 進清單，parent 回到執行中
mergeable ──人點按鈕──▶ merged
git 操作失敗 ──▶ parent 層 blocked（寫 blocked_reason）──人處理完──▶ 回原狀態
```

**parent issue 的狀態檔只有兩個欄位：`merged` 與 `blocked_reason`。** 其餘全部由 child 狀態聚合算出。

這兩個欄位存在的理由相同：**它們是 child 推不出來的事實**。所有 child 都 done 不等於人按過合併；而 rebase 衝突、最終 merge 衝突、agent 越界改到 issues 這三種失敗都發生在「沒有任何 child 處於中間狀態」的時刻 -- child 之間，或所有 child 完成之後。通往 blocked 的邊從那些時刻出發，沒有 child 可以承載它。

`blocked_reason` 的值域：`rebase_conflict`、`merge_conflict`、`issues_touched`、`e2e_loop`。

聚合表**由上而下 first-match**，第一列命中就停：

| 順序 | 顯示狀態 | 判斷方式 |
| --- | --- | --- |
| 1 | merged | 狀態檔的 `merged` |
| 2 | parent blocked | 狀態檔的 `blocked_reason` 非空 |
| 3 | blocked | 任一 child 是 `blocked` |
| 4 | 等人動手 | 下一個該做的 child 是 `human` |
| 5 | 執行中 | 任一 child 在 implementing、review_ready、reviewing、test_ready、testing |
| 6 | verifying / mergeable | 所有 child 到達終端，再看 DB 裡整體 e2e 與 parent issue review 的結果 |
| 7 | 排隊中 | 至少一個 `ready`，且沒有任何 child 在中間狀態 |
| 8 | 草稿 | 全部 `draft` |

first-match 是必要的：`blocked` 與「執行中」可以同時成立（`Blocked by` 止血讓不相干的 child 在別的 child blocked 時繼續跑），`blocked` 與「等人動手」也可以。互斥寫法無解，優先序才有。

第 7 列的述詞是「至少一個 ready」而不是「全部 ready」，因為 done 與 ready 混合是設計自己製造的常態：parent issue review 意見轉成 child、整體 e2e 紅開新 child，兩條路徑都往全 done 的 parent 加一個 ready。

**中間狀態一律用列舉，不用 `*ing` 字面。** `review_ready` 與 `test_ready` 是有自己派工轉移的持久狀態，字面上不含 ing，用萬用字元寫會漏掉它們 -- orchestrator 因用量視窗暫停時整批狀態會凍在那裡。崩潰恢復的掃描用同一份列舉。

整體 e2e 失敗產生的 child issue 由 orchestrator 用模板寫：標題是失敗的測試名稱，body 是 tail 輸出，**並且一律帶 `e2e: true`**。沒有這個旗標的話，這個為了修 e2e 而生的 child 只會被 typecheck、unit test、review 驗證，coder 交出看起來合理但沒真正修好的改動就能通過，回到 verifying 又紅，再開一個新 child，每個新 child 帶全新的重試計數，永遠不收斂。

**同一個 parent 因整體 e2e 紅自動開 child 累計 2 次為上限**，第 3 次改成把 parent 標成 `blocked_reason: e2e_loop` 等人看。理由跟 parent issue review 不自動開 child 一樣：自動加工作的迴圈一定要有終止條件。

### kanban

顯示 child issue 卡片，parent issue 當 swimlane。

**看板只放需要人或機器動作的 parent issue。** 展開的 lane 是 blocked、mergeable、執行中、排隊中；draft 與 merged 各收成一行，點開才展開。

離開看板的時機是 **merged，不是所有 child 都 done**。全綠但還沒合併的 parent 需要人動手，lane 要留著讓人翻看那幾張卡再決定。

不做這個切分的話，跑一個月就是四十條全是 done 卡片的 lane 把工作區淹掉。已合併的 parent 要查就去 issues 資料夾或 git log，不另做歷史檢視。

**看板是跨 workspace 的單一視圖，靠上方的專案篩選縮窄。** topbar 的 meters（今日 token／花費／執行中）與 attention 橫條都是跨所有 workspace 聚合，不看篩選；篩選只窄化看板本身。一個 parent issue 屬於哪個 workspace 是它身上帶的 `workspace_id`，跨 workspace 的聚合查詢就是同一批表不加 workspace 條件（見「資料存放」）。

不做拖拉。人能觸發的轉移有六條，每一條對應一顆按鈕，兩邊互為檢查：

| 按鈕 | 對應的邊 |
| --- | --- |
| 草稿 parent 放行開跑 | `draft ──▶ ready`（該 parent 全部 child） |
| blocked 恢復 | `blocked ──▶ ready` |
| blocked 先收目前進度 | `blocked ──▶ dropped`（含所有下游未開工 child） |
| parent blocked 恢復 | 清除 `blocked_reason`，回原狀態 |
| human 標為完成 | `human ──▶ done` |
| human 退回 ready | `human ──▶ ready` |
| mergeable 觸發 merge | `mergeable ──▶ merged` |

（七顆按鈕對應六條 child 層的邊加一條 parent 層的清除動作。）

做拖拉就要實作一套「哪些拖動合法」的規則，而這些用按鈕表達更清楚，而且拖拉在手機上難用。

## git 拓撲

| 項目 | 決定 |
| --- | --- |
| 分支 | 一個 parent issue 一條 `issue/<name>`，一個 worktree |
| worktree 位置 | `<repo>/.loom/worktrees/<parent>`，目錄自帶 `.gitignore`（內容 `*`）不讓它弄髒主 checkout |
| child issue 執行順序 | 同 parent 依編號序列，跨 parent 平行；有 child 卡住時用 `Blocked by` 判斷哪些後續仍可做 |
| 平行上限 | per-workspace，預設 2。每個跑動的 parent issue 佔一個 worktree、一份依賴、一個 claude process，測試期間可能再多一個測試自己起的 server |
| merge 粒度 | parent 全綠才一次 merge 回 main，人工觸發 |
| coder 交棒時 | **orchestrator 代 commit**，見下節 |
| 每個 child 完成後 | rebase parent branch 到最新 main，衝突就寫 `blocked_reason: rebase_conflict` |
| 按下 merge 時 | 先 rebase；若帶進**碰到 issues 以外路徑**的 commit 才退回 verifying 重驗，過了才真的合併 |
| merged 之後 | `git worktree remove` 加 `git branch -d issue/<name>` |

**worktree 放 repo 內。** 放 `~/.loom/worktrees/` 的話 worktree 會在 repo 被刪之後變成孤兒、路徑也跟專案脫節。Claude Code 自己的 `EnterWorktree` 用 `.claude/worktrees/`，是同一個取捨的旁證。

這個決定曾經有一項代價：coder 的 cwd 是 worktree，Claude Code 從那裡一路往上找 `CLAUDE.md`，路徑必然經過主 checkout 的 `<repo>/CLAUDE.md`，那是 main branch 的版本，會跟 worktree 自己 checkout 出來的那份疊加，而且沒有訊號能分辨哪份該贏。改成只吃使用者層之後專案的 `CLAUDE.md` 不再載入，這項代價消失了。

**目錄自我忽略，不改 repo 根的 `.gitignore`。** 建 worktree 前先寫 `.loom/worktrees/.gitignore`，內容一個 `*`。repo 根那份是使用者的檔案，loom 不去動它；被 `*` 蓋到的 `.gitignore` 自己照樣生效，git 讀忽略規則不看檔案自身的忽略狀態。忽略規則絕不能寫成 `.loom/` -- 那會把 `issues` 一起蓋掉，狀態 commit 就沒有路徑可以落地。失敗是響亮的（`commitStateChange` 用明確路徑 `git add .loom/issues`，底下有被 ignore 的新檔案時 git 會 exit 非 0 並列出來），所以不需要另外做啟動檢查；`add -A` 才是會靜默跳過的那種寫法，這也是不用它的理由之一。

### worktree 那一側的寫入契約

issues 資料夾那側規定得很死（只有 orchestrator 在 main checkout 寫）。parent branch 這側要有對等的規定，否則 review、rebase、reset、merge 四條路徑都預設「coder 的產出已經被固化」而沒人負責固化。

**commit 由 orchestrator 代做，不由 coder 做。** coder subprocess 正常結束且回傳 `done: true` 時，orchestrator 在該 worktree 執行：

```
git add -A
git commit -m "<NN> <child issue title>"
```

然後才把 child issue 轉成 `review_ready`。

不讓 coder 自己 commit 的理由：coder 忘了 commit 是靜默失敗，而且症狀完全誤導 -- `git diff <base_sha>..HEAD` 恆為空，每個 child 都會走進「diff 為空送 reviewer 判定」被判成「根本沒做」退回 implementing，而 worktree 裡躺著完整實作；接著 rebase 在髒工作區上失敗。要讓 coder 自己 commit，就得在 schema 加 `commit_sha` 讓 orchestrator 驗證它真的做了，那還不如 orchestrator 直接做。

**清理一律是三段式**，不是單一 reset：

```
git rebase --abort || true
git reset --hard <base_sha>
git clean -fd
```

`git reset --hard` 不刪 untracked 的新檔，也不中止進行中的 rebase。崩潰恢復與 domain 第三次「從乾淨狀態重寫」宣稱的乾淨，只有加上 `rebase --abort` 與 `clean -fd` 才成立。少了 `clean -fd`，agent 死在半路留下的新檔會被下一輪 coder 繼承，而且因為是 untracked，`git diff` 看不到、reviewer 也看不到。

**worktree 在 parent merged 之後回收。** 不回收的話每個跑過的 parent 留下一份完整 checkout 加一份裝出來的依賴，平行上限只限制同時跑幾個、不限制累積幾個。磁碟滿之後安裝與 git 操作開始失敗，被歸成 setup 失敗直接 blocked，早上看到一排像是 agent 做壞的 blocked，根因是磁碟。

### 多個 parent 平行時的交互點

舊設計裡 parent（當時叫 spec）之間完全獨立，只透過 rebase 被動互動。現在多了可宣告的跨 parent 依賴（見下節），但被動交互點不變：

**分支漂移**：靠每個 child 完成後的 rebase 吸收其他 parent 已合併的東西，不會累積成巨大分歧。

**撞車**：兩個 parent 改到同一批檔案，後者的 rebase 會衝突進 blocked。不做預先偵測 -- 那需要 chat 產 parent 時宣告「會動到哪些路徑」，而 agent 經常改到沒預期的檔案，不可靠的預測會給出假的安全感。rebase 衝突本身就是可靠的安全網，代價只是手動把其中一個往後排。看板上要把「blocked 原因是 rebase 衝突」標清楚，讓人一眼看出是撞車不是 agent 做壞。

**過期的驗證結果**：parent 進 mergeable 後等人按按鈕的期間，另一個 parent 可能已經合併。所以按下 merge 時先 rebase，若帶進新 commit 就退回 verifying 重驗。這是「七個綠燈的 child 疊起來未必綠」同一個論證的延伸：兩個各自綠燈的 parent 疊起來也未必綠。

**但判定必須排除 loom 自己的狀態 commit。** 每個 child 進 done 時 orchestrator 都往 main 塞一個只動 issues 的 commit，所以另一個 parent 只要還在跑，main 就一直在前進。照「帶進任何新 commit 就重驗」會讓 mergeable 的 parent 被反覆打回 verifying 跑幾分鐘 e2e，而帶進來的東西跟任何 code 無關，每次還要人再按一次按鈕。判定式是：

```
git diff --name-only <old-main>..<new-main> -- . ':!.loom/issues/'
```

輸出為空就直接合併，不重驗。

merge 本身不需要額外的鎖，orchestrator 是單一事件迴圈，兩個 merge 不可能同時發生。

### Blocked by：止血與跨 parent 排序

`blocked_by` 是同一種邊，出現在兩個 scope，差別只在預設：

**同一個 parent 內（child → child）：止血。** child 可以用 front matter 宣告 blocking edges：

```
01-fix-e2e-page-object              Blocked by: None
02-extract-slot-timeline-module     Blocked by: None
03-shared-timeline-range            Blocked by: 02
04-split-shared-components-...      Blocked by: 02
05-migrate-modals-to-form-modal     Blocked by: None
06-mobile-layout                    Blocked by: 04
07-mobile-e2e-coverage              Blocked by: 01, 06
```

預設照編號跑（編號本身視為拓撲排序），blocked_by 只在有 child 卡住時用來判斷哪些後續不受影響。上例中 02 進 blocked，03、04、06、07 都直接或間接依賴它，但 05 可以繼續做，parent 不會整條停擺等人半夜起來處理。

**不用來平行化。** 一個 parent 一個 worktree，兩個 child 同時改同一份 checkout 會撞。邊只改變「跳過哪些」，不改變「同時幾個在跑」。

**跨 parent（parent → parent）：排序。** 這是舊設計沒有的能力。預設 parent 之間獨立、各自可開跑；parent B 宣告 `blocked_by` parent A 表示 B 要等 A。語意是 **wait-for-merge**：B 不開跑，直到 A 合併進 main，B 開跑時從 main 分支，自然吃得到 A 的產出，不需要共用 checkout。

**限同一個 workspace。** wait-for-merge 靠的是「A 合進 main、B 從 main 分支」，而 main 是 per-repo 的；A 在別的 workspace（別的 repo）合進它自己的 main，不會出現在 B 的 repo 裡，B 等了也吃不到 A 的程式碼。跨 workspace 的依賴會退化成沒有程式碼流的軟性排程提示，那是另一種東西，不支援。

**風險與緩解**：依賴邊是人或 LLM 宣告的，會漏。漏宣告的代價只出現在異常路徑（同 parent 內有東西卡住時，或跨 parent 時 B 拿不到 A 的產出），而異常路徑本來就是人要看的。沒有 `Blocked by` 這一行的 child（手寫的）預設當成依賴前一個，退回編號序列。

實作範圍因此很小：解析那一行，同 parent 內在 blocked 發生時算一次可達性，跨 parent 在派工前檢查依賴是否已 merged。不需要排程器，不需要 DAG 執行引擎。

### base_sha

orchestrator 在每個 child 開工時記下 parent branch 當下的 HEAD，存進 DB。

reviewer 用 `git diff <base_sha>..HEAD`。沒有這個欄位的話只能用 `git diff main..HEAD`，那會包含同 parent 前面所有 child 的改動，child 07 的 review 會看到 01 到 06 的全部東西。

base_sha 同時提供「退回 child 開工前」的能力，重試策略依賴它。

### 狀態寫入

狀態存在 child issue 檔案的 front matter（parent 的 `merged`／`blocked_reason` 存在 parent 的狀態檔），git-tracked，跟著專案走。

強制規則：

1. **只有 orchestrator 在 main checkout 寫 front matter，agent 的 worktree 不碰 issues 資料夾。** 單邊修改 git 自動合併，雙邊寫同一個 YAML 就是衝突。
2. merge 前檢查 diff 是否碰到 issues 路徑，碰到就 blocked。
3. front matter 只放狀態機需要的欄位。review 意見全文、測試輸出、session id、耗時、成本進 DB。那些是幾 KB 的雜訊，塞進 git-tracked 檔案會讓每次狀態轉移的 diff 無法閱讀。
4. 每個 child 進 done 時一次 commit 狀態到 main。中間轉移只寫檔不 commit，崩潰後從檔案讀，沒有損失。全部轉移都 commit 的話七個 child 會產生四十幾個雜訊 commit。

### 來源過期偵測

parent issue 的描述在開跑後還是可以改（`--resume` 回原對話討論、或直接編輯）。已經 done 的 child 是照舊版做的，沒有任何東西指出這件事。「開跑後只能改還沒開始的 child」這條規則只約束 child 檔，而且沒有執行機制。

**機制**：`issue_state` 存一欄 `source_hash`，在每次 `doImplement` 開頭記下 `sha256(parent 描述 body + 該 child 檔 body)`。讀取時比對當前值，不同就標過期。

三條限制：

1. **過期是 derived boolean，不是第十二個狀態。** 不進 front matter、不動 `transition`／`aggregateParentStatus`。
2. **只對 done 有意義。** 還在跑的 child 下一輪本來就會讀到新內容。
3. **不擋 merge。** 錯字修正不該擋 merge，跟 parent issue review 意見同一層級：看板上的徽章，不是門禁。

hash 的是 **body 不是整檔**。front matter 由 orchestrator 自己寫，`merged: true` 在 merge 那一刻寫入，拿整檔算 hash 會讓所有 child 同時變過期。

parent 描述與 child 檔合成一個 hash，不分兩欄：人的處置不分兩種，而且舊版長什麼樣 git 已經有了（每個 child done 時 orchestrator 都 commit 過 issues），不需要另存內容。

人有兩個動作：**重做**（該 child 回 ready，清掉 base_sha 讓下一輪重新開工）與 **忽略**（把 `source_hash` 更新成當前值）。重做只退那一個 child，不自動連坐下游 -- 下游有沒有真的受影響只有人判斷得出來，自動連坐會在無人值守的時段把本來正確的東西重跑一遍。

因為 `source_hash` 必須跨輪存活，`clearIssueState` 是把 `base_sha` 與重試計數歸零，不是整列 DELETE。

`parent issue reviewer` 做不到這件事：它看「當前 code 對當前 parent 描述」，沒有時間維度，抓得到 code 與新 parent 描述牴觸，抓不到 code 只是沒實作新 parent 描述多出來的約束（那種缺漏沒有矛盾可偵測）。而且它在整個 parent 完成後才跑一次，那時要重做的 child 底下已經疊了後面所有 child。

## 失敗與重試

| 類別 | 事件 | 處理 |
| --- | --- | --- |
| domain | review reject、test fail、build fail | 退回 implementing，吃 domain 額度 |
| domain | diff 為空 | 送 reviewer 判定，不計 |
| infra | subprocess 非零退出、API error、輸出不符 schema | 原地重跑，獨立計數加 backoff |
| infra | 超時、setup 失敗 | 直接 blocked |
| git | rebase 衝突、越界改到 issues、最終 merge 衝突 | 寫 parent 的 `blocked_reason`，不動任何 child |
| 用量 | 訂閱用量視窗用盡 | 不動 issue 狀態，整個 orchestrator 暫停到視窗重置 |

git 這一類寫 parent 層而不是 child 層，因為它們全部發生在沒有 child 處於中間狀態的時刻。詳見「parent issue 的狀態」那節。

三條原則：

- **infra 重試與 domain 重試是兩個獨立計數器。** API 掛掉重連三次不該吃掉「agent 改 code 的機會」那三次，否則網路抖一下就把一個好 child 判死。
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

**一、對每個未 merged 的 parent worktree 跑一次一致性檢查**，不管它的 child 處於什麼狀態。檢查 `.git/rebase-merge` 與 `.git/rebase-apply` 是否存在、`git status --porcelain` 是否乾淨。不乾淨就跑三段式清理。

只看 child 狀態會漏掉一整類情況：每個 child 完成後的 rebase 發生在「前一個已 done、下一個還是 ready」的時刻，沒有任何 child 在中間狀態。orchestrator 死在那裡，恢復邏輯不會碰這個 parent，下一個 child 直接在 rebase 中途的樹上開工，記下的 base_sha 是 rebase 中途的 HEAD。

**二、依中間狀態分兩種處理，不是一律回捲：**

| 卡住的狀態 | 處理 |
| --- | --- |
| implementing | 三段式清理退回 base_sha，回 `ready`，不計重試 |
| review_ready、reviewing | 退回 `review_ready` 重派一次 reviewer，**不動 code** |
| test_ready、testing | 退回 `test_ready` 重跑一次測試，**不動 code** |

一律回捲是錯的：reviewer 只讀 diff 不寫檔，testing 的執行者是 orchestrator 的 subprocess 不是 LLM，兩者都不會留下「半改而 agent 不知道」的樹。orchestrator 在整體 e2e 期間崩潰是常見情形（e2e 很容易把機器打爆），照一律回捲會把已經通過 review 的 commit 全部丟掉，child 從 ready 重跑一整輪，而且「不計重試次數」代表這次浪費連計數器都不會記住。無人值守整晚時這是白燒一次完整實作。

implementing 要回捲，因為那是唯一可能死在 tool call 中間、留下半改工作樹的狀態。

不用 `--resume` 接回中斷的 session：process 可能死在 tool call 中間，worktree 是半改狀態而 agent 不知道自己被中斷過。乾淨重來可預測得多。

## Agent

### 拓撲

orchestrator 持有狀態並依狀態 spawn 對應的 subprocess。不是 coder 呼叫下一棒，也不是 agent 自己輪詢搶單。

不用 coder 呼叫下一棒的理由：狀態會被藏進黑箱，orchestrator 不知道跑到哪一步，kanban 沒東西可顯示；崩潰無法續跑；reviewer 作為 coder 的子 agent 會繼承 coder 的 context 和它對自己實作的信心，那不叫 review。

不用 agent 輪詢的理由：那需要常駐 daemon 各自掃狀態、各自搶單、處理兩個 agent 抓到同一個 issue。push 模型只有一個寫入者，沒有競爭者，體感一樣而實作少一半。

### 四個 LLM 角色

| 角色 | 輸入 | `--json-schema` 輸出 |
| --- | --- | --- |
| chat | 對話，cwd 在 main checkout，`--disallowedTools Write Edit` | `{parent_md, children:[{title, body, blocked_by[], e2e, needs_human}]}` |
| coder | parent 描述 + child issue + 前次失敗紀錄 | `{done, summary, files_changed[]}` |
| issue reviewer | parent 描述 + child issue + `git diff <base_sha>..HEAD` | `{verdict, comments[]}` |
| parent issue reviewer | parent 描述 + 全部 child + `git diff main...issue/<name>` | `{comments[]}`，沒有 verdict，因為它不決定流程 |

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

**每個 child issue**：typecheck、unit test、review。

**child front matter 宣告 `e2e: true` 的**：該 child 也跑一次 e2e。

**parent 所有 child done 後**：跑一次完整 e2e，以及一次 parent issue review，過了才進 mergeable。七個各自綠燈的 child 疊起來未必綠。

### 兩層 review 抓的是不同的東西

不是同一件事的不同時機，是結構上看得見的範圍不同。

| 角色 | 讀的 diff | 唯一能抓到的 |
| --- | --- | --- |
| issue reviewer | `git diff <base_sha>..HEAD` | 細節：這個改動有沒有做對自己的事、測試有沒有測到行為 |
| parent issue reviewer | `git diff main...issue/<name>` | 跨 child 的一致性：重複的抽象、殘留的死碼、七個各自合理但疊起來歪掉的架構 |

issue reviewer 不能省：parent issue reviewer 的 diff 太大看不清細節，而且錯誤在序列鏈上會複利。parent issue reviewer 每個 parent 只跑一次，七個 child 的 parent 總共多一次 LLM 呼叫。

**兩者失敗的處理不同，而且刻意不同：**

- **整體 e2e 紅了**：orchestrator 自動開一個新 child（客觀失敗，一定要修）。
- **parent issue review 有意見**：只附在 mergeable 的 parent 上給人看，不自動開 child。

parent issue review 不自動開工作，是因為架構層面的意見「要不要現在修」本身就是人的判斷 -- 可能值得，也可能該留到下一個 parent。讓 LLM 自動決定加工作是把判斷權放錯地方。這同時消掉了「LLM 傾向找得到東西、每個 parent 都自動長出新 child、永遠收斂不了」的風險，不需要任何次數上限之類的補丁。

merge 按鈕已經是人的閘門，那些意見正好是按下去之前該讀的東西。

**parent issue reviewer 的 diff 由 orchestrator 算好傳進 prompt，整份送。** reviewer 只有 `Read`/`Glob`/`Grep`（唯讀），自己跑不出 `git diff`。整份送是因為這個角色要找的正是「不同 child 各自引入了重複的抽象」「child 03 建的東西被 child 06 淘汰但沒刪」，那些只有攤開全貌才看得見；截斷等於廢掉它存在的理由，而逐個 child 的 diff 已經被 issue reviewer 看過了。

成本上也不需要省：實測一個七個 commit 的分支約 130KB（約 38k token），在 200k context 裡佔不到五分之一，而一個 parent 只跑一次 parent issue review，同一個 parent 的 coder 與 issue reviewer 加起來是十幾次呼叫。

**排除產生檔，不截斷。** `package-lock.json`、`*.snap`、`dist/` 那類對「這個改動做對了嗎」零價值，卻很容易佔掉 diff 的九成。清單寫死在 `git.ts`，不開設定欄位（理由同「不為詞彙表與規範文件開設定欄位」）。超過上限時才降級成檔案清單加行數，讓 reviewer 用它的 Read 自己挑要看的 -- 它的 cwd 就是完整 checkout。那條路徑是給大型改名散佈到幾百個檔案的極端情況，平常不會走到。

### parent issue review 意見的處理

意見存 DB。點 lane 標頭時右側面板顯示 parent 層細節：整體 e2e 結果、review 意見清單、merge 按鈕。

只有兩個動作：

- **轉成 child**：那條意見變成一個 child 加進當前 parent 末尾，parent 退出 mergeable 回去跑。做完重新進 verifying，會再跑一次整體 e2e 與 parent issue review。這個循環由人觸發，不會失控。
- **直接 merge**：意見留在 DB 的歷史裡，不再提醒。

**不做「之後再說」的暫存。** 要存成 draft child 就得掛在某個 parent 底下，而那個 parent 已經 merged、在看板上收起來了，人永遠看不到；要讓它可見就得改「已合併」的判定規則，為一個很少用的功能弄複雜整個聚合邏輯。

而且「之後再說」在實務上就是忘記。真的想留就去 chat 開一個新 parent，開的時候會重新判斷那件事還值不值得做，那個重新判斷比一條躺在待辦裡的舊意見有價值。

整批做完才驗證的問題不是省時間，是錯誤在序列鏈上會複利：child 03 壞了但在 07 做完才發現，中間四個 child 全建立在壞基礎上。而且 reviewer 讀七個 child 疊起來的 diff，品質會明顯掉。

### 測試階段跑什麼

進入 testing 時：依 lockfile 裝依賴（agent 可能加了新的）、跑 `typecheck`、跑 `test`、必要時跑 `e2e`，每個指令都自成一個 process group，逾時就整組收掉。

**loom 不起 dev server。** 需要 server 的測試由測試指令自己起 -- Playwright 的 `webServer` 就是做這件事，而且它自己負責關掉。loom 起一份的話等於要求專案再宣告一個「給 loom 用的 dev 指令」，還要 loom 去猜每個框架怎麼吃 port，而 e2e 框架早就有這個功能。

**loom 只保證 `PORT` 唯一，其餘隔離由專案的 script 負責。** 多個 parent 平行跑測試時，共用資源不只 port -- 本機資料庫、共用檔案、固定的瀏覽器 profile 都會互相污染。要獨立資料庫就從 `$PORT` 衍生一個名稱。隔離責任放在最清楚狀況的地方，loom 不需要理解任何專案的測試環境。真的隔離不了的專案把平行上限設 1。

**實作在 `src/testrunner.ts`。** 認得的 script 是 `typecheck`、`test`、`e2e`（`e2e` 找不到時退回 `test:e2e`）；安裝指令一律由 lockfile 決定（`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `package-lock.json`），沒有 lockfile 就不裝。根層沒有某個階段的 script 時會往 workspaces 的子 package 找，見「執行指令由 package.json 提供」。

typecheck 先跑：編譯不過就沒必要花時間跑後面兩段。

**回傳值分三種，不是兩種。** `pass: true`；`failure: "domain"`（測試真的紅了，退回 implementing）；`failure: "infra"`（安裝失敗、任何一段超時，照失敗與重試的表格直接 blocked）。混成一種的話，一次基礎設施故障會吃掉 coder 改 code 的三次機會，而且第三次會觸發三階段清除把已經寫好的東西整個丟掉。

**「沒有可跑的東西」（沒有 `package.json`、沒有 typecheck/test/e2e script）回傳 `pass: true`**，但 output 明確寫出是哪一種並存進 `runs.summary`。這是刻意的取捨：非 Node 專案不該讓整條流水線卡死，但也不該讓人以為測試真的跑過。設定頁的「測試階段會跑」那一欄同時把這件事標成警告，讓人在派工之前就看得到。**worktree 目錄根本不存在則是拋錯**讓排程器停住 -- 那是環境壞了，不是「這個專案沒有測試」，兩者都走 `pass` 的話 issue 會在沒有程式碼可測的情況下變成 done。

process 生命週期不交給 LLM 的理由：agent 超時被殺、自己崩掉、忘記 kill，spawn 出來的東西就變孤兒佔住 port，症狀出現在下一個不相干的 parent 上，而且要手動 `lsof` 才找得到。orchestrator 是唯一確定知道「這一輪結束了」的角色，所以測試指令由它 spawn、由它 kill 整個 process group。

### 失敗時的資訊傳遞

orchestrator 把測試 stdout 存進 DB，coder 下一輪的 prompt 帶最後 200 行，加一句「完整輸出自己重跑 test_command 看」。

全塞進 context 太貴，完全不給又逼它多跑一次。

## chat 產 parent issue

常駐 `claude -p --input-format stream-json --output-format stream-json`，web 端雙向串接，cwd 在 main checkout。實作在 `src/chat.ts`：一個 workspace 同時只有一份進行中的討論（`chat_sessions` 表，`workspace_id` 當 PK），對應討論分頁上單一 thread 的畫面。

**工具限制不是 `--disallowedTools Write Edit`，是 `--tools Read,Glob,Grep` 白名單。** 原計畫擋 Write/Edit 是想著「它要能讀 repo code 才討論得具體，但不該碰任何檔案」，但實測發現 `--disallowedTools Write Edit` 只擋了那兩個工具名，`Bash` 沒被擋，而 agent 發現 Write 被擋之後會自己改用 `Bash` 的 heredoc（`cat > file <<EOF`）照樣寫成功。改用白名單就是結構上只剩 Read/Glob/Grep 三個工具可用，Bash 根本不在清單裡，沒有繞路可走 -- 跟 issue reviewer 用的是同一份清單（`agent.ts` 的 `READ_ONLY_TOOLS`），不是另外發明一套。

常駐 process 是效能優化（同一個 process 上的每一輪吃得到 prompt cache），不是正確性要求：`session_id` 落 DB，process 閒置逾時（10 分鐘）或意外死掉都用 `--resume` 補一個新的，對話從模型角度不斷。**兩個 process 不能同時碰同一個 session** -- 定稿前一定要先把常駐 process 完全結束（等到 `close` 事件，不是叫了 `stdin.end()` 就當結束），再用一次性呼叫 `--resume` 疊上去，不然會拿到「找不到這個 session」（`--resume` 也綁 cwd，同一個 session 用不同 cwd 去 resume 一樣找不到）。

**拆 child 在同一輪對話裡做**，不另外派 agent。拆分方式是設計決策：哪些改動綁在一起、誰先誰後、依賴邊怎麼連，這是人最該介入的地方。

落地時疊一次 `--resume` + `--json-schema` 的一次性呼叫（不是常駐 process 那條線）拿 `{slug, parent_md, children[{title, body, blocked_by[], e2e, needs_human}]}`，orchestrator（`createParentFromDraft`）負責編號、生 front matter、寫檔、commit 一次。狀態欄位不能讓 LLM 寫。`blocked_by` 在 draft 裡引用的是其他 child 的 `title`（LLM 產出當下還不知道最終編號），落地時才按順序轉成 `01`/`02` 這種 id。`slug` 沒通過 kebab-case 檢查就從 `parent_md` 的內容 slugify 退回，不讓一個格式錯誤擋住整個定稿。

schema 裡的 `needs_human` 是分類旗標不是狀態欄位，跟 `e2e` 同一層級 -- 由 orchestrator 決定寫成 `human` 還是 `ready`。沒有它的話，chat 裡討論出「需要判斷、需要外部存取」的 child 只能標成 ready，然後發生的正是 `human` 狀態要避免的浪費：被 agent 抓走、撞牆三次、進 blocked。

**定稿按鈕就是開跑按鈕。** 剛討論完內容已經看過，再插一道 draft review 是多餘摩擦，UI 上沒有「先看草稿再確認」兩步 -- 按下「建立並開始執行」直接寫檔、commit、喚醒排程器，切去看板看新 parent。手寫丟進資料夾的 draft parent 才需要看板上的放行按鈕。

定稿那一刻把這次討論的 `session_id` 從 `chat_sessions` 搬進 `parent_state.chat_session_id`，`chat_sessions` 那列刪掉。**開跑後只能改還沒開始的 child，可以追加新 child，進行中和已完成的鎖住** -- 這條規則本身還沒有介面實作，`chat_session_id` 先落地是為它鋪路：orchestrator 本來就在派工前才讀 child 檔案，所以這幾乎零成本。修改走 `--resume` 回到原對話以維持 parent 描述一致性，或直接編輯檔案。

## 實作

全 TypeScript，單一 Node process。web server 與 orchestrator 同 process、同事件迴圈，狀態直接共享，不需要 IPC 或第二個 store。

orchestrator 必須是單一事件迴圈：對 main 的 commit 必須序列化，且它是唯一的狀態寫入者。

| 項目 | 選擇 |
| --- | --- |
| server | Hono 或 Express，送 SSE |
| 前端 | React + Vite，build 成靜態檔由同一個 server 提供 |
| 資料 | `node:sqlite`（零依賴，會噴 ExperimentalWarning） |
| agent 執行 | `spawn('claude', [...])`，headless |
| 監聽 | `127.0.0.1`，無認證。要遠端就開 SSH tunnel |

### 用到的 claude CLI 能力

| 需求 | flag |
| --- | --- |
| headless 執行 | `-p` |
| 即時串流輸出 | `--output-format stream-json` |
| chat 雙向串流 | `--input-format stream-json` |
| 結構化回報 | `--json-schema`，state transition 不需要解析自然語言 |
| 角色設定 | 模板本身（見下） |
| 不被權限卡住 | `--permission-mode bypassPermissions`，限 worktree 內 |
| 只吃使用者層設定，擋掉專案層 | `--setting-sources user`、`--strict-mcp-config`、`--disable-slash-commands` |

預設仍是 `--output-format json`（一次性拿完整結果）；`runClaude()` 另外加了一條 `--output-format stream-json` 逐行解析的路徑，只在呼叫端給了 `onEvent` 回呼時啟用（見「觀測」一節），沒給就完全走原本的路徑，兩者共用同一套 result 事件判讀邏輯。

**角色設定沒有用 `--append-system-prompt`，整份模板走 stdin。** 提示詞改成可編輯之後，模板本身就包含角色說明與材料（`{parent_md}`、`{child_md}` 那些變數），拆成「system prompt 那半可編輯、user prompt 那半程式組」會讓「一個角色一份模板」這件事變成兩個地方可以改。代價是那些指示落在 user turn 而不是 system prompt。

**實測到一個非文件記載的行為，寫下來省得下次重踩：** `--output-format json` 的輸出形狀不是恆定的，可能印整條 session 的事件陣列，也可能只印最後那個 `result` 事件本身、不包陣列。成因是設定裡的 `verbose` -- 改用 `--setting-sources user` 之後，使用者層的 `"verbose": true` 會被載入，同一組 flag 也會變成陣列形狀。`src/claude.ts` 兩種都處理（`Array.isArray` 判斷）。

**`rate_limit_event` 的 `overageStatus` 不是用量用盡的判定依據。** 實測（2.1.220，stream-json）一次完全成功的呼叫會帶：

```json
{ "status": "allowed", "rateLimitType": "five_hour", "resetsAt": 1785313200,
  "overageStatus": "rejected", "overageDisabledReason": "out_of_credits",
  "isUsingOverage": false }
```

`overageStatus: "rejected"` 只代表這個帳號沒開啟超額付費，是常態設定。曾經把它當成判定條件，在 `--output-format json` 的路徑下沒有症狀（那條路徑看不到 `rate_limit_event`），但一改用 stream-json 就變成每一次呼叫都被判成用量用盡、orchestrator 第一次呼叫就停住。判定只看 `status`。真的撞到上限時 `status` 會是什麼值還沒有樣本，所以維持保守預設：判不出來走 `infra_fail`（重試三次），不是 `usage_exhausted`（整條停住）。

**第二個實測樣本補上一個 `status` 值：`allowed_warning`。** 開發 chat 那條長駐 process 時，帳號剛好用到 five_hour 視窗 93%，撞到了：

```json
{ "status": "allowed_warning", "rateLimitType": "five_hour", "resetsAt": 1785313200,
  "utilization": 0.93, "isUsingOverage": false, "surpassedThreshold": 0.9 }
```

呼叫本身 `is_error: false`、`subtype: success`，跟 `"allowed"` 沒有兩樣，只是多一個「快到門檻了」的提醒 -- 原本只認字面 `"allowed"` 的判定會把它當成用量用盡，整條 chat 對話第一輪就被判死。跟 `overageStatus:"rejected"` 是同一種錯：把「還在可用範圍內的附加資訊」當成「不可用」。`src/claude.ts` 現在認 `["allowed", "allowed_warning"]` 兩個值，其餘一律走用量用盡判定。

**`--json-schema` 強迫的 `StructuredOutput` 回報工具，讓 result 事件同時帶兩個欄位**：`result`（結構化結果的 JSON 字串）與 `structured_output`（同一份內容已 parse 好的物件）。用後者，不要自己再 `JSON.parse(result)` 一次 -- CLI 已經 parse 過。**schema 要求了但 `structured_output` 不在，判 infra_fail，不當 ok**：那一輪沒有產出契約要求的結構化結果，當 ok 會讓狀態轉移讀到 undefined。

### 一次呼叫的結果怎麼判

兩條 spawn 路徑（一次性 `--output-format json` / 逐行 `stream-json`）收完 stdout 都交給同一個 `decideOutcome`，用量用盡／出錯／schema 缺漏三條規則只寫一份，不是各自重寫。判讀順序，第一個命中就停：

| 順序 | 條件 | 結果 |
| --- | --- | --- |
| 1 | 沒有 result 事件 | 交還呼叫端走字串比對保底（見下） |
| 2 | 任一 `rate_limit_event` 的 `status` 不在 `{allowed, allowed_warning}` | usage_exhausted |
| 3 | `result.is_error`，且 `subtype`+`api_error_status` 命中用量用盡詞 | usage_exhausted |
| 4 | `result.is_error`，沒命中 | infra_fail |
| 5 | 有要求 schema 但 `structured_output` 缺漏 | infra_fail |
| 6 | 否則 | ok |

**判不出來一律 infra_fail，不判 usage_exhausted。** infra_fail 只是多重試三次，usage_exhausted 會讓整個 orchestrator 停住等人；誤判成本不對稱，落在保守那一邊。真的撞到上限時 `status` 會是什麼值還沒有樣本。

字串比對保底有兩種，差別在能不能比對 stdout：

- **一次性 JSON 路徑比對 stdout。** 走到這裡代表 stdout 是一坨 parse 不了的東西，本身就是錯誤訊息。
- **stream-json 路徑只比對 stderr，絕不比對 stdout。** 它的 stdout 是一堆合法的 JSON 事件行，而 `rate_limit_event` 每次呼叫都會出現 -- 比對清單只要有任一詞撞上那個事件的內容，就會把每次失敗都判成用量用盡。

**比對清單刻意不放 `out_of_credits`。** 它是 `rate_limit_event` 的 `overageDisabledReason` 值，而那個事件在每一次成功的 stream-json 呼叫裡都會出現（見上面 `overageStatus:"rejected"` 那段）。放進清單的話，任何沒印出 result 事件就結束的 stream，都會因為 stdout 裡有這個字串而被判成用量用盡。清單目前是 `usage limit` / `rate limit` / `5-hour limit` / `weekly limit`，沒有真的撞到上限驗證過，是保守起點，遇到真實案例要回來補。

### agent 繼承什麼環境

**分界在使用者層與專案層之間，不在「有沒有設定」。** 使用者層（`~/.claude/`）進得來：那是這台機器的擁有者對所有 agent 的偏好，他知道自己寫了什麼、改得動、也預期它生效。專案層擋掉：agent 在那一側看到什麼只由 loom 的提示詞決定，`.loom/context.md` 是唯一管道。loom 用 `--setting-sources user`。

實測結果（`claude -p` 2.1.221，探針放在一個獨立的 `HOME` 底下，hook 是否觸發用它自己 `touch` 出來的標記檔判定，不靠 agent 自述）：

| `--setting-sources` | 全域 `CLAUDE.md` | 專案 `CLAUDE.md` |
| --- | --- | --- |
| 預設（不帶） | 載入 | 載入 |
| `user` | 載入 | 不載入 |
| `project` | 載入 | 載入 |
| `project,local` | 載入 | 載入 |
| `""` | 不載入 | 不載入 |

**這顆 flag 是整層開關，不是 `CLAUDE.md` 的開關。** `user` 之下 `~/.claude/` 的 hook、`permissions`、`env`、`skills/` 四項全部一起進來，沒有辦法只挑其中一項；`""` 之下四項全部沒有。實測驗到的兩個細節：

- **`permissions.deny` 在 `--permission-mode bypassPermissions` 之下照樣生效**，bypass 只跳過詢問。個人 deny 清單擋掉的路徑 coder 一樣讀不到，而那個失敗不會標成權限問題，只會表現成品質變差。
- **個人 hook 對每個 coder 生效。** 這是四項裡唯一會主動改變流程的：`PreToolUse` 回傳 deny 就擋掉工具呼叫。流水線行為因此掛在一個不在版控裡、也不在任何 run 記錄裡的檔案上，agent 反覆失敗時要往那裡查。

這是收下 `user` 的代價，接受它換到的是「個人規範只寫一份」。要縮回什麼都不載入是把值改回 `""`（不是 `local` -- 2.1.220 的舊註記說 `project,local` 不載入全域 `CLAUDE.md`，2.1.221 實測是載入的）。

**為什麼專案層仍然擋掉。** 更早的版本走 `project,local`，理由是專案 `CLAUDE.md` 是現成的 per-repo 規範管道，loom 完全不用參與。放棄它換來的是一條說得完的規則：agent 在專案那側看到什麼，只由 loom 的提示詞決定。一旦專案環境的一部分會進去，就得回答「哪些 skill、哪些 MCP、哪些 plugin 要用」，而答案會是角色乘上專案的矩陣，那是設定頁裡長不完的東西。專案背景改走 `.loom/context.md`（見「專案背景」），內容是 loom 讀進來填的，不是環境帶的。

**專案側的能力要補回來是 `--plugin-dir`，不是把 `--setting-sources` 放寬。** 它可重複、session-only、不受 `--setting-sources` 影響，實測在空清單下照樣載得到 plugin 的 skill。MCP 同理走 `--mcp-config` 配現有的 `--strict-mcp-config`，是純白名單。兩個都是「明確列舉」語意；現在都沒有需求，所以都不帶。

**`--bare` 和 `--safe-mode` 都不用。** `--bare` 關得掉 `CLAUDE.md` 自動探索，但強制走 `ANTHROPIC_API_KEY`，跟訂閱制決定衝突；`--safe-mode` 不強迫換 API key，但把 skill、plugin 一起關死，之後想用 `--plugin-dir` 明確給能力就沒得談。`--setting-sources` 關掉的範圍剛好，而且留著加回來的路。

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

**設定**：workspace 清單與每個 workspace 的 `main_branch`、`port_range`、平行上限。在 web UI 上編輯。新增 workspace 時只輸入 repo 路徑。issues 資料夾與 worktree 位置不在內，它們固定在 `.loom/` 底下（見「核心概念」與「git 拓撲」）。

執行指令不存在設定裡，見下節。

**`name` 與 `repo_path` 建立後不可改。** `name` 是 handle 的 key；`repo_path` 換掉等於換一個專案，而 `runs`、`issue_state`、`parent_state` 全都掛在同一個 `workspace_id` 上，issue 檔案與 worktree 也都推導自它。那兩件事該是新增一個 workspace，不是編輯這一個。

**改設定要等當前那一輪跑完（`PUT /settings` 回 409）。** `ctx.workspace` 是註冊當下的快照，所以存檔後整個 handle 換掉：舊排程器 `stop()`、用新的 workspace 重新 `registerWorkspace`，暫停狀態跟著搬過去。但 `stop()` 只清 timer -- 正在 `await` 的 `driveParent` 攔不住，它會拿著舊的 `main_branch` 把 rebase 與 merge 做完，跟剛存下去的設定對不上。所以有東西在跑時直接拒絕，不做中止：中止一個跑到一半的 coder 要處理 worktree 殘留與半完成的 commit，比「等它跑完」貴得多。

**issue 資料夾固定成 `.loom/issues`，不是設定。** 可設的值域實際上只有一個，卻要養一條路徑驗證（`..`、絕對路徑、指到 repo 根三種寫法都得擋，因為那個字串會被 `join` 進 `repo_path` 再交給 `git add`）加一整套設定 UI 與換資料夾時的確認流程。固定之後這些全部消失，`PUT /settings` 的 trust boundary 只剩 `main_branch`（會進 git 的參數列，限制在英數與 `. _ - /`）與三個數字欄位。

固定路徑要成立的前提是 `.loom/issues` 沒有被 `.gitignore` 蓋掉，這一點由 `commitStateChange` 的 `git add` 自己保證，見「目錄自我忽略」。

### 提示詞在 web UI 上可調

四個角色各一份可編輯的模板，存 DB，per-workspace。沒有繼承或覆寫的兩層邏輯。

**只有被編輯過的角色才在 DB 裡有一列**，沒有那一列就讀內建預設。原本寫的是「新增 workspace 時複製一份內建預設」，實作時改成這樣：複製的話，內建預設之後有任何修正都不會傳播到已存在的 workspace，而那些 workspace 的擁有者根本沒動過那個角色的模板；而且「這份是不是還停在出廠預設」得拿內容跟預設做字串比對才知道，改成有沒有那一列就直接是答案。「還原預設」因此是刪掉那一列，不是複製一份預設寫回去。

**預設內容是 loom 自己的出廠版本**（見「提示詞」），整份可編輯。每個角色下方列出可用變數，設定頁附「還原預設」把它復原成內建的出廠版本。

模板大致的形狀：

```
Read the parent issue and child issue below before changing code.
Implement only the requested child issue.
交棒前自己跑一次 typecheck 與相關測試。
不要修改 .loom 底下的任何檔案。

<parent_issue>{parent_md}</parent_issue>
<child_issue>{child_md}</child_issue>
<上一輪失敗>{last_failure}</上一輪失敗>
```

**`--json-schema` 不可編輯，在 UI 上顯示為唯讀。** 那是狀態轉移的判定依據，改壞了 orchestrator 讀不到 verdict 就整條流水線停擺，而症狀會表現成「agent 一直失敗」，很難查到根因。prompt 本體改壞了最多是產出品質變差，還救得回來。

為什麼要可編輯：內嵌的內容是通用的，不知道你這個專案的慣例、不知道 loom 的失敗紀錄要怎麼餵、不知道測試輸出只給 tail 200 行。那些是 loom 與專案的上下文，寫死在程式碼裡就沒得調。

**coder 只有一份模板，不分首次與重試。** `{last_failure}` 為空時那一段就是空的。重試輪其實可以另外設計專用指引，但先不加 -- 多一份模板就多一份要維護的分岔，等重試品質被證明不夠再說。

**不做版本歷史，編輯就是覆蓋。** 因此同一個 child 的第一次與第三次嘗試可能用不同版本的模板，`runs` 也不記錄用了哪一版。這是刻意的：看到 coder 一直踩同一個坑、改模板、讓當前重試立刻吃到新版，正是這個編輯功能的用途；凍結成「開工當下那一版」會把它變成「改了但這一輪不算」。代價是模板改壞了退不回上一版，只能重打或按還原預設回出廠版。

**實作：** 出廠預設在 `src/prompts.ts`（四個角色的 loom 自有版本）；per-workspace 的編輯版存在 `prompts` table。`agent.ts` 每次呼叫才讀 DB，不快取 -- 那是「當前重試立刻吃到新版」的實作方式。「還原預設」是把那一列刪掉，讀取時自然落回內建預設，不是複製一份預設寫回去，所以 `isDefault` 永遠等於「DB 裡沒有這一列」。變數替換認得的變數才換，不認得的原樣留著（打錯字時看得到 `{spce_md}` 留在 prompt 裡，比默默變成空字串好查）。

### 新增 workspace 時的資料夾選取

`repoPath` 要的是絕對路徑，但瀏覽器的資料夾選取（`webkitdirectory`、`showDirectoryPicker()`）基於安全設計一律不給絕對路徑。server 跟瀏覽器在同一台機器上，所以由 `GET /api/browse` 列目錄、前端拿它做選取器。只回目錄名稱與「含不含 `.git`」，不碰檔案內容。

**不限制可瀏覽的根目錄。** `POST /api/workspaces` 本來就收任意絕對路徑並在那裡跑 agent，列目錄名是嚴格更小的權限；限制在 `homedir` 之下只會擋掉 repo 放 `/mnt`、`/srv` 的正常用法，而且手動輸入完全不受那個限制，等於只擋 UI 不擋 API。前提是 server 綁 `127.0.0.1` 且沒有 CORS header（跨站網頁送得出這個 GET 但讀不到回應）。要對外開的話，這條跟 `/api/workspaces` 都得先有驗證，而後者是更急的那個。

### loom 自己的開發迴圈

`npm run dev` 用 Node 內建的 `--watch` 監看 `src/`，改動自動重啟。這是 loom 自己這個 server，跟被編排的專案怎麼起 server 沒有關係（見「測試階段跑什麼」）。

server 進程啟動時產生一個 `BOOT_ID`，SSE 的 `connected` 事件帶上它。server 重啟後瀏覽器的 `EventSource` 本來就會自動重連，前端發現 `bootId` 換了就 `location.reload()`。這樣改 `ui.html`（它是 `readFileSync` 讀的，不在 import 圖譜上，所以要 `--watch-path=src` 才追得到）不用手動重整，而且不需要另外接一套 hot reload 通道。一般手動重啟 server 也會觸發前端重載，那是對的行為：舊 UI 配新後端就是該重載。

### 人手寫的 parent issue

parent issue 固定放 `<repo>/.loom/issues/`。人可以直接在底下建 `<parent-slug>/`，放 parent 的描述檔與各 child issue 檔，不必經過「討論」分頁。

**child 檔沒有 front matter 時就地補一份 `status: draft`、`e2e: false`、`blocked_by: []`。** 補寫做在 `loadIssues` 裡，它是所有讀取路徑的共同入口 -- 另開一個 normalize 步驟就得在每個呼叫端記得先跑一次，漏掉一個就是一條會讀到沒有 front matter 的檔案而炸掉的路徑。補上的內容不另外 commit：這條路徑包含唯讀的看板查詢，那份 front matter 由下一次狀態轉移的 `git add` 一併帶走。落點是 draft，所以補完也不會有東西自己跑起來。

**不讀 body 裡的任何欄位。** 早期版本會讀 markdown body 的 `**Status:**` 與 `**Blocked by:**` 行映射成 loom 的狀態，拿掉了。兩邊的值域對不上：那五個 triage 標籤（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）沒有一個表示「已完成」，而 loom 的 child 有十一個狀態，映射只在「還沒開工」那一端說得通。`Blocked by` 更糟 -- 實際寫法會帶括號註解（`01(共用純模組，由 01 建立骨架)`），逗號切分產出的是指向不存在 id 的 blocker，而 `blocked_by` 只在 frontier 卡住、止血機制要判斷哪些下游可以頂替時才被讀（見「Blocked by」），所以那種錯誤會安靜地等到第一次有 child blocked 才發作，且症狀是「該擋的沒擋」。

手寫的 child 要宣告依賴就自己寫 front matter 的 `blocked_by`。正常執行照檔名編號序列走，編號排對了空著也能跑。

**採用 loom 之前就做完的 parent：在 parent 的狀態檔寫 `merged: true`。** 所有 child 都 done 的 parent 會聚合成 verifying，而 verifying 用的 worktree 只在派工時建立，那種 parent 從沒派工過，路徑不存在。`merged: true` 讓它直接落進已合併那一列，也誠實描述事實 -- 那些程式碼早就在 main 了，沒有 diff 可驗、沒有 e2e 該跑。

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
- **零設定就能跑。** 這些名稱多數 Node 專案本來就有。要求專案先加幾行 `loom:*` 才會動的話，沒加的專案走的是「沒有可跑的東西 → `pass: true`」那條路，也就是契約沒人履行、而懲罰是假綠燈把 child 推成 done。

**monorepo：根層沒有的階段往子 package 找。** 根層有該階段的 script 就只跑根層 -- 專案自己寫的 `pnpm -r test` 或 `turbo run test` 是明確意圖，再遞迴一次等於同一批測試跑兩遍。根層沒有才展開 workspaces（`package.json` 的 `workspaces`，含 yarn v1 的 `{ packages: [...] }` 寫法；pnpm 則讀 `pnpm-workspace.yaml`），每個有該 script 的子 package 依目錄排序依序跑，各自以自己的目錄為 cwd，第一個紅的就停下並在 summary 裡標出是哪個 package。

子 package 一律用 `npm run`，不去偵測套件管理器的遞迴語法（`pnpm -r` / `yarn workspaces foreach` / `npm --workspaces`）：`npm run` 只是讀那一份 `package.json` 的 scripts 再交給 sh，pnpm 那種 symlink 的 `node_modules/.bin` 一樣認得，而安裝早就在根層用 lockfile 選出的套件管理器做完了。安裝維持只在根層做一次，monorepo 本來就是這樣裝的。

不做這件事的話，前後端分在 `apps/web`、`apps/api` 的專案在 loom 眼裡是「沒有 typecheck/test/e2e」，走的是 `pass: true` 那條路。那是所有假綠燈裡最貴的一種：看起來一切正常，實際上一行測試都沒跑。

早期版本認的是 `loom:setup` / `loom:dev` / `loom:typecheck` / `loom:test` / `loom:e2e`，理由是 port 注入沒有通則（Vite 吃 `--port`，Next 吃 `-p`）。拿掉了：port 注入只有 loom 自己要起 dev server 時才是問題，而那件事本來就該由 e2e 框架做（見「測試階段跑什麼」）。loom 自己的 `package.json` 一個 `loom:*` 都沒有，跑的就是慣例名稱。

代價：專案的 `test` 如果是 watch mode（`vitest` 不加 `run`），這裡會一路跑到逾時才被砍成 infra failure。症狀看得見，不是假綠燈，而 CI 本來也跑不了 watch mode，所以這種 script 早晚要改。

壞掉的條件：非 Node 專案沒有 `package.json`。`pnpm-workspace.yaml` 寫成 flow 形式（`packages: ['a', 'b']`）認不出來，會落回「不是 monorepo」-- 手寫解析只認 block 形式的清單，換不到為了一個欄位裝 YAML 依賴。

### 觀測

agent 的 stream-json 即時轉發到 SSE，web 上看得到 agent 現在在做什麼。跑二十分鐘完全看不見裡面是不可接受的，而這幾乎免費。

**完整輸出不落地。** 一個 child 的 stream-json 可能幾 MB，乘上 child 數與重試次數會把 DB 撐爆。只存摘要（耗時、成本、files_changed、verdict），失敗時才存完整 stdout，那時才需要它。

**實作現況：** `claude.ts` 的 `runClaude` 有給 `onEvent` 才切換成 `--output-format stream-json --verbose` 逐行解析，沒給就維持既有的 `--output-format json` 一次性路徑，行為不變。事件粒度是「一個 assistant 內容區塊」，不追蹤 token-level 的 partial delta（不帶 `--include-partial-messages`）、不等 tool_result 回來（那些只換得到 tool_use_id 對應的額外狀態，換不到「看得懂 agent 在幹嘛」這個目標）。orchestrator 用一個純記憶體的 `LiveOutputStore`（key 是 run id）暫存，run 一結束就 `clear()`，完全不落地，跟上面「完整輸出不落地」一致。

接上的有 coder、issue_reviewer、以及測試階段的指令（`testrunner.ts` 透過同一條管線報 `kind:"port"` 與跑了哪個 script）。parent issue reviewer 與 parent 層的 e2e 沒接：它們的 child 是 null，看板目前沒有它們的顯示位置。

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

訂閱制照樣回傳，不是空的。loom 每次 agent 跑完記一列，就能按 child、parent、角色、日期任意切。

顯示：頂列今日 token 與花費；child 面板本輪花費與 token；parent 面板總花費與 token。

**token 顯示成「輸入 / 輸出」兩個數字**，輸入是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 的總和。分成兩個是因為它們的意義不同：輸出是真正的生成量，輸入大部分是快取重讀。同時看得到花費和這兩個數字，才能分辨「這次很貴」是快取沒命中還是真的生成很多。

三個判讀上的陷阱要記著：

- **`input_tokens` 不是輸入量。** 上面那筆 `input_tokens` 是 2 而 `cache_read_input_tokens` 是 9985。真正的輸入是三個欄位相加，只看第一個會低估好幾千倍。
- **token 總量與金額是兩條曲線。** 四類 token 單價不同（output 最貴、cache read 最便宜），一個 parent 可能 token 多但便宜（大量快取命中），也可能 token 少但貴。要比較就分開記。
- **訂閱制下金額不是帳單。** 那是「如果走 API 會花多少」的等價換算，用途是相對比較（這個 parent 比那個貴三倍、這次重試燒掉半個 parent 的量），不是預測還能跑多久 -- 5 小時與每週視窗官方沒公布 token 換算。

那 9985 是一次「只回一個 ok」的空白呼叫的固定開銷，量測時還是 `--setting-sources project,local`，裡面含全域 `CLAUDE.md` 與 plugin skill 清單。改成空清單之後同樣一次空白呼叫是 3668（`claude -p` 2.1.220，同一組 flag，只差 `--setting-sources`），剩下的是 system prompt 加工具定義。對照組：完全不帶 `--setting-sources` 是 13562。

改成 `--setting-sources user` 之後重量一次（2.1.221、`--tools ""`、同一組 flag）：`""` 是 3297，`user` 是 5862。使用者層的固定開銷是每次呼叫 +2565 token，主要來自全域 `CLAUDE.md` 與 `~/.claude/skills/` 的清單。

## 明確不做

| 不做 | 加回來的條件 |
| --- | --- |
| kanban 拖拉 | 人可觸發的轉移多到按鈕列排不下 |
| 認證與授權 | 要在 localhost 以外的地方跑 |
| tester agent | 決定改由獨立角色寫測試 |
| mergeable 自動 merge 白名單 | 人工閘門真的成為瓶頸，且有信任的 parent 類型 |
| `--resume` 接回中斷的 agent | 重跑成本高到不可接受，且驗證過中斷點的行為 |
| 用 `Blocked by` 平行執行同 parent 的 child | 不加。一個 parent 一個 worktree，平行改同一份 checkout 會撞 |
| 內嵌 `wayfinder` | 不加。它是規劃階段，看板不該同時裝決策票和實作票 |
| coder 的重試專用模板（含 `diagnosing-bugs`） | 重試品質被證明不夠時 |
| 詞彙表與規範文件的路徑欄位 | 不加。路徑寫在可編輯的提示詞裡，agent 有 Read 工具 |
| 讓 agent 寫 `.loom/context.md` | 不加。人用編輯器改，它就在 repo 裡。無人值守的 coder 一路上發現的東西沒有人在旁邊判斷值不值得寫進去，而寫錯的背景會影響之後每一個 parent。要補的話走 chat 角色（人在場、有討論脈絡），並且得先把 coder 那條「不准碰 `.loom/`」改寫成只保護 `.loom/issues` |
| `.loom/context.md` 的過期偵測 | 不加。真正的風險不是不好更新，是過期而沒有人發現。等真的踩到再看要什麼訊號，現在猜不準 |
| 讓人編輯 `--json-schema` | 不加。改壞了整條流水線停擺且症狀難查 |
| review 意見寫進 issue 檔案的 `## Comments` | skills 有這個慣例，但每次重試都往 git-tracked 檔案加文字，commit 會吵。想在 loom 外面讀得到歷史時再換 |
| 兩層狀態同步（parent 也有完整狀態機） | 不加。parent 狀態一律由 child 聚合算出 |
| 多 provider 抽象層 | 要接非 Claude 的執行體 |
| 指令設定欄位（安裝 / typecheck / test / e2e） | 要接沒有 `package.json` 的專案 |
| 讀 markdown body 的狀態詞彙（`Status:` / `Blocked by:`） | 不加，理由見「人手寫的 parent issue」 |
| 可設定的 issue 資料夾 | 不加。固定 `.loom/issues`，換位置的自由度換不到那條路徑驗證與整套設定 UI 的成本 |
| 已合併 parent 搬進 `archived` | 不加。`merged: true` 已經是狀態的唯一事實來源，搬移會讓所在位置變成第二個來源，而 DB 記錄與重名檢查都以資料夾名為 key |
| 已合併 parent 的歷史檢視 | 需要查跨 parent 的統計，而 issues 資料夾與 git log 答不出來 |
| PR 層的第三次 review | 不加。一個 parent 一次 merge，PR 的 diff 就是 parent issue review 看過的那一份 |
| parent issue review 意見的「之後再說」暫存 | 不加。理由見「parent issue review 意見的處理」 |
