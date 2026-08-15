# 核心概念與準則

核心概念、命名規則與準則清單。準則清單為指引索引,有衝突時以各主題檔內文為準。

## 核心概念

| 概念 | 定義 |
| --- | --- |
| workspace | 一個 git repo 加上它的執行設定 |
| base branch | workspace 設定的整合分支（`develop`、`main`、`trunk` 等，由使用者決定）。所有 group branch 從它分出、rebase 回它、merge 回它。設定欄位 `base_branch` |
| issue group | 討論定稿後產生的一組 issue。不是 issue；一條 `issue-group/<NNNN>-<slug>` 分支、一個 worktree、一個 merge 單位，在看板上顯示為 lane |
| issue | 唯一的工作單元，掛在某個 issue group 底下。狀態機直接作用在這層，是 coder/reviewer 實際處理的單元 |

模型是 issue group 加一組 issue，不是 issue group / issue。**group 不是 issue**，所以不拿 issue number，也不在看板上顯示 group id。單 issue 需求就是一個 group 裡只有一個 issue，不需要做成 group with one issue。

issue group 在結構上提供四件事：agent 的 prompt context、衝突域宣告（同 group 的 issue 序列執行）、kanban swimlane、merge 單位。同一個 issue group 的檔案固定放在 `<repo>/.loom/issues/<NNNN>-<slug>/`，group 的描述與各 issue 都在裡面；位置固定、不可設，理由同舊設計的 `.loom/specs`。

每個 issue 都有 workspace 內單調遞增的穩定編號，方便 commit、review、history 回追，顯示成 `#0001`。issue number 不因為 title、slug、所在 group 改變而改變，不可重用。lane 不顯示獨立的 group-id badge；group 的序號內嵌在 branch／worktree／issues 目錄名裡（見 [命名規則](#命名規則)），方便異常時追蹤，但不單獨前景顯示。卡片顯示 issue number。

### 命名規則

branch、worktree、issues 目錄共用同一個 `<NNNN>-<slug>` token，三者一致才能在 `git branch`、`git worktree list`、`ls .loom/worktrees/`、`ls .loom/issues/`、log 之間互相 grep 對得上。異常路徑（崩潰留下孤兒 worktree、rebase 中斷、磁碟掃描）靠的就是這個 token穩定且唯一。

| 工件 | 命名 |
| --- | --- |
| group branch | `issue-group/<NNNN>-<slug>` |
| group worktree | `<repo>/.loom/worktrees/<NNNN>-<slug>/` |
| issues 目錄 | `<repo>/.loom/issues/<NNNN>-<slug>/` |
| group 描述檔 | `<repo>/.loom/issues/<NNNN>-<slug>/group.md` |
| issue 檔 | `<repo>/.loom/issues/<NNNN>-<slug>/<issue-no>.md`（用全域 issue number，不再用 group 內局部序號） |
| commit message | `#<issue-no> <issue title>` |

- `<NNNN>` 是 group 序號：workspace 內單調遞增、零補零四位、定稿時配、不可改、不可重用。它不顯示成 `#NNNN`（group 不是 issue），只出現在路徑與 branch 名裡。
- `<slug>` 是 kebab-case 人類可讀名，可改；number 固定所以即使 slug 改了，branch／worktree 還認得出是同一個 group。
- `<issue-no>` 是 issue 的全域編號（四位零補），作為檔名主檔名。同 group 裡的 issue 檔按全域號排序就是執行序。

### 檔案格式

issue 檔與 group 描述檔的欄位定義。**型別邊界鎖死在 flat string / bool / array-of-strings**：解析是 hand-rolled（見 [docs/frontmatter.md](../docs/frontmatter.md)），不引 YAML 套件，欄位長出巢狀結構解析會靜默壞掉；要擴欄位先確認型別仍在邊界內。

**issue 檔 `<issue-no>.md`：**

```
---
status: ready
e2e: false
blocked_by: []
takes_over: null
log: []
---

# <issue title>

<body：描述、驗收條件>
```

| 欄位 | 型別 | 誰寫、何時 |
| --- | --- | --- |
| `status` | 十狀態之一 | orchestrator，每次轉移 |
| `e2e` | bool | 定稿時配，之後不動 |
| `blocked_by` | 全域 issue no 陣列 | 定稿時配；planning 產出裡的 title 引用在此時轉成實際編號 |
| `takes_over` | 全域 issue no 或 null | 接手 issue 開檔時配一次，指回它接手的 issue |
| `log` | string 陣列 | orchestrator，每個階段結束 append 一行 |

**group 描述檔 `group.md`：**

```
---
merged: false
blocked_reason: null
---

<group 描述 body>
```

規則：

1. **front matter 是 orchestrator 的禁臠，人與 planning 只寫 body。** 唯一寫入者在 main checkout（見 [git.md](git.md) 的「狀態寫入」）。
2. **log 永不進 body。** `source_hash` hash 的正是兩個 body（見 [state-machine.md](state-machine.md) 的「來源過期偵測」），issue done 之後往 body append 東西會讓它誤報過期。
3. **log 行格式是 `<phase>:<result>[:一句摘要]`**，如 `implement:ok files=3`、`review:reject:測試只測實作細節,未測行為`。不帶時間戳：順序即資訊，精確時間在 DB 的 runs 表，加了只讓每次轉移的 diff 更吵。
4. **分界是「這份資料死了會不會傷狀態機」。** 會的進檔案（`log` 行、`takes_over`——交接鏈斷了 retry_loop 追不了）；不會的進 DB（review 意見全文、測試輸出、session id、耗時、成本）。
5. 人手寫的 issue 缺 front matter 時由 `loadIssues` 就地補最小一份，落點 draft（見 [impl.md](../impl.md) 的「人手寫的 issue group」）。

## 準則清單

散在各節的結構與流程規則，開發時照這份查；理由與細節在對應小節。**這份是指引索引，不是規格本身——有衝突時以各節內文為準。**

### 結構

- issue group 不是 issue；lane 顯示 issue group，card 顯示 issue。
- issue group 提供：prompt context、衝突域、kanban swimlane、merge 單位；一條 `issue-group/<NNNN>-<slug>` 分支、一個 worktree。命名規則見 [命名規則](#命名規則)。
- 檔案固定放 `<repo>/.loom/issues/<NNNN>-<slug>/`，位置不可設。group 序號內嵌路徑與 branch；卡片顯示全域 issue `#0001`。
- issue 檔與 group.md 的欄位集、`log` 行格式見 [檔案格式](#檔案格式)。
- group 狀態**一律由內部 issue 聚合算出**，狀態檔只有 `merged` 與 `blocked_reason`（issue 推不出來的事實）。不做兩層狀態同步。

### 狀態機

- issue 10 狀態；`done`／`dropped`／`failed` 是終端。
- 主狀態對應看板四欄：`ready`、`implementing`、`reviewing`、`done`。
- `reviewing` 內部分兩個 phase：`llm_review` → `test_verification`；phase 只影響 badge，不是看板欄位。
- 線性前進：`implementing → reviewing → done`，沒有回頭邊。`reviewing` 內任一 phase 失敗進 `failed` 終端，自動開接手 issue（同一條失敗鏈上限 2 個，第 3 個 group 進 `retry_loop`）。
- infra error 超過重試上限 → `blocked` → 人處理 → `ready`；`blocked → dropped` 連坐下游未開工 issue。
- `human` 不派工。
- group 聚合用 first-match 表（blocked 與執行中可同時成立）。

### 派工與執行

- orchestrator 持有狀態、**push 派工**；不是 coder 呼下一棒、不是 agent 輪詢。
- orchestrator 的決策一律確定性，**不用 LLM 做流程判斷**。
- 同 group 的 issue 依編號序列執行，**不平行**（一個 group 一個 worktree）。
- 跨 group 平行，上限 per-workspace（預設 2）。
- `Blocked by` 只用來**止血／排序**，不用來平行化同 group 的 issue。

### git

- **coder 不自己 commit**，orchestrator 代 commit；diff 為空送 reviewer 判定。
- 每個 issue 完成後 rebase group branch 到最新 base branch；衝突寫 `blocked_reason: rebase_conflict`。
- 清理一律**三段式**：`rebase --abort || true` → `reset --hard <base_sha>` → `clean -fd`。
- merge 粒度：group 全綠才一次 merge 回 base branch，**人工觸發**。
- merge 時先 rebase；帶進**非 issues 路徑**的 commit 才退回 verifying 重驗（排除 loom 自己的狀態 commit）。
- 只有 orchestrator 在 main checkout 寫 issues front matter；agent worktree 不碰 `.loom/issues`。
- group merged 後回收 worktree、刪 branch。

### agent 邊界

- 五個 LLM 角色：chat、planning、coder、issue reviewer、group reviewer。**沒有 tester**（`reviewing.test_verification` 裡的測試由 orchestrator subprocess 跑，不是 LLM）。
- coder 不重新規劃 group、不在無人值守階段加需求；只完成當前 issue。
- coder 禁碰 `.loom/`（保護 orchestrator 狀態）。
- chat 禁改任何檔案（`--disallowedTools Write Edit`）。
- reviewer 只讀 diff、不寫檔、context 乾淨（不看 coder 辯解），同時判定測試品質。
- 專案背景進 agent 的唯一管道是 `.loom/context.md`，**只讀不寫**，讀主 checkout 版本。

### 驗證

- 每個 issue：coder 在 `implementing` 結尾自跑 typecheck／unit；review 通過後，orchestrator 在 `reviewing.test_verification` 重跑 typecheck／unit；`e2e: true` 的 issue 多跑 e2e。
- group 內所有 issue done 後：完整 e2e + group review，過了才 mergeable（七個綠燈疊起來未必綠）。
- e2e 紅**先原地重跑一次**，兩次都紅才算 domain fail；unit test 不需這層。
- 測試由 orchestrator 跑（process group、逾時整組收掉），**不由 LLM 跑**；typecheck 先跑。
- 沒有可跑 script → `pass:true` 但標警告；worktree 不存在 → 拋錯停排程器。

### 失敗與重試

- **infra 重試原地、domain 失敗終端化，兩者獨立。** infra error 原地重跑（獨立計數 + backoff）；domain 失敗讓 issue 進 `failed` 終端、自動開接手 issue，不原地重做。
- infra 重試前提是「再跑可能不同」：API error 成立；超時、git 衝突不成立，直接 blocked。
- 接手 issue 一律從 base_sha 三段式清理後乾淨重寫，帶前一個 issue 的失敗紀錄。
- 用量視窗用盡：**暫停整個 orchestrator**，不動 issue 狀態；看板有手動暫停／恢復開關。
- 崩潰恢復順序不能顛倒：先對未 merged group worktree 一致性檢查（rebase 中途／髒工作區），再依狀態處理——`implementing` 回捲，`review*`／`test*` **不動 code** 重派（崩潰不算 domain 失敗，不終端化）。

### 來源過期與自動收斂

- `source_hash` 只對 done 有意義，是 derived boolean、**不是狀態**、不擋 merge。
- 整體 e2e 紅自動開 issue：同一 group **累計 2 次上限**，第 3 次標 `blocked_reason: e2e_loop` 等人看。
- group review 意見**不自動開 issue**，只掛在 mergeable group 給人看（架構意見是人的判斷）。
