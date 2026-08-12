# docs

這裡是 loom 之前實作階段實測過、確認可行的呼叫方法與封裝，以 code snippet 形式保留。**不是目前的有效實作**——專案形狀還在重新規劃（見 `DESIGN.md` 與 `mockup.html`），這些 snippet 留著當下一次實作的參照，避免重新踩同一批坑。

| 檔案 | 內容 | 與現況的關係 |
| --- | --- | --- |
| `claude-cli.md` | 從 Node 呼叫 claude code agent：兩種輸出格式、`--json-schema`、隔離 flag、`--resume`、result 事件判讀、用量偵測 | 仍然有效，CLI 行為不因 loom 模型演進改變 |
| `git.md` | worktree、rebase、三段式清理、review diff 排除清單、pathspec 的坑 | 操作封裝有效；綁的「spec」命名要照新設計改成 issue group |
| `statemachine.md` | 轉移表、聚合 first-match、dispatch 止血 | 結構可沿用；狀態集與邊綁舊模型（parent/child、testing 獨立、review 回頭邊），要重定 |
| `frontmatter.md` | hand-rolled YAML parser、body hash、手寫補 front matter | 有效 |
| `prompts.md` | 模板變數替換、一角色一份模板、schema 唯讀 | 結構有效；變數名與角色稱呼綁舊模型（`{parent_md}`/`{child_md}`），要照新設計改 |

每份開頭都標了它跟 `DESIGN.md` 現況的落差，避免誤導。
