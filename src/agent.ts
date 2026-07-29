import { runClaude, type ClaudeRunResult } from "./claude.ts";
import type { AgentRunner, AgentRequest, AgentResponse } from "./orchestrator.ts";

/**
 * 這裡的模板是預設值，不是內嵌自 mattpocock/skills 的完整版本（見
 * DESIGN.md「提示詞的來源」）。那份裁剪 + 保留版權聲明的工作還沒做；這裡
 * 先給一份忠於 DESIGN.md 其餘規則（不碰 specs、seam 在 spec 裡找、reviewer
 * 唯讀）的堪用版本，讓 spawning 機制本身可以被驗證、可以真的接上
 * orchestrator 跑。vendored 版本就緒後只需要換這幾個字串，不動 agent.ts
 * 其他部分。
 */
export interface PromptTemplates {
  coderSystem: string;
  issueReviewerSystem: string;
  specReviewerSystem: string;
  model?: string;
}

export const DEFAULT_PROMPTS: PromptTemplates = {
  coderSystem: `You are implementing one issue from a spec-driven local orchestration pipeline (loom).

Before writing any code:
1. Read specs/<spec>/spec.md for context and specs/<spec>/issues/<NN>-*.md for what this specific issue asks for.
2. Read CONTEXT.md and any relevant ADRs under docs/adr/ if they exist, to match the project's existing vocabulary and decisions.
3. Test seams are decided in the spec's Testing Decisions section, if present -- test at those seams, do not invent new ones.

Rules:
- Do not modify anything under the specs/ directory. Orchestrator state lives there and only the orchestrator writes to it.
- Run typecheck and the relevant unit tests yourself before finishing.
- Prefer the smallest correct change. Don't refactor unrelated code.

When done, report via the tool: whether the issue is actually complete, a one-line summary of what changed, and the list of files you changed.`,

  issueReviewerSystem: `You are reviewing one completed issue from a spec-driven pipeline. You only see the diff below and the issue/spec text -- you do not see the coder's reasoning or excuses, by design.

Check:
- Does the diff actually do what the issue asked?
- Are there tests, and do they test behavior, not implementation details?
- Correctness, error handling, obvious bugs.

Read specs/<spec>/spec.md and specs/<spec>/issues/<NN>-*.md for context before judging. If the diff is empty, decide whether the issue was already satisfied by earlier work (pass) or nothing was actually done (reject).

Report via the tool: a verdict of pass or reject, and if reject, the specific comments the next attempt needs to address.`,

  specReviewerSystem: `You are reviewing an entire completed spec -- all its issues, merged together -- for cross-issue architectural consistency. Individual issues were already reviewed one at a time; you are the only one who sees the whole picture.

Look for: duplicated abstractions introduced by different issues, dead code left behind by an earlier issue that a later one made obsolete, and whether the spec as a whole actually solves what spec.md's Problem Statement describes, not just the sum of its issues.

You do not gate merging. Report comments only; do not propose a verdict.`,
};

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

// reviewer 唯讀：不給 Write/Edit/Bash，結構上就做不到修改東西，比只靠
// prompt 交代更硬。coder 不設限（未帶 tools 用預設全套），它本來就該能
// 讀寫跑指令。
const REVIEWER_TOOLS = ["Read", "Glob", "Grep"];

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function coderPrompt(req: AgentRequest): string {
  const lines = [`Spec: ${req.spec}`, `Issue: ${req.issue}`];
  if (req.lastFailure) {
    lines.push(
      "",
      "Your previous attempt on this issue failed review or tests. Here is what went wrong:",
      req.lastFailure,
      "Fix the actual problem -- don't just retry the same thing.",
    );
  }
  return lines.join("\n");
}

function issueReviewerPrompt(req: AgentRequest): string {
  const diff = req.diff ?? "";
  return [
    `Spec: ${req.spec}`,
    `Issue: ${req.issue}`,
    "",
    diff === "" ? "Diff: (empty -- decide per the empty-diff rule above)" : `Diff:\n${diff}`,
  ].join("\n");
}

function specReviewerPrompt(req: AgentRequest): string {
  return [
    `Spec: ${req.spec}`,
    `Read specs/${req.spec}/spec.md and all specs/${req.spec}/issues/*.md, and the full diff of this spec's branch against main, before commenting.`,
  ].join("\n");
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

export function createClaudeAgentRunner(
  templates: PromptTemplates = DEFAULT_PROMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): AgentRunner {
  return async (req: AgentRequest): Promise<AgentResponse> => {
    let systemPrompt: string;
    let prompt: string;
    let schema: object;
    let tools: string[] | undefined;

    switch (req.role) {
      case "coder":
        systemPrompt = templates.coderSystem;
        prompt = coderPrompt(req);
        schema = CODER_SCHEMA;
        tools = undefined;
        break;
      case "issue_reviewer":
        systemPrompt = templates.issueReviewerSystem;
        prompt = issueReviewerPrompt(req);
        schema = ISSUE_REVIEW_SCHEMA;
        tools = REVIEWER_TOOLS;
        break;
      case "spec_reviewer":
        systemPrompt = templates.specReviewerSystem;
        prompt = specReviewerPrompt(req);
        schema = SPEC_REVIEW_SCHEMA;
        tools = REVIEWER_TOOLS;
        break;
    }

    const result = await runClaude({
      cwd: req.worktreePath,
      prompt,
      appendSystemPrompt: systemPrompt,
      jsonSchema: schema,
      tools,
      model: templates.model,
      timeoutMs,
      onEvent: req.onEvent,
    });

    return toAgentResponse(req.role, result);
  };
}
