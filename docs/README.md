# docs

loom 上一次實作階段的呼叫封裝與 snippet,以 code 形式保留。**設計文件不在這裡**——設計在 `DESIGN.md`(入口)與它導覽的 `core/`、`agents/`、`ui/`、`impl.md`。這裡是下次實作時的程式碼參照,避免重新踩同一批坑。

多數 snippet 的結構仍有效,但綁舊模型的命名與狀態集,照新設計實作時要改(見各列「與新設計的落差」)。

| 檔案 | 內容 | 與新設計的落差 |
| --- | --- | --- |
| `claude-cli.md` | 從 Node 呼叫 claude code agent:兩種輸出格式、`--json-schema`、隔離 flag、`--resume`、result 事件判讀、`rate_limit_event` 兩個陷阱、用量偵測。含完整 `claude.ts` 與測試 fixture | 無落差,仍有效。CLI 行為不因 loom 模型演進改變。`impl.md` 的 CLI 章節是這份的設計論證版 |
| `git.md` | worktree、rebase、三段式清理、review diff 排除清單與 pathspec 的兩個坑、worktree `.git` 目錄位置、目錄自我忽略。含完整 `git.ts` | 操作封裝有效;函式與變數命名綁 `spec`(`mergeSpecIntoMain`、`onlyTouchesSpecsDir` 等),要照新設計改成 issue group |
| `frontmatter.md` | hand-rolled YAML parser、body hash、手寫補 front matter。含完整 `frontmatter.ts` | parser 結構有效;`IssueStatus` 集合綁舊模型(無 `failed` 終端、`test_ready`/`testing` 是獨立狀態、缺 `reviewing` 的 phase),要照 `core/state-machine.md` 重定 |
| `prompts.md` | 模板變數替換、一角色一份模板、schema 唯讀。含完整 `prompts.ts` | 結構有效;變數名與角色綁舊模型(`{parent_md}`/`{child_md}`、`spec_reviewer`),要改成 `{group_md}`/`{issue_md}`、group reviewer |

> `statemachine.md` 已移除:它綁的舊狀態機(review 回頭邊、testing 獨立、無 `failed` 終端、無公設 2)與新設計差距過大,只剩下「用 `Partial<Record>` 表達轉移表」「first-match 聚合」這個形狀可參考,價值不足以抵銷維護一份與設計矛盾的程式碼。新狀態機照 `core/state-machine.md` 重寫。
