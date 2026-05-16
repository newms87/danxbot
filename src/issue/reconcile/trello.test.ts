/**
 * Unit tests for `pushTrelloDiff` — reconcile step 7 outbound tracker
 * push (DX-218 / Phase 3 of the Event-Driven Worker epic, DX-215).
 *
 * `syncIssue` and `enqueueRetry` are mocked at the module level so the
 * tests focus on the orchestrator-specific contracts: the per-card
 * serial queue, the persist-after-push branch, the retry-enqueue-on-
 * tracker-error branch, and the visible push-slot helpers used by
 * reconcile callers.
 *
 * Test inventory matches the DX-218 acceptance:
 *
 *   1. Orphan branch — empty `external_id` → `syncIssue` creates the
 *      card; result reports `pushed=true` + `remoteWriteCount=1`.
 *   2. Diff branch — non-empty `external_id` → `syncIssue` runs the
 *      field-level diff; result reflects whatever `remoteWriteCount` it
 *      reports (0, 1, many).
 *   3. Persist branch — when `syncIssue` returns a structurally-
 *      different `updatedLocal` (orphan-recovered external_id, AC
 *      check_item_id stamps), the YAML on disk is rewritten.
 *   4. Tracker error → `enqueueRetry` fires, result.errors records the
 *      message, `retryEnqueued: true`, no throw to the caller.
 *   5. Per-card serial queue — concurrent calls for the SAME card
 *      execute serially (FIFO); concurrent calls for DIFFERENT cards
 *      execute in parallel.
 *   6. Slot cleanup — after a push settles AND it is still the tail,
 *      `_hasPushSlot` returns false (the entry was deleted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _hasPushSlot,
  _resetPushSlots,
  pushTrelloDiff,
} from "./trello.js";
import { ensureIssuesDirs, issuePath } from "../../issue-tracker/paths.js";
import { serializeIssue } from "../../issue-tracker/yaml.js";
import { writeFileSync } from "node:fs";
import type { Issue, IssueTracker } from "../../issue-tracker/interface.js";

vi.mock("../../issue-tracker/sync.js", async (importOriginal) => {
  // Keep `loadActionItemTitles` real so the orchestrator's pre-call
  // resolution against per-test tmpdirs continues working — only the
  // outbound `syncIssue` is stubbed.
  const actual =
    await importOriginal<typeof import("../../issue-tracker/sync.js")>();
  return {
    ...actual,
    syncIssue: vi.fn(),
  };
});

vi.mock("../../issue-tracker/retry-queue.js", () => ({
  enqueueRetry: vi.fn(),
}));

import { syncIssue } from "../../issue-tracker/sync.js";
import * as syncModule from "../../issue-tracker/sync.js";
import { enqueueRetry } from "../../issue-tracker/retry-queue.js";
import * as persistModule from "./trello-persist.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 10,
    tracker: "trello",
    id: "DX-1",
    external_id: "ext-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "In Progress",
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

  return merged;
}

function writeOpenIssueToDisk(repoLocalPath: string, issue: Issue): string {
  ensureIssuesDirs(repoLocalPath);
  const path = issuePath(repoLocalPath, issue.id, "open");
  writeFileSync(path, serializeIssue(issue));
  return path;
}

const tracker = {} as IssueTracker;

describe("pushTrelloDiff — orchestrator (DX-218)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-trello-push-"));
    _resetPushSlots();
    vi.mocked(syncIssue).mockReset();
    vi.mocked(enqueueRetry).mockReset();
  });

  afterEach(() => {
    _resetPushSlots();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("orphan branch — external_id empty", () => {
    it("invokes syncIssue (which creates the card) and reports pushed=true with remoteWriteCount=1", async () => {
      const issue = makeIssue({ id: "DX-100", external_id: "" });
      writeOpenIssueToDisk(tmpDir, issue);
      // syncIssue's orphan branch stamps an external_id and returns
      // remoteWriteCount=1 — reproduce that here.
      const stamped = makeIssue({ id: "DX-100", external_id: "ext-stamped" });
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: stamped,
        remoteWriteCount: 1,
      });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(syncIssue).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        pushed: true,
        remoteWriteCount: 1,
        retryEnqueued: false,
        errors: [],
      });
      expect(result.updatedLocal?.external_id).toBe("ext-stamped");
    });

    it("persists the orphan-recovered external_id back to the YAML on disk", async () => {
      const issue = makeIssue({ id: "DX-101", external_id: "" });
      const onDiskPath = writeOpenIssueToDisk(tmpDir, issue);
      const stamped = makeIssue({ id: "DX-101", external_id: "ext-stamped" });
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: stamped,
        remoteWriteCount: 1,
      });

      await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      const written = readFileSync(onDiskPath, "utf-8");
      expect(written).toContain("external_id: ext-stamped");
    });
  });

  describe("diff branch — external_id set", () => {
    it("invokes syncIssue and reports remoteWriteCount=0 when nothing changed (no-op diff)", async () => {
      const issue = makeIssue({ id: "DX-200" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(syncIssue).toHaveBeenCalledTimes(1);
      expect(result.pushed).toBe(false);
      expect(result.remoteWriteCount).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("reports pushed=true when syncIssue issued at least one tracker mutation", async () => {
      const issue = makeIssue({ id: "DX-201" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 3,
      });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(result.pushed).toBe(true);
      expect(result.remoteWriteCount).toBe(3);
    });
  });

  describe("retry enqueue branch", () => {
    it("transient tracker error → enqueueRetry called + retryEnqueued=true + errors populated, no rethrow to caller", async () => {
      const issue = makeIssue({ id: "DX-300" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 503"));

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(enqueueRetry).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueRetry).mock.calls[0]![0]).toMatchObject({
        issueId: "DX-300",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "DX",
        errMessage: "tracker 503",
      });
      expect(result.retryEnqueued).toBe(true);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ step: "syncIssue" });
      expect(result.errors[0]!.message).toContain("tracker 503");
      expect(result.pushed).toBe(false);
    });

    it("forwards `recordSystemError` + `now` test seams through to enqueueRetry when present", async () => {
      const issue = makeIssue({ id: "DX-301" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 502"));

      const recordSystemError = vi.fn();
      const now = () => 1700000000000;

      await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
        deps: { recordSystemError, now },
      });

      expect(vi.mocked(enqueueRetry).mock.calls[0]![0]).toMatchObject({
        recordSystemError,
        now,
      });
    });

    it("an enqueue throw is swallowed (best-effort) — caller still gets the error in `errors[]`", async () => {
      const issue = makeIssue({ id: "DX-302" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 503"));
      vi.mocked(enqueueRetry).mockImplementationOnce(() => {
        throw new Error("queue dir read-only");
      });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      // `retryEnqueued` only flips true on a clean enqueue.
      expect(result.retryEnqueued).toBe(false);
      // syncIssue error still recorded.
      expect(result.errors[0]).toMatchObject({ step: "syncIssue" });
      // No rethrow to caller — push body returned a result.
    });
  });

  describe("per-card serial queue", () => {
    it("two concurrent pushes for the SAME card run serially in FIFO order", async () => {
      const issue = makeIssue({ id: "DX-400" });
      writeOpenIssueToDisk(tmpDir, issue);
      const events: string[] = [];
      let resolveFirst: () => void;
      const firstStarted = new Promise<void>((r) => {
        resolveFirst = r;
      });
      let firstReleaseSignal: () => void;
      const firstHold = new Promise<void>((r) => {
        firstReleaseSignal = r;
      });

      vi.mocked(syncIssue)
        .mockImplementationOnce(async (_t, local) => {
          events.push("first-start");
          resolveFirst();
          await firstHold;
          events.push("first-end");
          return { updatedLocal: local, remoteWriteCount: 0 };
        })
        .mockImplementationOnce(async (_t, local) => {
          events.push("second-start");
          events.push("second-end");
          return { updatedLocal: local, remoteWriteCount: 0 };
        });

      const p1 = pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });
      // Schedule the second push BEFORE the first resolves.
      await firstStarted;
      const p2 = pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      // Confirm the second body has NOT started while the first is in
      // flight — proves serialization.
      expect(events).toEqual(["first-start"]);

      firstReleaseSignal!();
      await Promise.all([p1, p2]);

      expect(events).toEqual([
        "first-start",
        "first-end",
        "second-start",
        "second-end",
      ]);
    });

    it("concurrent pushes for DIFFERENT cards run in parallel (no cross-card serialization)", async () => {
      const a = makeIssue({ id: "DX-401" });
      const b = makeIssue({ id: "DX-402" });
      writeOpenIssueToDisk(tmpDir, a);
      writeOpenIssueToDisk(tmpDir, b);

      const events: string[] = [];
      let releaseA: () => void;
      const aHold = new Promise<void>((r) => {
        releaseA = r;
      });

      vi.mocked(syncIssue).mockImplementation(async (_t, local) => {
        if (local.id === "DX-401") {
          events.push("a-start");
          await aHold;
          events.push("a-end");
        } else {
          events.push("b-start");
          events.push("b-end");
        }
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      const pa = pushTrelloDiff({
        issue: a,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });
      const pb = pushTrelloDiff({
        issue: b,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      // Wait for both to log their start before unblocking A.
      await new Promise((r) => setImmediate(r));

      // B started + completed while A was held — proves parallelism.
      expect(events).toContain("a-start");
      expect(events).toContain("b-start");
      expect(events).toContain("b-end");
      expect(events).not.toContain("a-end");

      releaseA!();
      await Promise.all([pa, pb]);

      expect(events).toContain("a-end");
    });

    it("a rejected push body does not poison the slot — the next scheduled push still runs", async () => {
      const issue = makeIssue({ id: "DX-403" });
      writeOpenIssueToDisk(tmpDir, issue);

      vi.mocked(syncIssue)
        .mockRejectedValueOnce(new Error("tracker 503")) // first push fails internally — body still resolves.
        .mockResolvedValueOnce({ updatedLocal: issue, remoteWriteCount: 1 });

      const p1 = pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });
      const p2 = pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.retryEnqueued).toBe(true);
      expect(r2.pushed).toBe(true);
    });
  });

  describe("slot cleanup", () => {
    it("`_hasPushSlot` returns false after the push body settles", async () => {
      const issue = makeIssue({ id: "DX-500" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });
      // Microtask flush — cleanup callback runs after the body settles.
      await new Promise((r) => setImmediate(r));

      expect(_hasPushSlot("test-repo", "DX-500")).toBe(false);
    });

    it("`_hasPushSlot` returns true while a push body is in flight", async () => {
      const issue = makeIssue({ id: "DX-501" });
      writeOpenIssueToDisk(tmpDir, issue);

      let release: () => void;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      vi.mocked(syncIssue).mockImplementationOnce(async (_t, local) => {
        await hold;
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      const inflight = pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });
      // Yield once so the slot has been registered before we check.
      await new Promise((r) => setImmediate(r));

      expect(_hasPushSlot("test-repo", "DX-501")).toBe(true);

      release!();
      await inflight;
    });
  });

  describe("partial-failure error paths", () => {
    it("loadActionItemTitles throwing populates errors[step:'load-action-items'] and proceeds with syncIssue still firing", async () => {
      const issue = makeIssue({ id: "DX-600" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 1,
      });
      const spy = vi
        .spyOn(syncModule, "loadActionItemTitles")
        .mockImplementation(() => {
          throw new Error("titles read failed");
        });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(result.errors).toContainEqual(
        expect.objectContaining({
          step: "load-action-items",
          message: expect.stringContaining("titles read failed"),
        }),
      );
      // syncIssue STILL ran with undefined actionItemTitles — the orphan
      // error is non-fatal.
      expect(syncIssue).toHaveBeenCalledTimes(1);
      expect(result.pushed).toBe(true);
      spy.mockRestore();
    });

    it("persistIfDifferent throwing populates errors[step:'persist'] while pushed stays true", async () => {
      const issue = makeIssue({ id: "DX-601" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 2,
      });
      const spy = vi
        .spyOn(persistModule, "persistIfDifferent")
        .mockImplementation(() => {
          throw new Error("disk write failed");
        });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(result.pushed).toBe(true);
      expect(result.remoteWriteCount).toBe(2);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          step: "persist",
          message: expect.stringContaining("disk write failed"),
        }),
      );
      spy.mockRestore();
    });

    it("does NOT enqueue a retry when syncIssue succeeds (negative assertion locks the contract)", async () => {
      const issue = makeIssue({ id: "DX-602" });
      writeOpenIssueToDisk(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      const result = await pushTrelloDiff({
        issue,
        repoName: "test-repo",
        repoLocalPath: tmpDir,
        issuePrefix: "DX",
        tracker,
      });

      expect(enqueueRetry).not.toHaveBeenCalled();
      expect(result.retryEnqueued).toBe(false);
    });
  });
});

describe("pushTrelloDiff — DX-610 outbound list-mapping gate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-trello-push-gate-"));
    _resetPushSlots();
    vi.mocked(syncIssue).mockReset();
    vi.mocked(enqueueRetry).mockReset();
    const { _clearSystemErrors } = await import("../../dashboard/system-errors.js");
    _clearSystemErrors();
    const { ensureListsFile, _resetForTesting: resetLists } =
      await import("../../lists-file.js");
    resetLists();
    await ensureListsFile(tmpDir);
    const { _resetForTesting: resetMap } = await import("../../trello-list-map.js");
    resetMap();
  });

  afterEach(() => {
    _resetPushSlots();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips push + records warn when card's list_name is unmapped", async () => {
    const { readLists } = await import("../../lists-file.js");
    const firstList = readLists(tmpDir).lists[0];
    const issue = { ...makeIssue({ id: "DX-700" }), list_name: firstList.name };
    writeOpenIssueToDisk(tmpDir, issue);

    const result = await pushTrelloDiff({
      issue,
      repoName: "test-repo",
      repoLocalPath: tmpDir,
      issuePrefix: "DX",
      tracker,
    });

    expect(syncIssue).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      pushed: false,
      remoteWriteCount: 0,
      retryEnqueued: false,
      errors: [],
      updatedLocal: null,
    });
    const { listSystemErrors } = await import("../../dashboard/system-errors.js");
    const errors = listSystemErrors({ repo: "test-repo" });
    expect(errors.length).toBe(1);
    expect(errors[0].source).toBe("trello-list-mapping");
    expect(errors[0].severity).toBe("warn");
    expect(errors[0].message).toContain("DX-700");
  });

  it("skips push + records warn when card's list_name no longer matches any configured list", async () => {
    const issue = { ...makeIssue({ id: "DX-701" }), list_name: "Ghost List" };
    writeOpenIssueToDisk(tmpDir, issue);

    const result = await pushTrelloDiff({
      issue,
      repoName: "test-repo",
      repoLocalPath: tmpDir,
      issuePrefix: "DX",
      tracker,
    });

    expect(syncIssue).not.toHaveBeenCalled();
    expect(result.pushed).toBe(false);
    const { listSystemErrors } = await import("../../dashboard/system-errors.js");
    const errors = listSystemErrors({ repo: "test-repo" });
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('Ghost List');
  });

  it("pushes normally when the mapping resolves to a Trello list id", async () => {
    const { readLists } = await import("../../lists-file.js");
    const firstList = readLists(tmpDir).lists[0];
    const { writeTrelloListMap } = await import("../../trello-list-map.js");
    await writeTrelloListMap(
      tmpDir,
      { list_id_to_trello_list_id: { [firstList.id]: "trello-mapped" } },
      new Set(readLists(tmpDir).lists.map((l) => l.id)),
    );

    const issue = { ...makeIssue({ id: "DX-702" }), list_name: firstList.name };
    writeOpenIssueToDisk(tmpDir, issue);
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: issue,
      remoteWriteCount: 0,
    });

    const result = await pushTrelloDiff({
      issue,
      repoName: "test-repo",
      repoLocalPath: tmpDir,
      issuePrefix: "DX",
      tracker,
    });

    expect(syncIssue).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    const { listSystemErrors } = await import("../../dashboard/system-errors.js");
    expect(listSystemErrors({ repo: "test-repo" })).toEqual([]);
  });

  it("does not gate when list_name is null (legacy fallback path)", async () => {
    const issue = makeIssue({ id: "DX-703", list_name: null });
    writeOpenIssueToDisk(tmpDir, issue);
    vi.mocked(syncIssue).mockResolvedValue({
      updatedLocal: issue,
      remoteWriteCount: 0,
    });

    const result = await pushTrelloDiff({
      issue,
      repoName: "test-repo",
      repoLocalPath: tmpDir,
      issuePrefix: "DX",
      tracker,
    });

    expect(syncIssue).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
  });
});
