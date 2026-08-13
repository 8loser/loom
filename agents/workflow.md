# 產 issue group 的流程

chat 常駐對話 → planning → orchestrator 落地的完整流程。角色定義見 agents/roles.md。

## chat 與 planning 產 issue group

常駐 `claude -p --input-format stream-json --output-format stream-json`，web 端雙向串接，cwd 在 main checkout。實作在 `src/chat.ts`：一個 workspace 同時只有一份進行中的討論（`chat_sessions` 表，`workspace_id` 當 PK），對應討論分頁上單一 thread 的畫面。

**工具限制不是 `--disallowedTools Write Edit`，是 `--tools Read,Glob,Grep` 白名單。** 原計畫擋 Write/Edit 是想著「它要能讀 repo code 才討論得具體，但不該碰任何檔案」，但實測發現 `--disallowedTools Write Edit` 只擋了那兩個工具名，`Bash` 沒被擋，而 agent 發現 Write 被擋之後會自己改用 `Bash` 的 heredoc（`cat > file <<EOF`）照樣寫成功。改用白名單就是結構上只剩 Read/Glob/Grep 三個工具可用，Bash 根本不在清單裡，沒有繞路可走 -- 跟 issue reviewer 用的是同一份清單（`agent.ts` 的 `READ_ONLY_TOOLS`），不是另外發明一套。

常駐 process 是效能優化（同一個 process 上的每一輪吃得到 prompt cache），不是正確性要求：`session_id` 落 DB，process 閒置逾時（10 分鐘）或意外死掉都用 `--resume` 補一個新的，對話從模型角度不斷。**兩個 process 不能同時碰同一個 session** -- 定稿前一定要先把常駐 process 完全結束（等到 `close` 事件，不是叫了 `stdin.end()` 就當結束），再用一次性呼叫 `--resume` 疊上去，不然會拿到「找不到這個 session」（`--resume` 也綁 cwd，同一個 session 用不同 cwd 去 resume 一樣找不到）。

**拆 issue 不在 chat 裡做。** chat 只負責把粗略想法談成一份 rough draft（`{group_md, issues:[{title, body}]}`）；分群、依賴、旗標、衝突偵測是 planning agent 的工作，見 [agents/roles.md](roles.md) 的「planning agent」。拆分方式是設計決策：哪些改動綁在一起、誰先誰後、依賴邊怎麼連，這是人最該介入的地方，所以多一道 planning 讓人看過再定稿。

落地時疊一次 `--resume` + `--json-schema` 的一次性呼叫（不是常駐 process 那條線）拿 rough draft `{slug, group_md, issues:[{title, body}]}`，交給 planning agent 產最終的 `{groups:[...]}`，再由 orchestrator（`createGroupFromDraft`）配 group 序號與各 issue 的全域號、生 front matter、寫檔、commit 一次。狀態欄位不能讓 LLM 寫。group 序號與 issue 全域號都是 workspace 內單調遞增、定稿時配、不可改不可重用；`blocked_by` 在 planning 產出裡引用的是其他 issue 的 `title`（LLM 產出當下還不知道最終編號），落地時才轉成實際的全域 issue number。`slug` 沒通過 kebab-case 檢查就從 `group_md` 的內容 slugify 退回，不讓一個格式錯誤擋住整個定稿。

schema 裡的 `needs_human` 與 `e2e` 是分類旗標不是狀態欄位，由 orchestrator 決定寫成 `human` 還是 `ready`、`e2e` 是否要跑 e2e。這兩個旗標在 planning agent 那一步就標好，不是丟給 coder 去猜或事後補。沒有 `needs_human` 的話，討論出「需要判斷、需要外部存取」的 issue 只能標成 ready，然後發生的正是 `human` 狀態要避免的浪費：被 agent 抓走、失敗、開接手 issue、又失敗，浪費兩個 issue 才得到「這件事本來就不該自動做」。

**定稿按鈕不是開跑按鈕。** planning 產出的是建議，人看過、調整過，再按定稿才落地（寫檔、commit、喚醒排程器）。這是多出來的一道，刻意的：拆 issue 與排依賴是人最該介入的決策點，planning 給建議、人拍板。手寫丟進資料夾的 draft group 不走這條路，它本來就是人寫的，只需要看板上的放行按鈕。

定稿那一刻把這次討論的 `session_id` 從 `chat_sessions` 搬進 `group_state.chat_session_id`，`chat_sessions` 那列刪掉。**開跑後只能改還沒開始的 issue，可以追加新 issue，進行中和已完成的鎖住** -- 這條規則本身還沒有介面實作，`chat_session_id` 先落地是為它鋪路：orchestrator 本來就在派工前才讀 issue 檔案，所以這幾乎零成本。修改走 `--resume` 回到原對話以維持 group 描述一致性，或直接編輯檔案。
