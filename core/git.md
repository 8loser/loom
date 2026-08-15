# Git 拓撲與寫入契約

分支/worktree 拓撲、worktree 寫入契約、多 group 交互、Blocked by、base_sha、狀態寫入。git 操作 snippet 見 docs/git.md。

## git 拓撲

| 項目 | 決定 |
| --- | --- |
| 分支 | 一個 issue group 一條 `issue-group/<NNNN>-<slug>`，一個 worktree |
| worktree 位置 | `<repo>/.loom/worktrees/<NNNN>-<slug>`，目錄自帶 `.gitignore`（內容 `*`）不讓它弄髒主 checkout |
| issue 執行順序 | 同 group 依 issue 編號序列，跨 group 平行；有 issue 卡住時用 `Blocked by` 判斷哪些後續仍可做 |
| 平行上限 | per-workspace，預設 2。每個跑動的 group 佔一個 worktree、一份依賴、一個 claude process，測試期間可能再多一個測試自己起的 server |
| merge 粒度 | group 全綠才一次 merge 回 base branch，人工觸發 |
| coder 交棒時 | **orchestrator 代 commit**，見下節 |
| 每個 issue 完成後 | rebase group branch 到最新 base branch，衝突就寫 `blocked_reason: rebase_conflict` |
| 按下 merge 時 | 先 rebase；若帶進**碰到 issues 以外路徑**的 commit 才退回 verifying 重驗，過了才真的合併 |
| merged 之後 | `git worktree remove` 加 `git branch -d issue-group/<NNNN>-<slug>` |

**worktree 放 repo 內。** 放 `~/.loom/worktrees/` 的話 worktree 會在 repo 被刪之後變成孤兒、路徑也跟專案脫節。Claude Code 自己的 `EnterWorktree` 用 `.claude/worktrees/`，是同一個取捨的旁證。

這個決定曾經有一項代價：coder 的 cwd 是 worktree，Claude Code 從那裡一路往上找 `CLAUDE.md`，路徑必然經過主 checkout 的 `<repo>/CLAUDE.md`，那是 base branch 的版本，會跟 worktree 自己 checkout 出來的那份疊加，而且沒有訊號能分辨哪份該贏。改成只吃使用者層之後專案的 `CLAUDE.md` 不再載入，這項代價消失了。

**目錄自我忽略，不改 repo 根的 `.gitignore`。** 建 worktree 前先寫 `.loom/worktrees/.gitignore`，內容一個 `*`。repo 根那份是使用者的檔案，loom 不去動它；被 `*` 蓋到的 `.gitignore` 自己照樣生效，git 讀忽略規則不看檔案自身的忽略狀態。忽略規則絕不能寫成 `.loom/` -- 那會把 `issues` 一起蓋掉，狀態 commit 就沒有路徑可以落地。失敗是響亮的（`commitStateChange` 用明確路徑 `git add .loom/issues`，底下有被 ignore 的新檔案時 git 會 exit 非 0 並列出來），所以不需要另外做啟動檢查；`add -A` 才是會靜默跳過的那種寫法，這也是不用它的理由之一。

### worktree 那一側的寫入契約

issues 資料夾那側規定得很死（只有 orchestrator 在 main checkout 寫）。group branch 這側要有對等的規定，否則 review、rebase、reset、merge 四條路徑都預設「coder 的產出已經被固化」而沒人負責固化。

**commit 由 orchestrator 代做，不由 coder 做。** coder subprocess 正常結束且回傳 `done: true` 時，orchestrator 在該 worktree 執行：

```
git add -A
git commit -m "#0001 <issue title>"
```

然後才把 issue 轉成 `review_ready`。

不讓 coder 自己 commit 的理由：coder 忘了 commit 是靜默失敗，而且症狀完全誤導 -- `git diff <base_sha>..HEAD` 恆為空，每個 issue 都會走進「diff 為空送 reviewer 判定」被判成「根本沒做」進 `failed`、開接手 issue，而 worktree 裡躺著完整實作；接著 rebase 在髒工作區上失敗。要讓 coder 自己 commit，就得在 schema 加 `commit_sha` 讓 orchestrator 驗證它真的做了，那還不如 orchestrator 直接做。

**清理一律是三段式**，不是單一 reset：

```
git rebase --abort || true
git reset --hard <base_sha>
git clean -fd
```

`git reset --hard` 不刪 untracked 的新檔，也不中止進行中的 rebase。崩潰恢復與接手 issue「從乾淨狀態重寫」宣稱的乾淨，只有加上 `rebase --abort` 與 `clean -fd` 才成立。少了 `clean -fd`，agent 死在半路留下的新檔會被下一個接手 issue 繼承，而且因為是 untracked，`git diff` 看不到、reviewer 也看不到。

**worktree 在 group merged 之後回收。** 不回收的話每個跑過的 group 留下一份完整 checkout 加一份裝出來的依賴，平行上限只限制同時跑幾個、不限制累積幾個。磁碟滿之後安裝與 git 操作開始失敗，被歸成 setup 失敗直接 blocked，早上看到一排像是 agent 做壞的 blocked，根因是磁碟。

### 多個 group 平行時的交互點

舊設計裡 group（當時叫 spec）之間完全獨立，只透過 rebase 被動互動。現在多了可宣告的跨 group 依賴（見下節），但被動交互點不變：

**分支漂移**：靠每個 issue 完成後的 rebase 吸收其他 group 已合併的東西，不會累積成巨大分歧。

**撞車**：兩個 group 改到同一批檔案，後者的 rebase 會衝突進 blocked。planning agent 會做預先偵測（見 [agents/roles.md](../agents/roles.md) 的「planning agent」）：讀活 issue 的 `touches[]` 與新 issue 的預測檔案範圍，重疊就編排 block 或順序。但這是建議不是保證——agent 預測的檔案範圍會不準，rebase 衝突本身仍是可靠的安全網。看板上要把「blocked 原因是 rebase 衝突」標清楚，讓人一眼看出是撞車不是 agent 做壞。

**過期的驗證結果**：group 進 mergeable 後等人按按鈕的期間，另一個 group 可能已經合併。所以按下 merge 時先 rebase，若帶進新 commit 就退回 verifying 重驗。這是「七個綠燈的 issue 疊起來未必綠」同一個論證的延伸：兩個各自綠燈的 group 疊起來也未必綠。

**但判定必須排除 loom 自己的狀態 commit。** 每個 issue 進 done 時 orchestrator 都往 base branch 塞一個只動 issues 的 commit，所以另一個 group 只要還在跑，base branch 就一直在前進。照「帶進任何新 commit 就重驗」會讓 mergeable 的 group 被反覆打回 verifying 跑幾分鐘 e2e，而帶進來的東西跟任何 code 無關，每次還要人再按一次按鈕。判定式是：

```
git diff --name-only <old-base>..<new-base> -- . ':!.loom/issues/'
```

輸出為空就直接合併，不重驗。

merge 本身不需要額外的鎖，orchestrator 是單一事件迴圈，兩個 merge 不可能同時發生。

### Blocked by：止血與跨 group 排序

`blocked_by` 是同一種邊，出現在兩個 scope，差別只在預設：

**同一個 group 內（issue → issue）：止血。** issue 可以用 front matter 宣告 blocking edges：

```
01-fix-e2e-page-object              Blocked by: None
02-extract-slot-timeline-module     Blocked by: None
03-shared-timeline-range            Blocked by: 02
04-split-shared-components-...      Blocked by: 02
05-migrate-modals-to-form-modal     Blocked by: None
06-mobile-layout                    Blocked by: 04
07-mobile-e2e-coverage              Blocked by: 01, 06
```

預設照編號跑（編號本身視為拓撲排序），blocked_by 只在有 issue 卡住時用來判斷哪些後續不受影響。上例中 02 進 blocked，03、04、06、07 都直接或間接依賴它，但 05 可以繼續做，group 不會整條停擺等人半夜起來處理。

**不用來平行化。** 一個 group 一個 worktree，兩個 issue 同時改同一份 checkout 會撞。邊只改變「跳過哪些」，不改變「同時幾個在跑」。

**跨 group（group → group）：排序。** 這是舊設計沒有的能力。預設 group 之間獨立、各自可開跑；group B 宣告 `blocked_by` group A 表示 B 要等 A。語意是 **wait-for-merge**：B 不開跑，直到 A 合併進 base branch，B 開跑時從 base branch 分支，自然吃得到 A 的產出，不需要共用 checkout。

**限同一個 workspace。** wait-for-merge 靠的是「A 合進 base branch、B 從 base branch 分支」，而 base branch 是 per-repo 的；A 在別的 workspace（別的 repo）合進它自己的 base branch，不會出現在 B 的 repo 裡，B 等了也吃不到 A 的程式碼。跨 workspace 的依賴會退化成沒有程式碼流的軟性排程提示，那是另一種東西，不支援。

**風險與緩解**：依賴邊是人或 LLM 宣告的，會漏。漏宣告的代價只出現在異常路徑（同 group 內有東西卡住時，或跨 group 時 B 拿不到 A 的產出），而異常路徑本來就是人要看的。沒有 `Blocked by` 這一行的 issue（手寫的）預設當成依賴前一個，退回編號序列。

實作範圍因此很小：解析那一行，同 group 內在 blocked 發生時算一次可達性，跨 group 在派工前檢查依賴是否已 merged。不需要排程器，不需要 DAG 執行引擎。

### base_sha

orchestrator 在每個 issue 開工時記下 group branch 當下的 HEAD，存進 DB。

reviewer 用 `git diff <base_sha>..HEAD`。沒有這個欄位的話只能用 `git diff <base-branch>..HEAD`，那會包含同 group 前面所有 issue 的改動，issue 07 的 review 會看到 01 到 06 的全部東西。

base_sha 同時提供「退回 issue 開工前」的能力，重試策略依賴它。

### 狀態寫入

狀態存在 issue 檔案的 front matter（group 的 `merged`／`blocked_reason` 存在 group 的狀態檔），git-tracked，跟著專案走。

強制規則：

1. **只有 orchestrator 在 main checkout 寫 front matter，agent 的 worktree 不碰 issues 資料夾。** 單邊修改 git 自動合併，雙邊寫同一個 YAML 就是衝突。
2. merge 前檢查 diff 是否碰到 issues 路徑，碰到就 blocked。
3. front matter 只放 [concepts.md](concepts.md)「檔案格式」定義的欄位（狀態機欄位，加 `takes_over` 與 `log`）。review 意見全文、測試輸出、session id、耗時、成本進 DB。那些是幾 KB 的雜訊，塞進 git-tracked 檔案會讓每次狀態轉移的 diff 無法閱讀；`log` 每階段一行的形狀是刻意壓在這條規則內的。
4. 每個 issue 進 done 時一次 commit 狀態到 base branch。中間轉移只寫檔不 commit，崩潰後從檔案讀，沒有損失。全部轉移都 commit 的話七個 issue 會產生四十幾個雜訊 commit。
