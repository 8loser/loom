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
