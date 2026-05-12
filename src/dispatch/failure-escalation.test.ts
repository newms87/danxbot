/**
 * Integration tests for {@link escalateOnRepeatedFailures} — the
 * scheduler-side orchestrator of DX-221 AC #1 (per-dispatch failure
 * tally + auto-escalate to Blocked).
 *
 * Pure helpers (`countTrailingFailures`, `buildEscalationText`) have
 * their own focused tests at `failure-tally.test.ts`. This suite covers
 * the DB → YAML → recordSystemError glue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { Issue } from "../issue-tracker/interface.js";

import { escalateOnRepeatedFailures } from "./failure-escalation.js";

function mkDispatch(overrides: Partial<Dispatch>): Dispatch {
  return {
    id: "d-id",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {
      cardId: "DX-221",
      cardName: "phase 6",
      cardUrl: "",
      listId: "",
      listName: "",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: "DX-221",
    status: "failed",
    startedAt: Date.UTC(2026, 4, 12, 8, 0, 0),
    completedAt: Date.UTC(2026, 4, 12, 8, 30, 0),
    summary: "fail",
    error: null,
    runtimeMode: "host",
    hostPid: null,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: "phil",
    mcpSettingsPath: null,
    recoverCount: 0,
    parentRecoverId: null,
    ...overrides,
  };
}

function mkIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 7,
    tracker: "memory",
    id: "DX-221",
    external_id: "tr-221",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Phase 6 cleanup",
    description: "body",
    priority: 3,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    ...overrides,
  } as Issue;
}

// Cast `vi.fn()` results to the strict types `escalateOnRepeatedFailures`
// expects; vitest's `Mock` shape is wider than the function signatures
// and the strict TypeScript build rejects the implicit narrowing.
type EscalateInput = Parameters<typeof escalateOnRepeatedFailures>[0];
type WriteIssueFn = NonNullable<EscalateInput["writeIssueFn"]>;
type RecordFn = NonNullable<EscalateInput["recordSystemErrorFn"]>;
type ListDispatchesFn = NonNullable<EscalateInput["listDispatches"]>;

function asListFn(mock: ReturnType<typeof vi.fn>): ListDispatchesFn {
  return mock as unknown as ListDispatchesFn;
}
function asWriteFn(mock: ReturnType<typeof vi.fn>): WriteIssueFn {
  return mock as unknown as WriteIssueFn;
}
function asRecordFn(mock: ReturnType<typeof vi.fn>): RecordFn {
  return mock as unknown as RecordFn;
}

describe("escalateOnRepeatedFailures", () => {
  let writeIssueFn: ReturnType<typeof vi.fn>;
  let recordSystemErrorFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeIssueFn = vi.fn().mockResolvedValue(undefined);
    recordSystemErrorFn = vi.fn();
  });

  it("returns below-threshold + does not write when count < threshold", async () => {
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card: mkIssue(),
      listDispatches: asListFn(
        vi.fn().mockResolvedValue([mkDispatch({}), mkDispatch({})]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });

    expect(result).toEqual({
      failureCount: 2,
      escalated: false,
      skipReason: "below-threshold",
    });
    expect(writeIssueFn).not.toHaveBeenCalled();
    expect(recordSystemErrorFn).not.toHaveBeenCalled();
  });

  it("escalates when count >= threshold: stamps status Blocked + blocked record + appends comment", async () => {
    const card = mkIssue();
    const fixedNow = new Date(Date.UTC(2026, 4, 12, 9, 0, 0));
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card,
      now: fixedNow,
      listDispatches: asListFn(
        vi
          .fn()
          .mockResolvedValue([
            mkDispatch({ id: "d-3" }),
            mkDispatch({ id: "d-2" }),
            mkDispatch({ id: "d-1" }),
          ]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });

    expect(result.escalated).toBe(true);
    expect(result.failureCount).toBe(3);
    expect(writeIssueFn).toHaveBeenCalledTimes(1);
    const [, written] = writeIssueFn.mock.calls[0];
    expect(written.status).toBe("Blocked");
    expect(written.blocked.reason).toContain("3 consecutive failed");
    expect(written.blocked.timestamp).toBe(fixedNow.toISOString());
    expect(written.comments).toHaveLength(1);
    expect(written.comments[0].author).toBe("danxbot");
    expect(written.comments[0].text).toContain("Stuck-card recovery");
    expect(written.comments[0].text).toContain("DX-221");
  });

  it("fires recordSystemError on successful escalation", async () => {
    await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card: mkIssue(),
      listDispatches: asListFn(
        vi
          .fn()
          .mockResolvedValue([mkDispatch({}), mkDispatch({}), mkDispatch({})]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });

    expect(recordSystemErrorFn).toHaveBeenCalledTimes(1);
    const opts = recordSystemErrorFn.mock.calls[0][0];
    expect(opts.source).toBe("stuck-card");
    expect(opts.severity).toBe("error");
    expect(opts.repo).toBe("danxbot");
    expect(opts.message).toContain("DX-221");
    expect(opts.details.failureCount).toBe(3);
    expect(opts.details.threshold).toBe(3);
  });

  it("is idempotent — skip when card is already Blocked", async () => {
    const card = mkIssue({
      status: "Blocked",
      blocked: { reason: "prior", timestamp: "2026-05-12T08:00:00Z" },
    });
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card,
      listDispatches: asListFn(
        vi
          .fn()
          .mockResolvedValue([mkDispatch({}), mkDispatch({}), mkDispatch({})]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });

    expect(result.escalated).toBe(false);
    expect(result.skipReason).toBe("already-blocked");
    expect(writeIssueFn).not.toHaveBeenCalled();
    expect(recordSystemErrorFn).not.toHaveBeenCalled();
  });

  it("respects threshold override (system-test path)", async () => {
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card: mkIssue(),
      threshold: 2,
      listDispatches: asListFn(
        vi.fn().mockResolvedValue([mkDispatch({}), mkDispatch({})]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });

    expect(result.escalated).toBe(true);
    expect(result.failureCount).toBe(2);
  });

  it("trailing completed resets the counter — no escalation", async () => {
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card: mkIssue(),
      listDispatches: asListFn(
        vi.fn().mockResolvedValue([
          mkDispatch({ status: "failed" }),
          mkDispatch({ status: "failed" }),
          mkDispatch({ status: "completed" }),
          mkDispatch({ status: "failed" }),
          mkDispatch({ status: "failed" }),
          mkDispatch({ status: "failed" }),
        ]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });
    expect(result.failureCount).toBe(2);
    expect(result.escalated).toBe(false);
  });

  it("falls open on listDispatches throw — no escalation, no write", async () => {
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card: mkIssue(),
      listDispatches: asListFn(
        vi.fn().mockRejectedValue(new Error("db down")),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });
    expect(result.escalated).toBe(false);
    expect(result.failureCount).toBe(0);
    expect(writeIssueFn).not.toHaveBeenCalled();
    expect(recordSystemErrorFn).not.toHaveBeenCalled();
  });

  it("does NOT record system error when writeIssue fails", async () => {
    writeIssueFn.mockRejectedValue(new Error("disk full"));
    const result = await escalateOnRepeatedFailures({
      repoName: "danxbot",
      repoLocalPath: "/tmp/x",
      internalIssueId: "DX-221",
      card: mkIssue(),
      listDispatches: asListFn(
        vi
          .fn()
          .mockResolvedValue([mkDispatch({}), mkDispatch({}), mkDispatch({})]),
      ),
      writeIssueFn: asWriteFn(writeIssueFn),
      recordSystemErrorFn: asRecordFn(recordSystemErrorFn),
    });
    expect(result.escalated).toBe(false);
    expect(recordSystemErrorFn).not.toHaveBeenCalled();
  });
});
