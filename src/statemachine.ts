import type { IssueStatus, SpecBlockedReason } from "./frontmatter.ts";
import { MID_STATES } from "./frontmatter.ts";

export type IssueEvent =
  | "finalize" // draft -> ready
  | "claim" // ready/review_ready/test_ready -> next mid state（派工）
  | "coder_done" // implementing -> review_ready
  | "review_pass" // reviewing -> test_ready
  | "review_reject" // reviewing -> implementing
  | "test_pass" // testing -> done
  | "test_fail" // testing -> implementing
  | "escalate" // 任一中間狀態 -> blocked（error 或超過重試上限）
  | "recover" // blocked -> ready
  | "drop" // blocked -> dropped（先收目前進度）
  | "human_complete" // human -> done
  | "human_reset"; // human -> ready

const TRANSITIONS: Partial<Record<IssueStatus, Partial<Record<IssueEvent, IssueStatus>>>> = {
  draft: { finalize: "ready" },
  ready: { claim: "implementing" },
  implementing: { coder_done: "review_ready", escalate: "blocked" },
  review_ready: { claim: "reviewing" },
  reviewing: {
    review_pass: "test_ready",
    review_reject: "implementing",
    escalate: "blocked",
  },
  test_ready: { claim: "testing" },
  testing: {
    test_pass: "done",
    test_fail: "implementing",
    escalate: "blocked",
  },
  blocked: { recover: "ready", drop: "dropped" },
  human: { human_complete: "done", human_reset: "ready" },
};

/** 純函式：給定目前狀態與事件，回傳下一個狀態；不合法的轉移回傳 null。 */
export function transition(from: IssueStatus, event: IssueEvent): IssueStatus | null {
  return TRANSITIONS[from]?.[event] ?? null;
}

export function canTransition(from: IssueStatus, event: IssueEvent): boolean {
  return transition(from, event) !== null;
}

const TERMINAL: IssueStatus[] = ["done", "dropped"];
const STUCK: IssueStatus[] = ["blocked", "human"];

export interface IssueNode {
  id: string; // "02"
  status: IssueStatus;
  blockedBy: string[];
}

function transitiveDependents(stuckId: string, issues: IssueNode[]): Set<string> {
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of issues) {
      if (dependents.has(issue.id)) continue;
      if (issue.blockedBy.includes(stuckId) || issue.blockedBy.some((d) => dependents.has(d))) {
        dependents.add(issue.id);
        changed = true;
      }
    }
  }
  return dependents;
}

/**
 * 一個 spec 一個 worktree，任何時刻最多一個 issue 在中間狀態。回傳下一個該
 * 派工的 issue id，或 null（沒有可做的）。
 *
 * 正常路徑純粹照編號序列走。Blocked by 只在 frontier 卡住（blocked 或
 * human）時才用來找後面第一個不依賴那個卡住 issue 的 ready issue 頂替 --
 * 這是止血機制，不是平行排程器。
 */
export function nextDispatchable(issues: IssueNode[]): string | null {
  const sorted = [...issues].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.some((i) => MID_STATES.includes(i.status))) return null;

  const frontier = sorted.find((i) => !TERMINAL.includes(i.status));
  if (!frontier) return null;

  if (frontier.status === "ready") return frontier.id;

  if (STUCK.includes(frontier.status)) {
    const blockedDownstream = transitiveDependents(frontier.id, sorted);
    const fallback = sorted.find(
      (i) => i.status === "ready" && !blockedDownstream.has(i.id),
    );
    return fallback ? fallback.id : null;
  }

  return null; // frontier 是 draft，還沒定稿
}

export type SpecDisplayStatus =
  | "merged"
  | "spec_blocked"
  | "blocked"
  | "human"
  | "running"
  | "verifying"
  | "mergeable"
  | "queued"
  | "draft";

export interface SpecAggregateInput {
  merged: boolean;
  blockedReason: SpecBlockedReason | null;
  issues: { status: IssueStatus }[];
  /** 只有在所有 issue 都到達終端時才有意義；否則忽略。 */
  verifyResult: "pending" | "pass" | "fail" | null;
}

/**
 * spec 顯示狀態，by-上而下 first-match（見 DESIGN.md「spec 層」）。
 * 這是唯一權威的聚合邏輯 -- kanban 與崩潰恢復都要用同一份，不能各自用
 * `*ing` 字面猜一次。
 */
export function aggregateSpecStatus(input: SpecAggregateInput): SpecDisplayStatus {
  if (input.merged) return "merged";
  if (input.blockedReason !== null) return "spec_blocked";

  const { issues } = input;
  if (issues.length === 0) throw new Error("spec has no issues to aggregate");

  if (issues.some((i) => i.status === "blocked")) return "blocked";
  if (issues.some((i) => i.status === "human")) return "human";
  if (issues.some((i) => MID_STATES.includes(i.status))) return "running";

  const allTerminal = issues.every((i) => TERMINAL.includes(i.status));
  if (allTerminal) {
    if (input.verifyResult === "pass") return "mergeable";
    return "verifying";
  }

  if (issues.some((i) => i.status === "ready")) return "queued";
  if (issues.every((i) => i.status === "draft")) return "draft";

  throw new Error(
    `aggregateSpecStatus: issue status combination not covered by the eight rows: ${JSON.stringify(
      issues.map((i) => i.status),
    )}`,
  );
}
