# 狀態機 snippet

這份綁的是舊模型（parent/child、testing 是獨立狀態、review 有回頭邊）。`DESIGN.md` 已經演進到 issue group + 公設 2（失敗終端化），**這份不再與設計一致**，留著只是當狀態機實作的形狀參考：轉移表怎麼用 `Partial<Record>` 表達、聚合怎麼用 first-match 寫、`nextDispatchable` 的 frontier 止血邏輯。

要照新設計重寫時，結構可沿用，狀態集合與邊要重定。

---

## 轉移表

用巢狀 `Partial<Record>`：外層是「從哪個狀態」，內層是「哪個事件 → 到哪個狀態」。不合法的轉移查表得 undefined，回傳 null。

```ts
const TRANSITIONS: Partial<Record<IssueStatus, Partial<Record<IssueEvent, IssueStatus>>>> = {
  draft: { finalize: "ready" },
  ready: { claim: "implementing" },
  implementing: { coder_done: "review_ready", escalate: "blocked" },
  // ...
};
```

好處：狀態機的合法邊一目了然，新增狀態或邊只動這張表，transition 函式不用改。

---

## 聚合用 first-match，不用互斥 if-else

group 的顯示狀態由內部 issue 聚合。`blocked` 與「執行中」可以同時成立（止血讓不相干的 issue 在別的 issue blocked 時繼續跑），互斥寫法無解，優先序才有。由上而下 first-match，第一列命中就停：

```ts
if (input.merged) return "merged";
if (input.blockedReason !== null) return "spec_blocked";
if (issues.some((i) => i.status === "blocked")) return "blocked";
// ...
```

---

## 中間狀態一律列舉，不用 `*ing` 字面

`review_ready` 是持久狀態，字面上不含 ing。用萬用字元比對會漏掉它，orchestrator 因用量視窗暫停時整批狀態會凍在那裡。崩潰恢復的掃描用同一份列舉。

---

## 完整 snippet

### `statemachine.ts`

```ts
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

```

### `statemachine.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transition,
  canTransition,
  nextDispatchable,
  aggregateSpecStatus,
  type IssueNode,
} from "./statemachine.ts";

test("every DESIGN.md edge is reachable via transition()", () => {
  assert.equal(transition("draft", "finalize"), "ready");
  assert.equal(transition("ready", "claim"), "implementing");
  assert.equal(transition("implementing", "coder_done"), "review_ready");
  assert.equal(transition("review_ready", "claim"), "reviewing");
  assert.equal(transition("reviewing", "review_pass"), "test_ready");
  assert.equal(transition("reviewing", "review_reject"), "implementing");
  assert.equal(transition("test_ready", "claim"), "testing");
  assert.equal(transition("testing", "test_pass"), "done");
  assert.equal(transition("testing", "test_fail"), "implementing");
  assert.equal(transition("blocked", "recover"), "ready");
  assert.equal(transition("blocked", "drop"), "dropped");
  assert.equal(transition("human", "human_complete"), "done");
  assert.equal(transition("human", "human_reset"), "ready");
});

test("escalate reaches blocked from every state an agent actually runs in", () => {
  assert.equal(transition("implementing", "escalate"), "blocked");
  assert.equal(transition("reviewing", "escalate"), "blocked");
  assert.equal(transition("testing", "escalate"), "blocked");
});

test("done and dropped are terminal: no outgoing transitions", () => {
  for (const event of [
    "finalize",
    "claim",
    "coder_done",
    "review_pass",
    "review_reject",
    "test_pass",
    "test_fail",
    "escalate",
    "recover",
    "drop",
    "human_complete",
    "human_reset",
  ] as const) {
    assert.equal(canTransition("done", event), false);
    assert.equal(canTransition("dropped", event), false);
  }
});

test("nextDispatchable: normal sequential path picks the lowest-numbered ready issue", () => {
  const issues: IssueNode[] = [
    { id: "01", status: "done", blockedBy: [] },
    { id: "02", status: "done", blockedBy: [] },
    { id: "03", status: "ready", blockedBy: [] },
    { id: "04", status: "ready", blockedBy: ["02"] },
  ];
  assert.equal(nextDispatchable(issues), "03");
});

test("nextDispatchable: nothing dispatched while an issue is mid-state", () => {
  const issues: IssueNode[] = [
    { id: "01", status: "done", blockedBy: [] },
    { id: "02", status: "reviewing", blockedBy: [] },
    { id: "03", status: "ready", blockedBy: [] },
  ];
  assert.equal(nextDispatchable(issues), null);
});

test("nextDispatchable: blocked frontier lets an independent later issue through", () => {
  // mirrors the mobile-slot-settings example from DESIGN.md
  const issues: IssueNode[] = [
    { id: "01", status: "done", blockedBy: [] },
    { id: "02", status: "blocked", blockedBy: [] },
    { id: "03", status: "ready", blockedBy: ["02"] },
    { id: "04", status: "ready", blockedBy: ["02"] },
    { id: "05", status: "ready", blockedBy: [] },
    { id: "06", status: "ready", blockedBy: ["04"] },
    { id: "07", status: "ready", blockedBy: ["01", "06"] },
  ];
  assert.equal(nextDispatchable(issues), "05");
});

test("nextDispatchable: transitive dependents of a blocked issue are all skipped", () => {
  const issues: IssueNode[] = [
    { id: "01", status: "blocked", blockedBy: [] },
    { id: "02", status: "ready", blockedBy: ["01"] }, // direct dependent
    { id: "03", status: "ready", blockedBy: ["02"] }, // transitive dependent
    { id: "04", status: "ready", blockedBy: [] }, // independent, dispatchable
  ];
  assert.equal(nextDispatchable(issues), "04");
});

test("nextDispatchable: blocked frontier with no independent work returns null", () => {
  const issues: IssueNode[] = [
    { id: "01", status: "blocked", blockedBy: [] },
    { id: "02", status: "ready", blockedBy: ["01"] },
  ];
  assert.equal(nextDispatchable(issues), null);
});

test("nextDispatchable: human frontier also lets independent work through", () => {
  const issues: IssueNode[] = [
    { id: "01", status: "human", blockedBy: [] },
    { id: "02", status: "ready", blockedBy: ["01"] },
    { id: "03", status: "ready", blockedBy: [] },
  ];
  assert.equal(nextDispatchable(issues), "03");
});

test("nextDispatchable: all terminal returns null (verifying kicks in elsewhere)", () => {
  const issues: IssueNode[] = [
    { id: "01", status: "done", blockedBy: [] },
    { id: "02", status: "dropped", blockedBy: [] },
  ];
  assert.equal(nextDispatchable(issues), null);
});

test("nextDispatchable: all draft returns null", () => {
  const issues: IssueNode[] = [{ id: "01", status: "draft", blockedBy: [] }];
  assert.equal(nextDispatchable(issues), null);
});

function agg(overrides: Partial<Parameters<typeof aggregateSpecStatus>[0]>) {
  return aggregateSpecStatus({
    merged: false,
    blockedReason: null,
    issues: [{ status: "ready" }],
    verifyResult: null,
    ...overrides,
  });
}

test("aggregateSpecStatus: merged wins over everything else", () => {
  assert.equal(
    agg({ merged: true, blockedReason: "rebase_conflict", issues: [{ status: "blocked" }] }),
    "merged",
  );
});

test("aggregateSpecStatus: spec_blocked wins over issue-level states", () => {
  assert.equal(
    agg({ blockedReason: "rebase_conflict", issues: [{ status: "ready" }] }),
    "spec_blocked",
  );
});

test("aggregateSpecStatus: any blocked issue wins over human/running", () => {
  assert.equal(
    agg({ issues: [{ status: "blocked" }, { status: "human" }, { status: "implementing" }] }),
    "blocked",
  );
});

test("aggregateSpecStatus: human wins over running (surface the thing needing a person first)", () => {
  assert.equal(agg({ issues: [{ status: "human" }, { status: "reviewing" }] }), "human");
});

test("aggregateSpecStatus: running when any issue in a mid state", () => {
  assert.equal(agg({ issues: [{ status: "done" }, { status: "testing" }] }), "running");
});

test("aggregateSpecStatus: all-terminal with pending verify shows verifying", () => {
  assert.equal(
    agg({ issues: [{ status: "done" }, { status: "dropped" }], verifyResult: "pending" }),
    "verifying",
  );
});

test("aggregateSpecStatus: all-terminal with verifyResult fail is still verifying, not mergeable", () => {
  assert.equal(
    agg({ issues: [{ status: "done" }], verifyResult: "fail" }),
    "verifying",
  );
});

test("aggregateSpecStatus: all-terminal with verify pass shows mergeable", () => {
  assert.equal(agg({ issues: [{ status: "done" }], verifyResult: "pass" }), "mergeable");
});

test("aggregateSpecStatus: done+ready mix (spec-review or e2e-loop follow-up issue) shows queued, not draft", () => {
  assert.equal(agg({ issues: [{ status: "done" }, { status: "ready" }] }), "queued");
});

test("aggregateSpecStatus: all draft shows draft", () => {
  assert.equal(agg({ issues: [{ status: "draft" }, { status: "draft" }] }), "draft");
});

test("aggregateSpecStatus: throws on an uncovered combination instead of silently misclassifying", () => {
  assert.throws(() => agg({ issues: [{ status: "draft" }, { status: "done" }] }));
});

test("aggregateSpecStatus: throws on empty issue list", () => {
  assert.throws(() => agg({ issues: [] }));
});

```
