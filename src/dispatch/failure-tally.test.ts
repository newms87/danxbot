/**
 * Unit tests for {@link countTrailingFailures} +
 * {@link buildEscalationText}.
 *
 * These pure helpers underpin DX-221 AC #1 — the per-card
 * consecutive-failure tally that replaces the deleted per-poller
 * failure counter from the legacy poller-tick state.
 */

import { describe, it, expect } from "vitest";
import {
  buildEscalationText,
  countTrailingFailures,
  DEFAULT_FAILURE_THRESHOLD,
} from "./failure-tally.js";
import type { Dispatch } from "../dashboard/dispatches.js";

function row(status: Dispatch["status"]): Pick<Dispatch, "status"> {
  return { status };
}

describe("countTrailingFailures", () => {
  it("returns 0 on an empty list", () => {
    expect(countTrailingFailures([])).toBe(0);
  });

  it("returns 0 when newest is completed", () => {
    expect(countTrailingFailures([row("completed"), row("failed")])).toBe(0);
  });

  it("counts a trailing run of failed statuses", () => {
    expect(
      countTrailingFailures([row("failed"), row("failed"), row("failed")]),
    ).toBe(3);
  });

  it("stops at the first completed (the run resets on success)", () => {
    expect(
      countTrailingFailures([
        row("failed"),
        row("failed"),
        row("completed"),
        row("failed"),
        row("failed"),
        row("failed"),
      ]),
    ).toBe(2);
  });

  it("skips cancelled / recovered rows without affecting the run", () => {
    expect(
      countTrailingFailures([
        row("failed"),
        row("cancelled"),
        row("failed"),
        row("recovered"),
        row("failed"),
      ]),
    ).toBe(3);
  });

  it("skips running / queued rows without affecting the run", () => {
    expect(
      countTrailingFailures([
        row("running"),
        row("failed"),
        row("failed"),
        row("queued"),
        row("failed"),
      ]),
    ).toBe(3);
  });

  it("a single completed resets to 0", () => {
    expect(
      countTrailingFailures([row("completed"), row("failed"), row("failed")]),
    ).toBe(0);
  });

  it("treats an all-cancelled history as zero failures", () => {
    expect(
      countTrailingFailures([row("cancelled"), row("cancelled")]),
    ).toBe(0);
  });
});

describe("DEFAULT_FAILURE_THRESHOLD", () => {
  it("is 3", () => {
    // Pinned because the system test fixture and the escalation
    // copy both rely on the literal — adjust here AND in
    // `Stuck-card recovery` docs when changing.
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
  });
});

describe("buildEscalationText", () => {
  function makeDispatch(
    overrides: Partial<
      Pick<Dispatch, "id" | "completedAt" | "summary" | "error">
    >,
  ): Pick<Dispatch, "id" | "completedAt" | "summary" | "error"> {
    return {
      id: "dispatch-1",
      completedAt: Date.UTC(2026, 4, 12, 8, 0, 0),
      summary: null,
      error: null,
      ...overrides,
    };
  }

  it("renders a Blocked reason citing the failure count", () => {
    const { blockedReason } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 3,
      recentFailures: [makeDispatch({})],
    });
    expect(blockedReason).toContain("3 consecutive failed dispatches");
    expect(blockedReason).toContain("operator investigation required");
  });

  it("renders a multi-line numbered failure list newest-first", () => {
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 3,
      recentFailures: [
        makeDispatch({ id: "d-newest", summary: "fail A" }),
        makeDispatch({ id: "d-middle", summary: "fail B" }),
        makeDispatch({ id: "d-oldest", summary: "fail C" }),
      ],
    });
    expect(commentText).toContain("1. `d-newest`");
    expect(commentText).toContain("2. `d-middle`");
    expect(commentText).toContain("3. `d-oldest`");
    expect(commentText).toContain("fail A");
    expect(commentText).toContain("fail B");
    expect(commentText).toContain("fail C");
  });

  it("uses error when summary is empty", () => {
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 1,
      recentFailures: [
        makeDispatch({ id: "d", summary: null, error: "claude-auth missing" }),
      ],
    });
    expect(commentText).toContain("claude-auth missing");
  });

  it("falls back to (no summary) when both summary and error are empty", () => {
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 1,
      recentFailures: [
        makeDispatch({ id: "d", summary: null, error: null }),
      ],
    });
    expect(commentText).toContain("(no summary)");
  });

  it("clips multi-line summaries to the first line", () => {
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 1,
      recentFailures: [
        makeDispatch({ id: "d", summary: "line 1\nline 2\nline 3" }),
      ],
    });
    expect(commentText).toContain("line 1");
    expect(commentText).not.toContain("line 2");
  });

  it("truncates a long summary to 200 chars", () => {
    const longSummary = "x".repeat(500);
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 1,
      recentFailures: [makeDispatch({ id: "d", summary: longSummary })],
    });
    // 200 x-chars present, 201st is not
    expect(commentText).toContain("x".repeat(200));
    expect(commentText).not.toContain("x".repeat(201));
  });

  it("renders (unknown) when completedAt is missing", () => {
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 1,
      recentFailures: [
        makeDispatch({ id: "d", completedAt: null, summary: "x" }),
      ],
    });
    expect(commentText).toContain("(unknown)");
  });

  it("includes the danxbot author tag for renderer-side filtering", () => {
    const { commentText } = buildEscalationText({
      cardId: "DX-221",
      cardTitle: "Phase 6",
      failureCount: 3,
      recentFailures: [makeDispatch({})],
    });
    expect(commentText.startsWith("<!-- danxbot -->")).toBe(true);
  });
});
