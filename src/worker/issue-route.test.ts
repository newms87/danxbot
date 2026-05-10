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
    schema_version: 5,
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
    assigned_agent: null,
    waiting_on: null,
    history: [],
    ...overrides,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
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

  it("returns true for Needs Approval", () => {
    expect(
      isDispatchSessionTerminal(makeIssue({ status: "Needs Approval" })),
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
    // Blocked is treated as session-terminal → dispatch slot cleared.
    expect(persisted.dispatch).toBeNull();
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
