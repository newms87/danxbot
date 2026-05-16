/**
 * Unit tests for the small pure helpers in `issue-route.ts` that gate
 * dispatch-end behavior (ISS-92, Phase 2 of the poller-triage rework).
 *
 * Post-DX-157, `runSync` runs only from `syncTrackedIssueOnComplete`
 * (the post-completion auto-sync). This module covers the focused
 * contract that distinguishes mid-session saves (dispatch survives)
 * from terminal saves (dispatch clears), plus `runSync`'s local-first
 * ordering invariant (DX-131).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../issue-tracker/sync.js", () => ({
  syncIssue: vi.fn(),
  // Real implementation is fine — it's a thin local-FS reader that
  // returns an empty Map for tests where action_item_ids is empty.
  loadActionItemTitles: () => new Map<string, string>(),
}));

vi.mock("../issue-tracker/retry-queue.js", () => ({
  enqueueRetry: vi.fn(),
}));

import { syncIssue } from "../issue-tracker/sync.js";
import { enqueueRetry } from "../issue-tracker/retry-queue.js";
import { isDispatchSessionTerminal, runSync } from "./issue-route.js";
import { ensureIssuesDirs, issuePath } from "../poller/yaml-lifecycle.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 10,
    tracker: "memory",
    id: "ISS-1",
    external_id: "ext-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Test",
    description: "",
    priority: 3.0,
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
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      at: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

describe("isDispatchSessionTerminal", () => {
  it("returns true for Done", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Done" }))).toBe(true);
  });

  it("returns true for Cancelled", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Cancelled" }))).toBe(
      true,
    );
  });

  it("returns true for Blocked", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Blocked" }))).toBe(
      true,
    );
  });

  it("returns true when requires_human is non-null on a non-terminal status (DX-231)", () => {
    // DX-231 retired the `Needs Approval` parking status; the orthogonal
    // `requires_human` field is now the trigger for the agent-set
    // "human is the next actor" handoff. The dispatch slot must be
    // released regardless of the card's `status`.
    expect(
      isDispatchSessionTerminal(
        makeIssue({
          status: "ToDo",
          requires_human: {
            reason: "Need an architectural review",
            steps: ["Review approach with a senior eng"],
            set_by: "agent",
            set_at: "2026-05-10T12:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true for In Progress + requires_human != null (mid-session agent-set handoff)", () => {
    // The source comment in `issue-route.ts` explicitly names this
    // case: an agent saving mid-session with `requires_human != null`
    // and `status: In Progress` is exiting the dispatch and handing
    // off to the human. Test pins the slot-release contract.
    expect(
      isDispatchSessionTerminal(
        makeIssue({
          status: "In Progress",
          requires_human: {
            reason: "Need 3rd-party API key rotation",
            steps: ["Rotate the secret"],
            set_by: "agent",
            set_at: "2026-05-10T12:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true for Review + requires_human != null", () => {
    // Orthogonal to status; same rationale as the In Progress case.
    expect(
      isDispatchSessionTerminal(
        makeIssue({
          status: "Review",
          requires_human: {
            reason: "Direction sign-off needed",
            steps: ["Decide between options A and B"],
            set_by: "agent",
            set_at: "2026-05-10T12:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true when blocked is non-null even on a non-terminal status", () => {
    expect(
      isDispatchSessionTerminal(
        makeIssue({
          status: "ToDo",
          waiting_on: {
            reason: "Waits on ISS-99",
            timestamp: "2026-05-07T12:00:00Z",
            by: ["ISS-99"],
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns false for mid-session ToDo (no waiting_on)", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "ToDo" }))).toBe(
      false,
    );
  });

  it("returns false for In Progress (mid-session save)", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "In Progress" }))).toBe(
      false,
    );
  });

  it("returns false for Review", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Review" }))).toBe(
      false,
    );
  });
});

/**
 * `runSync` local-first ordering (DX-131 / Phase 1 of the Trello-decouple
 * epic). The handler must persist the agent's edit to disk BEFORE pushing
 * to the tracker, so a tracker outage never leaves a terminal-status YAML
 * stranded in `open/`. These tests drive the function directly with a
 * mocked `syncIssue` and assert the on-disk lifecycle for each branch:
 *
 *   1. Tracker throw + Done → local file lands in `closed/`; `open/`
 *      absent; `recordError` invoked.
 *   2. Tracker success → second persist applies the merged tracker
 *      fields (`external_id`, `check_item_id[]`).
 *   3. Tracker throw + ToDo → local file lands in `open/`; `closed/`
 *      absent; `recordError` invoked.
 *   4. Tracker success with no remote mutations → idempotent (final
 *      file content is correct).
 *
 * Tests 1 and 3 collectively pin "persist BEFORE push": they fail unless
 * the local write executes prior to (and independent of) the tracker
 * call, since the tracker mock throws before the legacy code's
 * post-success persist could run.
 */
describe("runSync (local-first persist)", () => {
  let tmpDir: string;
  let repo: RepoContext;
  const tracker = {} as IssueTracker;

  beforeEach(() => {
    vi.mocked(syncIssue).mockReset();
    vi.mocked(enqueueRetry).mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-runsync-"));
    ensureIssuesDirs(tmpDir);
    repo = { localPath: tmpDir, issuePrefix: "ISS" } as RepoContext;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracker throw + Done status → terminal-status YAML lands in closed/, open/ absent, recordError invoked", async () => {
    vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 500"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-100",
      external_id: "ext-100",
      status: "Done",
    });

    await runSync({ tracker, recordError }, "dispatch-1", repo, issue);

    const closedPath = issuePath(tmpDir, "ISS-100", "closed");
    const openPath = issuePath(tmpDir, "ISS-100", "open");
    expect(existsSync(closedPath)).toBe(true);
    expect(existsSync(openPath)).toBe(false);
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), { expectedPrefix: "ISS" });
    expect(persisted.status).toBe("Done");
    expect(persisted.id).toBe("ISS-100");
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(
      "dispatch-1",
      expect.stringContaining("tracker 500"),
    );
  });

  it("tracker success → second persist writes merged tracker fields (external_id, check_item_id) onto the local YAML", async () => {
    const inputIssue = makeIssue({
      id: "ISS-101",
      external_id: "",
      status: "Done",
      ac: [
        { check_item_id: "", title: "AC 1", checked: true },
        { check_item_id: "", title: "AC 2", checked: true },
      ],
    });
    const trackerStamped: Issue = {
      ...inputIssue,
      external_id: "ext-new-from-tracker",
      ac: [
        { check_item_id: "ci-1", title: "AC 1", checked: true },
        { check_item_id: "ci-2", title: "AC 2", checked: true },
      ],
    };
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: trackerStamped,
      remoteWriteCount: 1,
    });
    const recordError = vi.fn();

    await runSync({ tracker, recordError }, "dispatch-2", repo, inputIssue);

    const closedPath = issuePath(tmpDir, "ISS-101", "closed");
    expect(existsSync(closedPath)).toBe(true);
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), { expectedPrefix: "ISS" });
    expect(persisted.external_id).toBe("ext-new-from-tracker");
    expect(persisted.ac.map((a) => a.check_item_id)).toEqual(["ci-1", "ci-2"]);
    expect(recordError).not.toHaveBeenCalled();
  });

  it("tracker throw + ToDo (non-terminal) → YAML lands in open/, closed/ absent, recordError invoked", async () => {
    vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 401"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-102",
      external_id: "ext-102",
      status: "ToDo",
    });

    await runSync({ tracker, recordError }, "dispatch-3", repo, issue);

    const openPath = issuePath(tmpDir, "ISS-102", "open");
    const closedPath = issuePath(tmpDir, "ISS-102", "closed");
    expect(existsSync(openPath)).toBe(true);
    expect(existsSync(closedPath)).toBe(false);
    const persisted = parseIssue(readFileSync(openPath, "utf-8"), { expectedPrefix: "ISS" });
    expect(persisted.status).toBe("ToDo");
    expect(persisted.external_id).toBe("ext-102");
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(
      "dispatch-3",
      expect.stringContaining("tracker 401"),
    );
  });

  it("tracker success with no remote mutations → second persist is idempotent (byte-identical re-runs)", async () => {
    const issue = makeIssue({
      id: "ISS-103",
      external_id: "ext-103",
      status: "Done",
      title: "Idempotent save",
    });
    // syncIssue returns the SAME issue (no orphan recovery, no
    // tracker-side id stamps, no inbound comments). The card's test plan
    // permits "no-op or same-content write" for the second persist — we
    // pin the stronger property: running runSync TWICE leaves the file
    // byte-identical, so any future regression that introduces drift
    // (e.g. a non-deterministic timestamp slipped into serializeIssue)
    // surfaces here.
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: issue,
      remoteWriteCount: 0,
    });
    const recordError = vi.fn();

    await runSync({ tracker, recordError }, "dispatch-4", repo, issue);

    const closedPath = issuePath(tmpDir, "ISS-103", "closed");
    expect(existsSync(closedPath)).toBe(true);
    const firstBytes = readFileSync(closedPath);
    const persisted = parseIssue(firstBytes.toString("utf-8"), { expectedPrefix: "ISS" });
    expect(persisted.id).toBe("ISS-103");
    expect(persisted.external_id).toBe("ext-103");
    expect(persisted.status).toBe("Done");
    expect(persisted.title).toBe("Idempotent save");

    // Second run, same input → bytes must match the first run exactly.
    await runSync({ tracker, recordError }, "dispatch-4-repeat", repo, issue);
    const secondBytes = readFileSync(closedPath);
    expect(secondBytes.equals(firstBytes)).toBe(true);

    expect(recordError).not.toHaveBeenCalled();
  });

  it("tracker throw + Cancelled status → terminal-status YAML lands in closed/, open/ absent", async () => {
    vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 503"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-104",
      external_id: "ext-104",
      status: "Cancelled",
    });

    await runSync({ tracker, recordError }, "dispatch-5", repo, issue);

    const closedPath = issuePath(tmpDir, "ISS-104", "closed");
    const openPath = issuePath(tmpDir, "ISS-104", "open");
    expect(existsSync(closedPath)).toBe(true);
    expect(existsSync(openPath)).toBe(false);
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), { expectedPrefix: "ISS" });
    expect(persisted.status).toBe("Cancelled");
    expect(recordError).toHaveBeenCalledTimes(1);
  });

  it("tracker throw + blocked record on ToDo → YAML lands in open/ (blocked is non-terminal for moveToClosedIfTerminal)", async () => {
    // `isDispatchSessionTerminal` returns true for blocked (which clears
    // `dispatch` on persist), but `moveToClosedIfTerminal` only fires on
    // status Done / Cancelled — so a blocked ToDo card stays in open/.
    // Pin both behaviours here so a future refactor of either branch
    // can't silently drift.
    vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 502"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-105",
      external_id: "ext-105",
      status: "ToDo",
      waiting_on: {
        reason: "Waits on ISS-99",
        timestamp: "2026-05-08T07:00:00Z",
        by: ["ISS-99"],
      },
      dispatch: {
        id: "stale-dispatch-id",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      },
    });

    await runSync({ tracker, recordError }, "dispatch-6", repo, issue);

    const openPath = issuePath(tmpDir, "ISS-105", "open");
    const closedPath = issuePath(tmpDir, "ISS-105", "closed");
    expect(existsSync(openPath)).toBe(true);
    expect(existsSync(closedPath)).toBe(false);
    const persisted = parseIssue(readFileSync(openPath, "utf-8"), { expectedPrefix: "ISS" });
    expect(persisted.status).toBe("ToDo");
    // dispatch + assigned_agent are preserved across every save; the
    // clear-on-terminal behavior was retired so the audit record of
    // who ran the last session survives.
    expect(persisted.dispatch).not.toBeNull();
    expect(persisted.waiting_on).not.toBeNull();
    expect(recordError).toHaveBeenCalledTimes(1);
  });

  it("tracker throw → DX-132 retry queue enqueueRetry is called with issue id + repoLocalPath + tracker errMessage", async () => {
    // DX-132 Phase 2: the runSync catch branch fires enqueueRetry
    // alongside recordError. The poller's drainRetries picks the entry
    // up on a subsequent tick and replays the failed tracker push.
    vi.mocked(syncIssue).mockRejectedValue(new Error("Trello 500"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-110",
      external_id: "ext-110",
      status: "Done",
    });

    await runSync({ tracker, recordError }, "dispatch-7", repo, issue);

    expect(enqueueRetry).toHaveBeenCalledTimes(1);
    expect(enqueueRetry).toHaveBeenCalledWith({
      issueId: "ISS-110",
      repoLocalPath: tmpDir,
      errMessage: "Trello 500",
    });
    // Local YAML still landed in closed/ (Phase 1 contract: persist
    // before push). Queue entry is purely additive.
    expect(existsSync(issuePath(tmpDir, "ISS-110", "closed"))).toBe(true);
    // Original tracker error reached recordError.
    expect(recordError).toHaveBeenCalledWith(
      "dispatch-7",
      expect.stringContaining("Trello 500"),
    );
  });

  it("enqueueRetry filesystem failure does NOT shadow the original tracker error", async () => {
    // DX-132 SHOULD ADD #8: a filesystem failure in the retry-queue
    // enqueue path (e.g. EROFS, disk full) must not mask the original
    // tracker error in the dispatch row. The catch around enqueueRetry
    // in runSync swallows the enqueue throw with a log.warn and the
    // original tracker error is the one persisted via recordError.
    vi.mocked(syncIssue).mockRejectedValue(new Error("Trello 500"));
    vi.mocked(enqueueRetry).mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-111",
      external_id: "ext-111",
      status: "ToDo",
    });

    await expect(
      runSync({ tracker, recordError }, "dispatch-8", repo, issue),
    ).resolves.toBeUndefined();

    // recordError got the ORIGINAL tracker error — not the EROFS.
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(
      "dispatch-8",
      expect.stringContaining("Trello 500"),
    );
    expect(recordError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("EROFS"),
    );
    // Local YAML still landed in open/ (Phase 1 contract preserved).
    expect(existsSync(issuePath(tmpDir, "ISS-111", "open"))).toBe(true);
  });
});

// `persistAfterSync` MUST preserve `dispatch` AND `assigned_agent` on
// every save (terminal or mid-session) — both fields are durable audit
// of which agent / dispatch session did the work. The previous DX-286
// "clear on terminal" behavior destroyed that audit on every Done /
// Cancelled / Blocked save, leaving closed cards with no record of the
// owning agent. The picker's claim map already filters out
// Done/Cancelled rows (`assignedCards()`), so a persistent
// `assigned_agent` on a closed card cannot cause a stuck claim.
describe("persistAfterSync — preserves dispatch + assigned_agent forever", () => {
  let tmpDir: string;
  let repo: RepoContext;
  const tracker = {} as IssueTracker;

  beforeEach(() => {
    vi.mocked(syncIssue).mockReset();
    vi.mocked(enqueueRetry).mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-persistsync-"));
    ensureIssuesDirs(tmpDir);
    repo = { localPath: tmpDir, issuePrefix: "ISS" } as RepoContext;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Issue carries BOTH dispatch + assigned_agent at terminal save;
  // both fields must survive the persist so the closed/ YAML records
  // who did the work.
  it("Done save preserves BOTH dispatch and assigned_agent", async () => {
    vi.mocked(syncIssue).mockRejectedValue(new Error("tracker offline"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-200",
      external_id: "ext-200",
      status: "Done",
      assigned_agent: "phil",
      dispatch: {
        id: "did-200",
        pid: 4242,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });

    await runSync({ tracker, recordError }, "dispatch-200", repo, issue);

    const closedPath = issuePath(tmpDir, "ISS-200", "closed");
    expect(existsSync(closedPath)).toBe(true);
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), {
      expectedPrefix: "ISS",
    });
    expect(persisted.status).toBe("Done");
    expect(persisted.dispatch).not.toBeNull();
    expect(persisted.dispatch!.id).toBe("did-200");
    expect(persisted.assigned_agent).toBe("phil");
  });

  // Cancelled is the other open→closed terminal status; same preservation.
  it("Cancelled save preserves BOTH dispatch and assigned_agent", async () => {
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: makeIssue({
        id: "ISS-201",
        external_id: "ext-201",
        status: "Cancelled",
        assigned_agent: "murphy",
        dispatch: {
          id: "did-201",
          pid: 5555,
          host: "host-a",
          kind: "work",
          started_at: "2026-05-11T07:00:00Z",
          ttl_seconds: 7200,
        },
      }),
      remoteWriteCount: 0,
    });
    const recordError = vi.fn();

    await runSync(
      { tracker, recordError },
      "dispatch-201",
      repo,
      makeIssue({
        id: "ISS-201",
        external_id: "ext-201",
        status: "Cancelled",
        assigned_agent: "murphy",
        dispatch: {
          id: "did-201",
          pid: 5555,
          host: "host-a",
          kind: "work",
          started_at: "2026-05-11T07:00:00Z",
          ttl_seconds: 7200,
        },
      }),
    );

    const closedPath = issuePath(tmpDir, "ISS-201", "closed");
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), {
      expectedPrefix: "ISS",
    });
    expect(persisted.dispatch!.id).toBe("did-201");
    expect(persisted.assigned_agent).toBe("murphy");
  });

  // Blocked is a session-terminal status that STAYS in open/. The
  // dispatch slot and assigned_agent are preserved — durable audit
  // even when the session ended without reaching Done.
  it("Blocked save (stays in open/) preserves BOTH dispatch and assigned_agent", async () => {
    vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 502"));
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-202",
      external_id: "ext-202",
      status: "Blocked",
      assigned_agent: "dani",
      dispatch: {
        id: "did-202",
        pid: 6666,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });

    await runSync({ tracker, recordError }, "dispatch-202", repo, issue);

    const openPath = issuePath(tmpDir, "ISS-202", "open");
    expect(existsSync(openPath)).toBe(true);
    const persisted = parseIssue(readFileSync(openPath, "utf-8"), {
      expectedPrefix: "ISS",
    });
    expect(persisted.status).toBe("Blocked");
    expect(persisted.dispatch!.id).toBe("did-202");
    expect(persisted.assigned_agent).toBe("dani");
  });

  // Card with assigned_agent but no dispatch (the steady state when a
  // prior dispatch ended cleanly). assigned_agent must round-trip on
  // the terminal save — it is the persistent ownership record.
  it("Done save with assigned_agent only (no dispatch) preserves the agent", async () => {
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: makeIssue({
        id: "ISS-203",
        external_id: "ext-203",
        status: "Done",
        assigned_agent: "phil",
      }),
      remoteWriteCount: 0,
    });
    const recordError = vi.fn();

    await runSync(
      { tracker, recordError },
      "dispatch-203",
      repo,
      makeIssue({
        id: "ISS-203",
        external_id: "ext-203",
        status: "Done",
        assigned_agent: "phil",
      }),
    );

    const closedPath = issuePath(tmpDir, "ISS-203", "closed");
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), {
      expectedPrefix: "ISS",
    });
    expect(persisted.assigned_agent).toBe("phil");
    expect(persisted.dispatch).toBeNull();
  });

  // Negative — mid-session save (status: In Progress, no terminal
  // signals) preserves assigned_agent + dispatch. Same preservation
  // semantics across every status; this test pins that the behavior
  // doesn't depend on status.
  it("non-terminal mid-session save preserves dispatch AND assigned_agent", async () => {
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: makeIssue({
        id: "ISS-204",
        external_id: "ext-204",
        status: "In Progress",
        assigned_agent: "phil",
        dispatch: {
          id: "did-204",
          pid: 7777,
          host: "host-a",
          kind: "work",
          started_at: "2026-05-11T07:00:00Z",
          ttl_seconds: 7200,
        },
      }),
      remoteWriteCount: 0,
    });
    const recordError = vi.fn();

    await runSync(
      { tracker, recordError },
      "dispatch-204",
      repo,
      makeIssue({
        id: "ISS-204",
        external_id: "ext-204",
        status: "In Progress",
        assigned_agent: "phil",
        dispatch: {
          id: "did-204",
          pid: 7777,
          host: "host-a",
          kind: "work",
          started_at: "2026-05-11T07:00:00Z",
          ttl_seconds: 7200,
        },
      }),
    );

    const openPath = issuePath(tmpDir, "ISS-204", "open");
    expect(existsSync(openPath)).toBe(true);
    const persisted = parseIssue(readFileSync(openPath, "utf-8"), {
      expectedPrefix: "ISS",
    });
    expect(persisted.assigned_agent).toBe("phil");
    expect(persisted.dispatch).not.toBeNull();
    expect(persisted.dispatch?.pid).toBe(7777);
  });
});

/**
 * DX-342 — `runSync` skips the tracker push entirely when `deps.tracker
 * === null` (YAML-only mode). The local YAML persist still fires; the
 * `syncIssue` / `enqueueRetry` / `recordError` chain MUST NOT execute,
 * since none of them are meaningful without a tracker.
 */
describe("runSync — YAML-only mode (deps.tracker === null, DX-342)", () => {
  let tmpDir: string;
  let repo: RepoContext;

  beforeEach(() => {
    vi.mocked(syncIssue).mockReset();
    vi.mocked(enqueueRetry).mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-runsync-yaml-only-"));
    ensureIssuesDirs(tmpDir);
    repo = { localPath: tmpDir, issuePrefix: "ISS" } as RepoContext;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists the local YAML then short-circuits — no syncIssue, no enqueueRetry, no recordError", async () => {
    const recordError = vi.fn().mockResolvedValue(undefined);
    const recordSystemError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-9001",
      external_id: "",
      status: "Done",
    });

    await runSync(
      { tracker: null, recordError, recordSystemError },
      "dispatch-yaml-only",
      repo,
      issue,
    );

    // Local persist landed in closed/ (Done is terminal).
    const closedPath = issuePath(tmpDir, "ISS-9001", "closed");
    expect(existsSync(closedPath)).toBe(true);
    const persisted = parseIssue(readFileSync(closedPath, "utf-8"), {
      expectedPrefix: "ISS",
    });
    expect(persisted.status).toBe("Done");

    // Tracker push chain never fired.
    expect(syncIssue).not.toHaveBeenCalled();
    expect(enqueueRetry).not.toHaveBeenCalled();
    expect(recordError).not.toHaveBeenCalled();
    expect(recordSystemError).not.toHaveBeenCalled();
  });

  it("non-terminal status — YAML still lands in open/, still no tracker chain calls", async () => {
    const recordError = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssue({
      id: "ISS-9002",
      external_id: "",
      status: "ToDo",
    });

    await runSync(
      { tracker: null, recordError },
      "dispatch-yaml-only-2",
      repo,
      issue,
    );

    const openPath = issuePath(tmpDir, "ISS-9002", "open");
    expect(existsSync(openPath)).toBe(true);
    expect(syncIssue).not.toHaveBeenCalled();
    expect(enqueueRetry).not.toHaveBeenCalled();
    expect(recordError).not.toHaveBeenCalled();
  });
});
