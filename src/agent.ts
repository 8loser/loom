import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runClaude, type ClaudeRunResult } from "./claude.ts";
import { readScripts } from "./devserver.ts";
import { DEFAULT_TEMPLATES, renderTemplate, type PromptRoleName } from "./prompts.ts";
import type { AgentRunner, AgentRequest, AgentResponse } from "./orchestrator.ts";

/**
 * 模板從哪裡來。server 傳一個讀 DB 的實作進來（per-workspace 可編輯，見
 * DESIGN.md「提示詞在 web UI 上可調」）；沒傳就用內建預設，測試與任何不想
 * 碰 DB 的呼叫端都走這條。
 */
export type TemplateSource = (workspaceId: number, role: PromptRoleName) => string;

export const builtinTemplates: TemplateSource = (_workspaceId, role) => DEFAULT_TEMPLATES[role];

const CODER_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
  },
  required: ["done", "summary", "filesChanged"],
};

const ISSUE_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "reject"] },
    comments: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "comments"],
};

const SPEC_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    comments: { type: "array", items: { type: "string" } },
  },
  required: ["comments"],
};

/**
 * schema 不可編輯（DESIGN.md：「改壞了 orchestrator 讀不到 verdict 就整條
 * 流水線停擺，而症狀會表現成『agent 一直失敗』，很難查到根因」）。設定頁
 * 顯示它但是唯讀，所以要匯出。
 */
export const ROLE_SCHEMAS = {
  coder: CODER_SCHEMA,
  issue_reviewer: ISSUE_REVIEW_SCHEMA,
  spec_reviewer: SPEC_REVIEW_SCHEMA,
  chat: null,
} as const;

// 唯讀白名單：不給 Write/Edit/Bash，結構上就做不到修改東西，比只靠 prompt
// 交代更硬（`--disallowedTools Write Edit` 擋不住 Bash 用 heredoc 寫檔，實測
// 見 DESIGN.md「chat 產 spec」）。reviewer 與 chat 共用同一份 -- coder 不
// 設限（未帶 tools 用預設全套），它本來就該能讀寫跑指令。
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 讀 spec.md / issue 檔給模板用。讀不到就給空字串，讓 agent 自己去 Read。 */
function readOr(path: string | undefined, fallback = ""): string {
  if (!path) return fallback;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

/** package.json 的全部 scripts 攤成一行一個給 coder 讀，省得每次都重查一遍。 */
function formatScripts(worktreePath: string): string {
  const scripts = readScripts(worktreePath);
  if (!scripts) return "";
  return Object.entries(scripts)
    .map(([name, command]) => `${name}: ${command}`)
    .join("\n");
}

/** 模板變數的唯一來源。prompts.test.ts 用它檢查設定頁宣告的變數都填得出值。 */
export function templateVarsFor(req: AgentRequest): Record<string, string | undefined> {
  const specMdPath = join(req.workspace.repoPath, req.workspace.specsDir, req.spec, "spec.md");
  return {
    spec: req.spec,
    spec_md: readOr(specMdPath),
    issue_md: readOr(req.issuePath),
    diff: req.diff ?? "",
    last_failure: req.lastFailure ?? "",
    base_sha: req.baseSha ?? "",
    attempt: String(req.attempt),
    main_branch: req.workspace.mainBranch,
    repo_path: req.workspace.repoPath,
    scripts: formatScripts(req.worktreePath),
  };
}

function toAgentResponse(role: AgentRequest["role"], result: ClaudeRunResult): AgentResponse {
  if (result.outcome === "usage_exhausted") return { outcome: "usage_exhausted" };
  if (result.outcome === "infra_fail") return { outcome: "infra_fail", usage: result.usage };

  const payload = result.structuredOutput as Record<string, unknown>;
  const base = { outcome: "ok" as const, usage: result.usage!, sessionId: result.sessionId };

  switch (role) {
    case "coder":
      return {
        ...base,
        coder: {
          done: Boolean(payload.done),
          summary: String(payload.summary ?? ""),
          filesChanged: Array.isArray(payload.filesChanged) ? (payload.filesChanged as string[]) : [],
        },
      };
    case "issue_reviewer":
      return {
        ...base,
        issueReview: {
          verdict: payload.verdict === "pass" ? "pass" : "reject",
          comments: Array.isArray(payload.comments) ? (payload.comments as string[]) : [],
        },
      };
    case "spec_reviewer":
      return {
        ...base,
        specReview: {
          comments: Array.isArray(payload.comments) ? (payload.comments as string[]) : [],
        },
      };
  }
}

export interface ClaudeAgentOptions {
  templates?: TemplateSource;
  model?: string;
  timeoutMs?: number;
}

export function createClaudeAgentRunner(options: ClaudeAgentOptions = {}): AgentRunner {
  const templates = options.templates ?? builtinTemplates;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (req: AgentRequest): Promise<AgentResponse> => {
    const template = templates(req.workspace.id, req.role);
    const prompt = renderTemplate(template, templateVarsFor(req));

    const result = await runClaude({
      cwd: req.worktreePath,
      prompt,
      jsonSchema: ROLE_SCHEMAS[req.role] ?? undefined,
      tools: req.role === "coder" ? undefined : READ_ONLY_TOOLS,
      model: options.model,
      timeoutMs,
      onEvent: req.onEvent,
    });

    return toAgentResponse(req.role, result);
  };
}
