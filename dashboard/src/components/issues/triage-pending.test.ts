import { describe, it, expect } from "vitest";
import { markPending, clearIfTriaged } from "./triage-pending";
import type { Issue, IssueTriage, IssueTriageHistoryEntry } from "../../types";

function makeEntry(over: Partial<IssueTriageHistoryEntry> = {}): IssueTriageHistoryEntry {
  return {
    timestamp: "2026-05-14T12:00:00Z",
    status: "Keep",
    explain: "",
    expires_at: "2026-05-15T12:00:00Z",
    ice: { total: 60, i: 5, c: 4, e: 3 },
    ...over,
  };
}

function makeTriage(history: IssueTriageHistoryEntry[]): IssueTriage {
  const last = history[history.length - 1];
  return {
    expires_at: last?.expires_at ?? "",
    reassess_hint: "",
    last_status: last?.status ?? "",
    last_explain: last?.explain ?? "",
    ice: last?.ice ?? { total: 0, i: 0, c: 0, e: 0 },
    history,
  };
}

function makeIssue(id: string, history: IssueTriageHistoryEntry[]): Pick<Issue, "id" | "triage"> {
  return { id, triage: makeTriage(history) };
}

describe("triage-pending — markPending", () => {
  it("returns a new Map carrying the new entry without mutating the input", () => {
    const before = new Map<string, number>([["DX-1", 100]]);
    const after = markPending(before, "DX-2", 200);
    expect(after).not.toBe(before);
    expect(before.get("DX-2")).toBeUndefined();
    expect(after.get("DX-1")).toBe(100);
    expect(after.get("DX-2")).toBe(200);
  });

  it("overwrites an existing entry with the new timestamp", () => {
    const before = new Map<string, number>([["DX-1", 100]]);
    const after = markPending(before, "DX-1", 999);
    expect(after.get("DX-1")).toBe(999);
  });
});

describe("triage-pending — clearIfTriaged", () => {
  const PENDING_AT = Date.parse("2026-05-14T12:30:00Z");

  it("clears the entry when the NEWEST history entry's timestamp is >= pendingAt (regression: history is append-only — must read history[length-1], not history[0])", () => {
    const issue = makeIssue("DX-1", [
      // Older entry (timestamp BEFORE pendingAt) is at index 0 (append-only).
      makeEntry({ timestamp: "2026-05-14T10:00:00Z", status: "Keep" }),
      // Newer entry the agent just appended.
      makeEntry({ timestamp: "2026-05-14T12:35:00Z", status: "Approve" }),
    ]);
    const before = new Map<string, number>([["DX-1", PENDING_AT]]);
    const after = clearIfTriaged(before, issue);
    expect(after.has("DX-1")).toBe(false);
  });

  it("keeps the entry when the newest history entry predates pendingAt (regression: prior code read history[0] which never satisfies)", () => {
    const issue = makeIssue("DX-1", [
      makeEntry({ timestamp: "2026-05-14T10:00:00Z", status: "Keep" }),
      makeEntry({ timestamp: "2026-05-14T11:00:00Z", status: "Approve" }),
    ]);
    const before = new Map<string, number>([["DX-1", PENDING_AT]]);
    const after = clearIfTriaged(before, issue);
    expect(after.get("DX-1")).toBe(PENDING_AT);
  });

  it("returns the same map reference when the issue id is not pending (no-op)", () => {
    const before = new Map<string, number>([["DX-1", PENDING_AT]]);
    const after = clearIfTriaged(before, makeIssue("DX-2", [makeEntry()]));
    expect(after).toBe(before);
  });

  it("keeps the entry when triage.history is empty (no decision yet — wait for the first append)", () => {
    const before = new Map<string, number>([["DX-1", PENDING_AT]]);
    const after = clearIfTriaged(before, makeIssue("DX-1", []));
    expect(after.get("DX-1")).toBe(PENDING_AT);
  });

  it("keeps the entry when the newest history timestamp fails to parse", () => {
    const issue = makeIssue("DX-1", [makeEntry({ timestamp: "not-a-date" })]);
    const before = new Map<string, number>([["DX-1", PENDING_AT]]);
    const after = clearIfTriaged(before, issue);
    expect(after.get("DX-1")).toBe(PENDING_AT);
  });

  it("does NOT clear unrelated SSE updates (rename, AC checkoff) — predicate gates strictly on history timestamp", () => {
    // Same history as before (newest is older than pendingAt) — simulates a
    // rename / AC checkoff event that arrives via the same SSE topic but
    // doesn't carry a new triage decision.
    const issue = makeIssue("DX-1", [makeEntry({ timestamp: "2026-05-14T11:00:00Z" })]);
    const before = new Map<string, number>([["DX-1", PENDING_AT]]);
    const after = clearIfTriaged(before, issue);
    expect(after.get("DX-1")).toBe(PENDING_AT);
  });
});
