# loom

狀態機驅動的本地多 Agent 編排系統。

## 目標

以 `.loom/` 底下的 issue 為輸入，自動驅動 coder 與 reviewer 完成實作與驗證，最終由人決定是否 merge。

無人值守是核心目標：晚上啟動一個 issue group，隔天早上看結果。所有設計取捨在「減少人工介入次數」與「其他考量」衝突時，優先前者。

## 設計公設

loom 的設計從這幾條設計公設推導出來，規則與狀態機都該回得到這裡。

1. **討論定稿會產生 issue group，group 內有一個或多個 issue。** issue group 不是 issue；group 的看板狀態由內部 issue 聯合決定，issue 是實際被執行的單元。
2. **issue 在實作中只能往前。** 失敗不退回同一個 issue 重做，而是讓它進終端、由新 issue 接手。

> **公設 2 已落實到狀態機。** domain 失敗（review reject／test fail／build fail）不退回同一個 issue 重做，而是讓 issue 進 `failed` 終端，由 orchestrator 在同一個 group 自動開接手 issue（同一條失敗鏈累計 2 個為上限，第 3 個把 group 標 `retry_loop`）。infra 失敗不算公設 2 的「倒退」：它沒有產出 verdict，原地重跑，不終端化。

## 文件導覽

完整設計拆成下列各檔,本檔只留總覽與邊界聲明。

**核心邏輯** (core/)

- [concepts.md](core/concepts.md) — 核心概念、命名規則、準則清單
- [state-machine.md](core/state-machine.md) — issue 狀態機、group 聚合、看板呈現、來源過期偵測
- [git.md](core/git.md) — git 拓撲、worktree 寫入契約、Blocked by、base_sha、狀態寫入
- [failure-retry.md](core/failure-retry.md) — 失敗與重試、崩潰恢復
- [verification.md](core/verification.md) — 兩層 review、驗證階段

**Agent** (agents/)

- [roles.md](agents/roles.md) — 拓撲、五個 LLM 角色、planning 分界、為何沒有 tester
- [workflow.md](agents/workflow.md) — chat → planning → orchestrator 落地流程
- [prompts.md](agents/prompts.md) — 提示詞、專案背景(.loom/context.md)

**實作** — [impl.md](impl.md) — 技術棧、資料存放、提示詞可調、觀測與用量顯示（CLI 整合見 docs/claude-cli.md）

**參考 snippet** (docs/) — 上一次實作階段的呼叫封裝,多數仍有效,見 docs/README.md

## 明確不做

| 不做 | 加回來的條件 |
| --- | --- |
| kanban 拖拉 | 人可觸發的轉移多到按鈕列排不下 |
| 認證與授權 | 要在 localhost 以外的地方跑 |
| tester agent | 決定改由獨立角色寫測試 |
| mergeable 自動 merge 白名單 | 人工閘門真的成為瓶頸，且有信任的 group 類型 |
| `--resume` 接回中斷的 agent | 重跑成本高到不可接受，且驗證過中斷點的行為 |
| 用 `Blocked by` 平行執行同 group 的 issue | 不加。一個 group 一個 worktree，平行改同一份 checkout 會撞 |
| 內嵌 `wayfinder` | 不加。它是規劃階段，看板不該同時裝決策票和實作票 |
| coder 的重試專用模板（含 `diagnosing-bugs`） | 重試品質被證明不夠時 |
| 詞彙表與規範文件的路徑欄位 | 不加。路徑寫在可編輯的提示詞裡，agent 有 Read 工具 |
| 讓 agent 寫 `.loom/context.md` | 不加。人用編輯器改，它就在 repo 裡。無人值守的 coder 一路上發現的東西沒有人在旁邊判斷值不值得寫進去，而寫錯的背景會影響之後每一個 group。要補的話走 chat 角色（人在場、有討論脈絡），並且得先把 coder 那條「不准碰 `.loom/`」改寫成只保護 `.loom/issues` |
| `.loom/context.md` 的過期偵測 | 不加。真正的風險不是不好更新，是過期而沒有人發現。等真的踩到再看要什麼訊號，現在猜不準 |
| 讓人編輯 `--json-schema` | 不加。改壞了整條流水線停擺且症狀難查 |
| review 意見寫進 issue 檔案的 `## Comments` | skills 有這個慣例，但每次重試都往 git-tracked 檔案加文字，commit 會吵。想在 loom 外面讀得到歷史時再換 |
| 兩層狀態同步（group 也有完整狀態機） | 不加。group 狀態一律由 issue 聚合算出 |
| 多 provider 抽象層 | 要接非 Claude 的執行體 |
| 指令設定欄位（安裝 / typecheck / test / e2e） | 要接沒有 `package.json` 的專案 |
| 讀 markdown body 的狀態詞彙（`Status:` / `Blocked by:`） | 不加，理由見「人手寫的 issue group」 |
| 可設定的 issue 資料夾 | 不加。固定 `.loom/issues`，換位置的自由度換不到那條路徑驗證與整套設定 UI 的成本 |
| 已合併 group 搬進 `archived` | 不加。`merged: true` 已經是狀態的唯一事實來源，搬移會讓所在位置變成第二個來源，而 DB 記錄與重名檢查都以資料夾名為 key |
| 已合併 group 的歷史檢視 | 需要查跨 group 的統計，而 issues 資料夾與 git log 答不出來 |
| PR 層的第三次 review | 不加。一個 group 一次 merge，PR 的 diff 就是 group review 看過的那一份 |
| group review 意見的「之後再說」暫存 | 不加。理由見「group review 意見的處理」 |
