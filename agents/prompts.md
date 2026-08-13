# 提示詞與專案背景

四個角色的內建提示詞、.loom/context.md 作為專案背景唯一管道。模板 snippet 見 docs/prompts.md。

## 提示詞

loom 的提示詞是內建的出廠預設，per-workspace 可在 web UI 覆寫。內建版本只提供角色邊界與輸入資料的位置，不依賴外部 plugin、不要求專案安裝特定 prompt 套件，也不把外部模板當相容目標。

| loom 的提示詞 | 責任 |
| --- | --- |
| chat | 把粗略想法整理成一個 issue group 與一組排序後的 issue |
| coder | 在 worktree 裡實作單一 issue |
| issue reviewer | 檢查單一 issue 的 diff 是否符合 group/issue 描述與專案背景 |
| group reviewer | 檢查整個 issue group 合併後的跨 issue 一致性與遺漏 |

chat 的提示詞要產出 issue group 的問題、目標、限制、測試指引、跨 group 依賴，以及 issue 的順序、依賴、人類判斷需求與 e2e 需求。coder 不在無人值守階段新增需求或重新規劃 group，它只讀 group/issue 描述並完成當前 issue。

### 專案背景

**專案背景進 agent 的唯一管道是 `.loom/context.md`。** loom 讀它，填成 `{context_md}` 模板變數，coder 與兩個 reviewer 的提示詞裡都有一個 `<context>` 區塊。專案自己的 `CLAUDE.md`、`CONTEXT.md`、`CODING_STANDARDS.md` 都不參與，提示詞也不叫 agent 自己去找那些檔案 -- 那等於讓專案的環境決定 agent 看到什麼，跟「專案層擋掉」的立場衝突（見 [impl.md](../impl.md) 的「agent 繼承什麼環境」）。

**內容放什麼由使用者決定，loom 不規定。** 提示詞只說「這是這個專案要你先知道的事」，整份原樣塞進 `<context>` 區塊，不解析、不分節、不假設裡面是詞彙表還是編碼規範。loom 只把這份內容交給 agent，不從中推導設定；`<context>` 講到的事情優先於內建提示詞的一般性指引。

**為什麼是 loom 自己的檔案，不是讀專案既有的 `CONTEXT.md`。** 讀既有檔案在技術上更省事，但那是把 loom 的行為綁在「這個 repo 剛好有沒有那個檔案、裡面剛好寫了什麼」上。loom 要能單獨運作，設定空間跟專案既有的分開。要用既有內容就自己複製過去，那是一次明確的決定，不是隱含的耦合。

**為什麼是檔案，不是 DB 欄位。** 跟 `.loom/issues` 同一個理由：進版控、跟著 branch 走、協作者看得到、人可以直接編輯。存 DB 的話它會變成單機的、不在版控裡的第二份真相。

**讀主 checkout 的版本，不是 worktree 的。** 跟 issue group 的描述一致。某條 issue group branch 改了 `.loom/context.md` 不該立刻對別條 branch 正在跑的 coder 生效，那會讓同一批平行的 issue group 拿到不同背景而且沒有訊號。

沒有這個檔案時 `{context_md}` 是空字串，模板留一個空的 `<context>` 區塊，agent 照樣跑。設定頁不回報它在不在：寫不寫是使用者的事，沒有它也不擋執行，多一個欄位只是多一個要維護的東西。

**只有讀，沒有寫。** loom 沒有任何角色寫得了這個檔案：coder 的提示詞禁止碰 `.loom/`（那條規則是為了保護 orchestrator 狀態），chat 的提示詞禁止改任何檔案。要建立或更新就人自己編輯，它在 repo 裡，跟改任何一個 markdown 檔一樣。這是刻意的，理由與代價記在「明確不做」。
