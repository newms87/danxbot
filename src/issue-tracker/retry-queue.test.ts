/**
 * Unit tests for the disk-backed Trello retry queue (DX-132 / Phase 2 of
 * the trello-decouple epic DX-130).
 *
 * Test isolation: each test creates a fresh `mkdtempSync` repo dir and
 * `rmSync`s it in `afterEach`. `syncIssue` is mocked at the module
 * level — the queue's contract is "call syncIssue, persist if differs,
 * unlink on success / rewrite on failure", so mocking the tracker layer
 * keeps these tests fast and deterministic without paying the
 * `FakeTracker`'s per-test setup cost.
 *
 * Test inventory matches the DX-132 test plan 1:1:
 *
 *   1. enqueue → JSON file under `<repo>/.danxbot/.trello-retry/`
 *   2. drain → FIFO order, calls syncIssue, unlinks on success
 *   3. drain → backoff (attempt 1 30s, attempt 2 2min) — entry rewritten,
 *      next drain inside backoff window is a no-op
 *   4. drain → MAX_ATTEMPTS exceeded → file deleted + recordSystemError
 *      fires
 *   5. drain → YAML missing on disk → queue entry unlinked, no tracker
 *      call
 *   6. drain → snapshot at start; concurrent enqueue mid-drain handled
 *      next tick (not double-processed this tick)
 *
 * Plus a few invariant tests that pin the smaller contracts called out in
 * the module docstring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("./sync.js", async (importOriginal) => {
  // Keep the real `loadActionItemTitles` so the wiring test that
  // exercises action_item_ids resolution can read linked YAMLs from
  // the per-test tmpdir; only `syncIssue` is stubbed.
  const actual = await importOriginal<typeof import("./sync.js")>();
  return {
    ...actual,
    syncIssue: vi.fn(),
  };
});

import { syncIssue } from "./sync.js";
import {
  _resetForTesting,
  _setRngForTesting,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMsForAttempt,
  bootRescheduleRetryQueue,
  drainRetries,
  enqueueRetry,
  MAX_ATTEMPTS,
  setRetryQueueSystemErrorHookForRepo,
  setRetryQueueTrackerForRepo,
  type RetryQueueEntry,
} from "./retry-queue.js";
import {
  _resetForTesting as resetCircuit,
  _setNowForTesting as setCircuitNow,
  recordFailure as circuitRecordFailure,
} from "./circuit-breaker.js";
import { ensureIssuesDirs, issuePath } from "../poller/yaml-lifecycle.js";
import { parseIssue, serializeIssue } from "./yaml.js";
import type { Issue, IssueTracker } from "./interface.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 7,
    tracker: "trello",
    id: "ISS-1",
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

function writeOpenIssue(repoLocalPath: string, issue: Issue): string {
  ensureIssuesDirs(repoLocalPath);
  const path = issuePath(repoLocalPath, issue.id, "open");
  writeFileSync(path, serializeIssue(issue));
  return path;
}

function listQueueFiles(repoLocalPath: string): string[] {
  const dir = resolve(repoLocalPath, ".danxbot", ".trello-retry");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

function readQueueEntry(
  repoLocalPath: string,
  filename: string,
): RetryQueueEntry {
  const dir = resolve(repoLocalPath, ".danxbot", ".trello-retry");
  return JSON.parse(readFileSync(resolve(dir, filename), "utf-8"));
}

const noopLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("backoffMsForAttempt (DX-300 exponential + jitter)", () => {
  // The base values: 120 * 2^(n-1) capped at 1800s. With jitter at the
  // un-jittered floor (rng → 0), each attempt produces the pure base.
  // Jitter ceiling (rng → 0.999) yields up to 10% over base.
  it("attempt 1 → 120s base (no jitter)", () => {
    expect(backoffMsForAttempt(1, () => 0)).toBe(120 * 1000);
  });
  it("attempt 2 → 240s base", () => {
    expect(backoffMsForAttempt(2, () => 0)).toBe(240 * 1000);
  });
  it("attempt 3 → 480s base", () => {
    expect(backoffMsForAttempt(3, () => 0)).toBe(480 * 1000);
  });
  it("attempt 4 → 960s base", () => {
    expect(backoffMsForAttempt(4, () => 0)).toBe(960 * 1000);
  });
  it("attempt 5 → 1800s (cap, would be 1920s)", () => {
    expect(backoffMsForAttempt(5, () => 0)).toBe(BACKOFF_CAP_MS);
  });
  it("attempt 24 → 1800s (still cap)", () => {
    expect(backoffMsForAttempt(24, () => 0)).toBe(BACKOFF_CAP_MS);
  });

  it("jitter ceiling: attempt 1 with rng → 0.999 stays under 132s", () => {
    // 120s base + 10% jitter ceiling = 132s. Strict floor → strict cap.
    const val = backoffMsForAttempt(1, () => 0.999);
    expect(val).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    expect(val).toBeLessThan(BACKOFF_BASE_MS * 1.1);
  });

  it("attempt 0 / negative → 0 (sanity, never called with these values in production)", () => {
    expect(backoffMsForAttempt(0, () => 0)).toBe(0);
    expect(backoffMsForAttempt(-1, () => 0)).toBe(0);
  });

  it("uses the module-level rng seam when no override is passed", () => {
    _setRngForTesting(() => 0);
    expect(backoffMsForAttempt(1)).toBe(BACKOFF_BASE_MS);
    _setRngForTesting(() => 0.5);
    const half = backoffMsForAttempt(1);
    expect(half).toBeGreaterThan(BACKOFF_BASE_MS);
    expect(half).toBeLessThanOrEqual(BACKOFF_BASE_MS * 1.05);
  });
});

describe("retry-queue", () => {
  let tmpDir: string;
  const tracker = {} as IssueTracker;

  beforeEach(() => {
    vi.mocked(syncIssue).mockReset();
    _resetForTesting();
    // Disable jitter for deterministic delay assertions across the file.
    _setRngForTesting(() => 0);
    // Reset the circuit breaker so a prior test's tripped breaker
    // doesn't leak into this one (the breaker is module-singleton).
    resetCircuit();
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-retry-queue-"));
    // Settings dir must exist before writeSettings (or any
    // `.danxbot/settings.json` write) — the queue dir helpers create
    // `.danxbot/.trello-retry/` lazily, but `writeSettings` expects
    // `.danxbot/` already.
    mkdirSync(join(tmpDir, ".danxbot"), { recursive: true });
  });

  afterEach(() => {
    // Cancel every armed timer + clear repo registries so a deferred
    // retry from one case doesn't leak into another (or fire after
    // `tmpDir` is rmSync'd and panic on a missing file).
    _resetForTesting();
    resetCircuit();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("enqueueRetry — Test 1", () => {
    it("writes a JSON file under <repo>/.danxbot/.trello-retry/ with attempt=1 and FIFO-friendly filename", () => {
      enqueueRetry({
        issueId: "ISS-100",
        repoLocalPath: tmpDir,
        errMessage: "tracker 500",
        now: () => 1700000000000,
        random: () => "deadbeef",
      });

      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
      // Filename starts with the padded queuedAt ms so a lexicographic
      // sort matches numeric FIFO order.
      expect(files[0]).toBe("001700000000000-deadbeef.json");

      const entry = readQueueEntry(tmpDir, files[0]!);
      // DX-300: attempt-1 backoff is 120s (was 30s pre-DX-300). Jitter
      // is pinned to 0 via the beforeEach `_setRngForTesting` seam.
      expect(entry).toMatchObject({
        issueId: "ISS-100",
        attempt: 1,
        queuedAt: 1700000000000,
        nextEligibleAt: 1700000000000 + 120 * 1000,
        lastErr: "tracker 500",
      });
    });

    // DX-302 — trelloSync override=false halts the retry queue.
    // Fresh enqueues are dropped on the floor (no JSON file is written);
    // the drainRetries flush also short-circuits without calling the
    // tracker. Both gates read `<repo>/.danxbot/settings.json`'s
    // `overrides.trelloSync.enabled` directly via
    // `isTrelloSyncOverrideDisabled`.
    it("DX-302 — enqueueRetry drops the enqueue when overrides.trelloSync.enabled is false", () => {
      writeFileSync(
        join(tmpDir, ".danxbot", "settings.json"),
        JSON.stringify({
          overrides: { trelloSync: { enabled: false } },
          meta: { updatedAt: new Date().toISOString(), updatedBy: "dashboard:test" },
        }),
      );

      enqueueRetry({
        issueId: "ISS-301",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        errMessage: "tracker 500 — would normally enqueue",
      });

      const files = listQueueFiles(tmpDir);
      expect(files).toEqual([]);
    });

    it("DX-302 — enqueueRetry writes normally when overrides.trelloSync.enabled is null (defer to env)", () => {
      writeFileSync(
        join(tmpDir, ".danxbot", "settings.json"),
        JSON.stringify({
          overrides: { trelloSync: { enabled: null } },
          meta: { updatedAt: new Date().toISOString(), updatedBy: "dashboard:test" },
        }),
      );

      enqueueRetry({
        issueId: "ISS-302",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        errMessage: "tracker 500",
      });

      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
    });

    it("DX-302 — drainRetries returns empty (no tracker call) when overrides.trelloSync.enabled is false; entries stay on disk", async () => {
      // First enqueue WITH trelloSync enabled (so the entry lands on disk).
      writeFileSync(
        join(tmpDir, ".danxbot", "settings.json"),
        JSON.stringify({
          overrides: { trelloSync: { enabled: true } },
          meta: { updatedAt: new Date().toISOString(), updatedBy: "dashboard:test" },
        }),
      );
      enqueueRetry({
        issueId: "ISS-303",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        errMessage: "tracker 500",
        skipArm: true,
      });
      expect(listQueueFiles(tmpDir)).toHaveLength(1);

      // Operator flips trelloSync off — drain should now no-op.
      writeFileSync(
        join(tmpDir, ".danxbot", "settings.json"),
        JSON.stringify({
          overrides: { trelloSync: { enabled: false } },
          meta: { updatedAt: new Date().toISOString(), updatedBy: "dashboard:test" },
        }),
      );

      const result = await drainRetries({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        prefix: "ISS",
        tracker,
        // Past the eligibility window so without the gate the entry
        // would be attempted immediately.
        now: () => Number.MAX_SAFE_INTEGER,
      });

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      // The entry remains on disk for the next drain after the operator
      // re-enables trelloSync — no attempt was consumed.
      expect(listQueueFiles(tmpDir)).toHaveLength(1);
      // syncIssue was not called.
      expect(vi.mocked(syncIssue)).not.toHaveBeenCalled();
    });

    it("multiple enqueues for the same issue produce distinct files (FIFO ordering preserved)", () => {
      let nowVal = 1700000000000;
      const next = () => ++nowVal;
      enqueueRetry({
        issueId: "ISS-200",
        repoLocalPath: tmpDir,
        now: next,
        random: () => "aaaaaaaa",
      });
      enqueueRetry({
        issueId: "ISS-200",
        repoLocalPath: tmpDir,
        now: next,
        random: () => "bbbbbbbb",
      });

      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(2);
      // The second file's queuedAt is later, so it sorts after the first.
      expect(files[0]).toMatch(/-aaaaaaaa\.json$/);
      expect(files[1]).toMatch(/-bbbbbbbb\.json$/);
    });
  });

  describe("drainRetries — Test 2 (FIFO + success path)", () => {
    it("reads queue files in FIFO order, calls syncIssue, persists updatedLocal, and unlinks on success", async () => {
      // Two issues queued earliest-first.
      const issueA = makeIssue({ id: "ISS-201", external_id: "ext-A" });
      const issueB = makeIssue({ id: "ISS-202", external_id: "ext-B" });
      writeOpenIssue(tmpDir, issueA);
      writeOpenIssue(tmpDir, issueB);

      enqueueRetry({
        issueId: "ISS-201",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "a",
      });
      enqueueRetry({
        issueId: "ISS-202",
        repoLocalPath: tmpDir,
        now: () => 2000,
        random: () => "b",
      });

      // Both entries are eligible at "now=10_000_000".
      // syncIssue returns updatedLocal byte-identical to input — no
      // disk write, just unlink.
      const callOrder: string[] = [];
      vi.mocked(syncIssue).mockImplementation(async (_t, local) => {
        callOrder.push(local.id);
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.attempted).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      // FIFO: A was enqueued earlier, must process first.
      expect(callOrder).toEqual(["ISS-201", "ISS-202"]);
      // Both queue files unlinked after successful drain.
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("persists updatedLocal back to the YAML when syncIssue produces tracker-side mutations", async () => {
      const original = makeIssue({
        id: "ISS-300",
        external_id: "",
        status: "Done",
        ac: [{ check_item_id: "", title: "AC1", checked: true }],
      });
      writeOpenIssue(tmpDir, original);
      enqueueRetry({
        issueId: "ISS-300",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });

      // syncIssue returns an issue with tracker-stamped ids.
      const stamped: Issue = {
        ...original,
        external_id: "ext-newly-allocated",
        ac: [
          { check_item_id: "ci-stamped", title: "AC1", checked: true },
        ],
      };
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: stamped,
        remoteWriteCount: 1,
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.succeeded).toBe(1);
      // Local YAML now reflects the tracker-stamped ids (read it back).
      const yamlPath = issuePath(tmpDir, "ISS-300", "open");
      const reread = parseIssue(readFileSync(yamlPath, "utf-8"), { expectedPrefix: "ISS" });
      expect(reread.external_id).toBe("ext-newly-allocated");
      expect(reread.ac[0]!.check_item_id).toBe("ci-stamped");
    });

    it("re-reads the YAML from disk on every drain pass (sees post-enqueue mutations)", async () => {
      // Pins the load-bearing Phase 2 semantic: queue stores only
      // `{issueId}`, drain re-fetches the YAML fresh. If the agent
      // saved status:Done during a Trello outage, then made a
      // follow-up edit before the queue drained, the drain MUST push
      // the LATEST YAML state — not a snapshot taken at enqueue time.
      const initialIssue = makeIssue({
        id: "ISS-250",
        external_id: "ext-250",
        status: "ToDo",
        comments: [],
      });
      writeOpenIssue(tmpDir, initialIssue);
      enqueueRetry({
        issueId: "ISS-250",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });

      // Mutate the YAML on disk between enqueue and drain — simulate
      // the agent appending a comment and flipping to Done while the
      // tracker outage continues.
      const mutated = makeIssue({
        id: "ISS-250",
        external_id: "ext-250",
        status: "Done",
        comments: [
          {
            id: undefined,
            author: "danxbot",
            timestamp: "2026-05-08T08:00:00Z",
            text: "post-enqueue edit",
          },
        ],
      });
      writeOpenIssue(tmpDir, mutated);

      let observed: Issue | null = null;
      vi.mocked(syncIssue).mockImplementation(async (_t, local) => {
        observed = local;
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(observed).not.toBeNull();
      // The drain saw the MUTATED state, not the enqueue-time snapshot.
      expect(observed!.status).toBe("Done");
      expect(observed!.comments).toHaveLength(1);
      expect(observed!.comments[0]!.text).toBe("post-enqueue edit");
    });

    it("does NOT rewrite the YAML when syncIssue returns byte-identical bytes (idempotent)", async () => {
      const issue = makeIssue({ id: "ISS-301", external_id: "ext-301" });
      const yamlPath = writeOpenIssue(tmpDir, issue);
      const beforeBytes = readFileSync(yamlPath);
      const beforeMtime = (await import("node:fs")).statSync(yamlPath).mtimeMs;

      enqueueRetry({
        issueId: "ISS-301",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      // Sleep 5ms so a hypothetical re-write would tick mtime forward.
      await new Promise((r) => setTimeout(r, 5));

      await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      const afterBytes = readFileSync(yamlPath);
      const afterMtime = (await import("node:fs")).statSync(yamlPath).mtimeMs;
      expect(afterBytes.equals(beforeBytes)).toBe(true);
      expect(afterMtime).toBe(beforeMtime);
    });
  });

  describe("drainRetries — Test 3 (backoff)", () => {
    it("on failure, increments attempt and rewrites file with new nextEligibleAt; subsequent drain inside backoff window is a no-op", async () => {
      const issue = makeIssue({ id: "ISS-400", external_id: "ext-400" });
      writeOpenIssue(tmpDir, issue);
      enqueueRetry({
        issueId: "ISS-400",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });

      // First drain: tracker fails. Pre-DX-300 attempt-1 backoff was
      // 30s; DX-300 is 120s, so the eligibility math shifts forward.
      // Queued at t=1000, attempt-1 backoff 120000 → eligible at
      // t=121000. Drain at t=200000 → eligible.
      vi.mocked(syncIssue).mockRejectedValueOnce(new Error("Trello 500"));
      const result1 = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 200_000,
        log: noopLog,
      });
      expect(result1.failed).toBe(1);
      expect(result1.succeeded).toBe(0);

      // Queue file rewritten in place with attempt=2 and new schedule.
      const files1 = listQueueFiles(tmpDir);
      expect(files1).toHaveLength(1);
      const entry1 = readQueueEntry(tmpDir, files1[0]!);
      expect(entry1.attempt).toBe(2);
      expect(entry1.lastErr).toBe("Trello 500");
      // attempt 2 backoff is 240s (4min) from drain `now` (200_000).
      expect(entry1.nextEligibleAt).toBe(200_000 + 240 * 1000);

      // Second drain BEFORE the new eligibility — must skip the entry,
      // not call syncIssue.
      vi.mocked(syncIssue).mockClear();
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });
      const result2 = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 200_000 + 60_000, // still inside the 240s window
        log: noopLog,
      });
      expect(result2.skipped).toBe(1);
      expect(result2.attempted).toBe(0);
      expect(syncIssue).not.toHaveBeenCalled();
      // Queue file unchanged.
      expect(listQueueFiles(tmpDir)).toEqual(files1);

      // Third drain AFTER eligibility resumes processing.
      vi.mocked(syncIssue).mockClear();
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });
      const result3 = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 200_000 + 240 * 1000 + 1, // just past eligibility
        log: noopLog,
      });
      expect(result3.succeeded).toBe(1);
      expect(syncIssue).toHaveBeenCalledTimes(1);
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });
  });

  describe("drainRetries — Test 4 (max attempts)", () => {
    it("attempt MAX_ATTEMPTS-1 → failure rewrites at MAX_ATTEMPTS, file STILL queued (not exhausted)", async () => {
      // Pins the off-by-one boundary: the `newAttempt > MAX_ATTEMPTS`
      // exhaustion check fires only when the NEXT attempt number would
      // exceed the cap. An entry currently at MAX_ATTEMPTS-1 (23) that
      // fails this drain rewrites to MAX_ATTEMPTS (24) and STAYS in
      // the queue — one more chance before the cap kicks in.
      const issue = makeIssue({ id: "ISS-450", external_id: "ext-450" });
      writeOpenIssue(tmpDir, issue);

      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const queuePath = resolve(queueDirPath, "0001-x.json");
      const entry: RetryQueueEntry = {
        issueId: "ISS-450",
        attempt: MAX_ATTEMPTS - 1,
        queuedAt: 1000,
        nextEligibleAt: 1000,
        lastErr: "earlier failure",
      };
      writeFileSync(queuePath, JSON.stringify(entry));

      vi.mocked(syncIssue).mockRejectedValue(new Error("Trello still 500"));
      const recordSystemError = vi.fn();

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 999_999_999,
        recordSystemError,
        log: noopLog,
      });

      expect(result.failed).toBe(1);
      expect(result.exhausted).toBe(0);
      // File still on disk, attempt advanced to MAX_ATTEMPTS.
      expect(existsSync(queuePath)).toBe(true);
      const rewritten = JSON.parse(
        readFileSync(queuePath, "utf-8"),
      ) as RetryQueueEntry;
      expect(rewritten.attempt).toBe(MAX_ATTEMPTS);
      expect(recordSystemError).not.toHaveBeenCalled();
    });

    it("attempt > MAX_ATTEMPTS on read (defensive branch) → unlinked + recordSystemError fires without a tracker call", async () => {
      // The defensive branch (retry-queue.ts ~303) handles a hand-edited
      // or partially-written file with attempt already past the cap. The
      // failure-side branch unlinks instead of rewriting, so this state
      // shouldn't naturally arise — but if it does, drain must drop the
      // entry without calling syncIssue.
      const issue = makeIssue({ id: "ISS-451", external_id: "ext-451" });
      writeOpenIssue(tmpDir, issue);

      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const queuePath = resolve(queueDirPath, "0001-x.json");
      const entry: RetryQueueEntry = {
        issueId: "ISS-451",
        attempt: MAX_ATTEMPTS + 5,
        queuedAt: 1000,
        nextEligibleAt: 0,
        lastErr: "old",
      };
      writeFileSync(queuePath, JSON.stringify(entry));

      const recordSystemError = vi.fn();

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 999_999_999,
        recordSystemError,
        log: noopLog,
      });

      expect(result.exhausted).toBe(1);
      expect(syncIssue).not.toHaveBeenCalled();
      expect(existsSync(queuePath)).toBe(false);
      expect(recordSystemError).toHaveBeenCalledTimes(1);
    });

    it("hitting MAX_ATTEMPTS deletes the queue file and fires recordSystemError", async () => {
      const issue = makeIssue({ id: "ISS-500", external_id: "ext-500" });
      writeOpenIssue(tmpDir, issue);

      // Hand-write a queue entry already at MAX_ATTEMPTS so the next
      // failure trips the exhaustion branch deterministically.
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const queueFile = resolve(queueDirPath, "0001-aaaa.json");
      const entry: RetryQueueEntry = {
        issueId: "ISS-500",
        attempt: MAX_ATTEMPTS,
        queuedAt: 1000,
        nextEligibleAt: 1000,
        lastErr: "earlier failure",
      };
      writeFileSync(queueFile, JSON.stringify(entry));

      vi.mocked(syncIssue).mockRejectedValue(new Error("Trello still 500"));
      const recordSystemError = vi.fn().mockResolvedValue(undefined);

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 999_999_999,
        recordSystemError,
        log: noopLog,
      });

      expect(result.exhausted).toBe(1);
      expect(result.failed).toBe(0);
      expect(existsSync(queueFile)).toBe(false);
      expect(recordSystemError).toHaveBeenCalledTimes(1);
      const errMsg = vi.mocked(recordSystemError).mock.calls[0]![0];
      expect(errMsg).toContain("ISS-500");
      expect(errMsg).toContain("max attempts");
      expect(errMsg).toContain("Trello still 500");
    });
  });

  describe("drainRetries — actionItemTitles wiring", () => {
    it("resolves retro.action_item_ids[] from local YAMLs and threads them through to syncIssue", async () => {
      // Pins parity with worker/issue-route.ts#loadActionItemTitles.
      // Without this resolution, retro renderings produced by drain-
      // driven syncs would silently fall back to `<ISS-N: unknown>`
      // even when the linked issue YAML exists locally.
      const parent = makeIssue({
        id: "ISS-475",
        external_id: "ext-475",
        status: "Done",
        retro: {
          good: "shipped",
          bad: "",
          action_item_ids: ["ISS-476", "ISS-477"],
          commits: [],
        },
      });
      const linkedA = makeIssue({
        id: "ISS-476",
        external_id: "ext-476",
        title: "follow-up alpha",
      });
      // ISS-477 deliberately absent — should render as unknown via the
      // sync-side fallback. Here we just assert the resolver omits it
      // from the map so the rendering layer can apply the right shape.
      writeOpenIssue(tmpDir, parent);
      writeOpenIssue(tmpDir, linkedA);

      enqueueRetry({
        issueId: "ISS-475",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });

      let observedOptions:
        | { actionItemTitles?: Map<string, string> }
        | undefined;
      vi.mocked(syncIssue).mockImplementation(async (_t, local, options) => {
        observedOptions = options;
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(observedOptions).toBeDefined();
      expect(observedOptions!.actionItemTitles).toBeInstanceOf(Map);
      const titles = observedOptions!.actionItemTitles!;
      expect(titles.get("ISS-476")).toBe("follow-up alpha");
      // Missing linked YAML is omitted (sync renderer handles via
      // `<ISS-N: unknown>`).
      expect(titles.has("ISS-477")).toBe(false);
    });
  });

  describe("drainRetries — Test 5 (missing YAML)", () => {
    it("queue entry pointing at a deleted YAML is unlinked without a tracker call", async () => {
      // Note: do NOT write a YAML for ISS-600.
      enqueueRetry({
        issueId: "ISS-600",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: makeIssue(),
        remoteWriteCount: 0,
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.yamlMissing).toBe(1);
      expect(result.attempted).toBe(0);
      expect(syncIssue).not.toHaveBeenCalled();
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("YAML on disk but unparseable → counts as yamlInvalid (distinct from yamlMissing), queue entry unlinked, no tracker call", async () => {
      // Real operator scenario: a YAML written by a corrupted save or
      // hand-edited to invalid shape exists at the expected path. The
      // drain must drop the queue entry rather than retrying every
      // tick against an unparseable file (would otherwise waste
      // attempt slots until MAX_ATTEMPTS). `yamlInvalid` is distinct
      // from `yamlMissing` so operators can tell deleted (normal)
      // from corrupt (operator-fix territory) at a glance.
      ensureIssuesDirs(tmpDir);
      const yamlPath = issuePath(tmpDir, "ISS-650", "open");
      writeFileSync(yamlPath, "::: not valid yaml :::\nschema_version: }");
      enqueueRetry({
        issueId: "ISS-650",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.yamlInvalid).toBe(1);
      expect(result.yamlMissing).toBe(0);
      expect(result.attempted).toBe(0);
      expect(syncIssue).not.toHaveBeenCalled();
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("eligibility gate short-circuits BEFORE the YAML lookup (skipped entries don't bump yamlMissing)", async () => {
      // Pins the cheap-skip invariant: when an entry is still inside
      // its backoff window, drain returns `skipped++` WITHOUT touching
      // the filesystem for the YAML. A regression that runs the YAML
      // lookup before the eligibility check would silently bump
      // `yamlMissing` (and unlink the queue entry!) for any entry
      // whose YAML happens to be temporarily absent during a backoff
      // window.
      enqueueRetry({
        issueId: "ISS-651",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });
      // Note: NO YAML on disk at all.

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 1000, // exactly at queuedAt — nextEligibleAt = 1000+120000 > 1000
        log: noopLog,
      });

      expect(result.skipped).toBe(1);
      expect(result.yamlMissing).toBe(0);
      expect(result.attempted).toBe(0);
      // Queue entry survives — it'll fire once the backoff window expires.
      expect(listQueueFiles(tmpDir)).toHaveLength(1);
    });

    it("non-.json files in queue dir are ignored (e.g. .DS_Store, .tmp swap files)", async () => {
      const issue = makeIssue({ id: "ISS-652", external_id: "ext-652" });
      writeOpenIssue(tmpDir, issue);

      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      // Stray non-JSON files alongside a valid entry.
      writeFileSync(resolve(queueDirPath, ".DS_Store"), "metadata");
      writeFileSync(resolve(queueDirPath, "abc.tmp"), "mid-write swap");
      writeFileSync(resolve(queueDirPath, "README"), "operator note");
      enqueueRetry({
        issueId: "ISS-652",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });

      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.succeeded).toBe(1);
      expect(result.malformed).toBe(0);
      // Stray files survived.
      expect(existsSync(resolve(queueDirPath, ".DS_Store"))).toBe(true);
      expect(existsSync(resolve(queueDirPath, "abc.tmp"))).toBe(true);
      expect(existsSync(resolve(queueDirPath, "README"))).toBe(true);
    });

    it("finds YAMLs in closed/ as well as open/", async () => {
      const issue = makeIssue({
        id: "ISS-601",
        external_id: "ext-601",
        status: "Done",
      });
      // Write directly into closed/.
      const closedDir = resolve(tmpDir, ".danxbot", "issues", "closed");
      mkdirSync(closedDir, { recursive: true });
      const closedPath = issuePath(tmpDir, issue.id, "closed");
      writeFileSync(closedPath, serializeIssue(issue));

      enqueueRetry({
        issueId: "ISS-601",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "z",
      });
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });
      expect(result.succeeded).toBe(1);
      // Drain succeeded against the closed/ YAML.
      expect(syncIssue).toHaveBeenCalledTimes(1);
    });
  });

  describe("drainRetries — Test 6 (concurrent enqueue snapshot)", () => {
    it("an enqueue happening DURING the drain pass is invisible to that pass and processed on the next", async () => {
      const issueA = makeIssue({ id: "ISS-700", external_id: "ext-700" });
      const issueB = makeIssue({ id: "ISS-701", external_id: "ext-701" });
      writeOpenIssue(tmpDir, issueA);
      writeOpenIssue(tmpDir, issueB);

      enqueueRetry({
        issueId: "ISS-700",
        repoLocalPath: tmpDir,
        now: () => 1000,
        random: () => "a",
      });

      // Mock syncIssue: when ISS-700 is processed, enqueue ISS-701 into
      // the same queue dir mid-drain. The snapshot taken at the top of
      // drainRetries must NOT include this new file.
      const sawDuringDrain: string[] = [];
      vi.mocked(syncIssue).mockImplementation(async (_t, local) => {
        sawDuringDrain.push(local.id);
        if (local.id === "ISS-700") {
          enqueueRetry({
            issueId: "ISS-701",
            repoLocalPath: tmpDir,
            now: () => 5000,
            random: () => "b",
          });
        }
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.attempted).toBe(1);
      expect(sawDuringDrain).toEqual(["ISS-700"]);
      // ISS-700 unlinked, ISS-701 still queued.
      const remaining = listQueueFiles(tmpDir);
      expect(remaining).toHaveLength(1);
      const entry = readQueueEntry(tmpDir, remaining[0]!);
      expect(entry.issueId).toBe("ISS-701");

      // Next tick processes ISS-701.
      const result2 = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 20_000_000,
        log: noopLog,
      });
      expect(result2.succeeded).toBe(1);
      expect(sawDuringDrain).toEqual(["ISS-700", "ISS-701"]);
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });
  });

  describe("drainRetries — invariants", () => {
    it("missing queue dir → empty result, no error", async () => {
      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 1000,
        log: noopLog,
      });
      expect(result).toEqual({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        exhausted: 0,
        yamlMissing: 0,
        yamlInvalid: 0,
        skipped: 0,
        malformed: 0,
      });
    });

    it("malformed queue entry is dropped (not fatal); other entries still process", async () => {
      const issue = makeIssue({ id: "ISS-800", external_id: "ext-800" });
      writeOpenIssue(tmpDir, issue);

      // Plant a junk file in the queue dir alongside a valid entry.
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const junkPath = resolve(queueDirPath, "000000000000001-junk.json");
      writeFileSync(junkPath, "not valid json {{{");
      enqueueRetry({
        issueId: "ISS-800",
        repoLocalPath: tmpDir,
        now: () => 2,
        random: () => "good",
      });

      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        log: noopLog,
      });

      expect(result.malformed).toBe(1);
      expect(result.succeeded).toBe(1);
      // Junk file unlinked.
      expect(existsSync(junkPath)).toBe(false);
      // Valid entry processed and unlinked.
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("recordSystemError that throws does not poison the rest of the drain", async () => {
      const issueA = makeIssue({ id: "ISS-900", external_id: "ext-900" });
      const issueB = makeIssue({ id: "ISS-901", external_id: "ext-901" });
      writeOpenIssue(tmpDir, issueA);
      writeOpenIssue(tmpDir, issueB);

      // ISS-900 is at MAX_ATTEMPTS (will exhaust).
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      writeFileSync(
        resolve(queueDirPath, "000000000000001-a.json"),
        JSON.stringify({
          issueId: "ISS-900",
          attempt: MAX_ATTEMPTS,
          queuedAt: 1,
          nextEligibleAt: 1,
          lastErr: "old",
        }),
      );
      // ISS-901 is fresh (will succeed).
      enqueueRetry({
        issueId: "ISS-901",
        repoLocalPath: tmpDir,
        now: () => 2,
        random: () => "b",
      });

      vi.mocked(syncIssue).mockImplementation(async (_t, local) => {
        if (local.id === "ISS-900") throw new Error("still failing");
        return { updatedLocal: local, remoteWriteCount: 0 };
      });

      const recordSystemError = vi
        .fn()
        .mockRejectedValue(new Error("dashboard down"));

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 10_000_000,
        recordSystemError,
        log: noopLog,
      });

      expect(result.exhausted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(recordSystemError).toHaveBeenCalledTimes(1);
      // Queue empty: both entries cleaned up despite the hook throw.
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });
  });

  /**
   * DX-218 (Event-Driven Worker Phase 3) — `enqueueRetry` arms a
   * `setTimeout(nextEligibleAt - now)` that fires the retry callback
   * inside the same module. These tests exercise the timer-driven path
   * with vitest fake timers; the legacy `drainRetries`-based assertions
   * above remain valid because the manual flush helper is preserved.
   */
  describe("event-driven retry — setTimeout-armed timer (DX-218)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("enqueueRetry arms a setTimeout for nextEligibleAt - now and the timer fires the push at the backoff window", async () => {
      const issue = makeIssue({ id: "ISS-700", external_id: "ext-700" });
      writeOpenIssue(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 1,
      });
      vi.setSystemTime(1700000000000);

      enqueueRetry({
        issueId: "ISS-700",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        errMessage: "tracker 503",
      });

      // BEFORE the backoff window expires — nothing fired yet.
      expect(syncIssue).not.toHaveBeenCalled();
      expect(listQueueFiles(tmpDir)).toHaveLength(1);

      // Just inside the 120s backoff window — still nothing.
      await vi.advanceTimersByTimeAsync(119_000);
      expect(syncIssue).not.toHaveBeenCalled();

      // Cross the 120s threshold — timer fires + callback drains the entry.
      await vi.advanceTimersByTimeAsync(2_000);

      expect(syncIssue).toHaveBeenCalledTimes(1);
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("transient tracker error reschedules a fresh setTimeout for the next backoff (120s → 240s) and unlinks on eventual success", async () => {
      const issue = makeIssue({ id: "ISS-701", external_id: "ext-701" });
      writeOpenIssue(tmpDir, issue);
      // Attempt 1: throw. Attempt 2: succeed.
      let calls = 0;
      vi.mocked(syncIssue).mockImplementation(async (_t, local) => {
        calls++;
        if (calls === 1) throw new Error("tracker 503");
        return { updatedLocal: local, remoteWriteCount: 0 };
      });
      vi.setSystemTime(1700000000000);

      enqueueRetry({
        issueId: "ISS-701",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        errMessage: "tracker 503",
      });

      // Fire attempt 1 — fails — rewrites entry with attempt=2 + nextEligibleAt at +240s.
      await vi.advanceTimersByTimeAsync(121_000);
      expect(calls).toBe(1);
      const filesAfterFail = listQueueFiles(tmpDir);
      expect(filesAfterFail).toHaveLength(1);
      const entryAfterFail = readQueueEntry(tmpDir, filesAfterFail[0]!);
      expect(entryAfterFail.attempt).toBe(2);
      // Sanity: rescheduled at attempt-2 backoff (240s) from the fire moment (~120s past queuedAt).
      expect(entryAfterFail.nextEligibleAt).toBeGreaterThan(1700000000000 + 240 * 1000);

      // Advance just shy of the 240s mark — nothing more fired.
      await vi.advanceTimersByTimeAsync(240 * 1000 - 10_000);
      expect(calls).toBe(1);

      // Cross the 240s mark — attempt 2 fires + succeeds + unlinks.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toBe(2);
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("max-attempts exhaustion via the timer path fires recordSystemError + unlinks entry (matches legacy drain semantics)", async () => {
      const issue = makeIssue({ id: "ISS-702", external_id: "ext-702" });
      writeOpenIssue(tmpDir, issue);
      vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 401"));
      vi.setSystemTime(1700000000000);

      const recordSystemError = vi.fn();

      // Hand-place a queue entry already at the cap so a single timer
      // fire trips the exhaustion branch.
      ensureIssuesDirs(tmpDir);
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const filename = "001700000000000-cap.json";
      const path = resolve(queueDirPath, filename);
      const entry: RetryQueueEntry = {
        issueId: "ISS-702",
        attempt: MAX_ATTEMPTS, // 24 → next attempt would be 25 → drop
        queuedAt: 1700000000000,
        nextEligibleAt: 1700000000000,
        lastErr: "prior",
        repoName: "test-repo",
        issuePrefix: "ISS",
      };
      writeFileSync(path, JSON.stringify(entry));

      // Register tracker + hook the way the boot scan does, then arm
      // the timer for this entry directly via boot reschedule.
      const result = bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        recordSystemError,
      });
      expect(result.rearmed).toBe(1);

      // Past-due entry → timer fires immediately (delay=0) on next tick.
      await vi.advanceTimersByTimeAsync(0);
      // The fire body re-reads + re-syncs once before bumping attempt to 25 → drop.
      expect(recordSystemError).toHaveBeenCalledTimes(1);
      expect(String(recordSystemError.mock.calls[0]![0])).toContain(
        "max attempts (24) exceeded for ISS-702",
      );
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("timer fires with no tracker registered → re-arms in 30s without a tracker call", async () => {
      vi.setSystemTime(1700000000000);

      // Queue entry whose `repoName` references a repo we never
      // register a tracker for.
      ensureIssuesDirs(tmpDir);
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const path = resolve(queueDirPath, "001700000000000-orph.json");
      const entry: RetryQueueEntry = {
        issueId: "ISS-703",
        attempt: 1,
        queuedAt: 1700000000000,
        nextEligibleAt: 1700000000000,
        lastErr: "",
        repoName: "unregistered-repo",
        issuePrefix: "ISS",
      };
      writeFileSync(path, JSON.stringify(entry));

      // Boot rescan registers a tracker only for "test-repo" — the
      // entry's "unregistered-repo" doesn't match, so the fire body
      // hits the no-tracker branch.
      bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
      });
      // Drop the test-repo registration so the lookup misses (the
      // boot scan injected `repoName: test-repo` into the entry).
      _resetForTesting();
      // Re-arm WITHOUT registering any tracker — fire body must
      // gracefully re-arm 30s instead of throwing.
      bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "different-repo",
        issuePrefix: "DIFF",
        tracker,
      });

      await vi.advanceTimersByTimeAsync(0);

      // syncIssue was NOT called (no tracker resolved for entry).
      expect(syncIssue).not.toHaveBeenCalled();
      // Entry still on disk, rewritten with bumped nextEligibleAt.
      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
      const rewritten = readQueueEntry(tmpDir, files[0]!);
      expect(rewritten.nextEligibleAt).toBe(1700000000000 + 30_000);
    });

    it("bootRescheduleRetryQueue rearms timers for every persisted entry on worker restart", async () => {
      const a = makeIssue({ id: "ISS-704", external_id: "ext-704" });
      const b = makeIssue({ id: "ISS-705", external_id: "ext-705" });
      writeOpenIssue(tmpDir, a);
      writeOpenIssue(tmpDir, b);

      // Pre-populate two queue entries WITHOUT arming timers (skipArm).
      vi.setSystemTime(1700000000000);
      enqueueRetry({
        issueId: "ISS-704",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        skipArm: true,
      });
      enqueueRetry({
        issueId: "ISS-705",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        skipArm: true,
      });
      expect(listQueueFiles(tmpDir)).toHaveLength(2);

      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: a,
        remoteWriteCount: 0,
      });

      // Simulate worker restart — boot scan rearms.
      const result = bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
      });
      expect(result).toEqual({ rearmed: 2, malformed: 0 });

      // Cross both entries' backoff windows (attempt-1 = 120s).
      await vi.advanceTimersByTimeAsync(121_000);

      expect(syncIssue).toHaveBeenCalledTimes(2);
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("setRetryQueueTrackerForRepo + setRetryQueueSystemErrorHookForRepo register the tracker and hook the timer callback resolves at fire time", async () => {
      const issue = makeIssue({ id: "ISS-706", external_id: "ext-706" });
      writeOpenIssue(tmpDir, issue);
      vi.setSystemTime(1700000000000);

      // Enqueue WITHOUT passing tracker / hook in opts — relies on the
      // setter helpers having been called separately.
      const recordSystemError = vi.fn();
      setRetryQueueTrackerForRepo("test-repo", tracker);
      setRetryQueueSystemErrorHookForRepo("test-repo", recordSystemError);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 1,
      });

      enqueueRetry({
        issueId: "ISS-706",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        errMessage: "tracker 502",
      });

      await vi.advanceTimersByTimeAsync(121_000);

      expect(syncIssue).toHaveBeenCalledTimes(1);
      expect(listQueueFiles(tmpDir)).toEqual([]);
      // No exhaustion → hook never fires.
      expect(recordSystemError).not.toHaveBeenCalled();
    });

    it("bootRescheduleRetryQueue drops malformed JSON entries and reports them in the result", () => {
      ensureIssuesDirs(tmpDir);
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      // Plant one valid + two malformed entries.
      const valid: RetryQueueEntry = {
        issueId: "ISS-800",
        attempt: 1,
        queuedAt: 1,
        nextEligibleAt: 1_000_000,
        lastErr: "",
        repoName: "test-repo",
        issuePrefix: "ISS",
      };
      writeFileSync(resolve(queueDirPath, "001.json"), JSON.stringify(valid));
      writeFileSync(resolve(queueDirPath, "002.json"), "{not valid json{{{");
      writeFileSync(
        resolve(queueDirPath, "003.json"),
        JSON.stringify({ issueId: "ISS-801" }),
      ); // Missing required fields.

      const result = bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
      });

      expect(result).toEqual({ rearmed: 1, malformed: 2 });
      // Malformed files unlinked, valid one survives.
      expect(listQueueFiles(tmpDir)).toEqual(["001.json"]);
    });

    it("bootRescheduleRetryQueue backfills repoName + issuePrefix on legacy entries written before the schema bump", () => {
      ensureIssuesDirs(tmpDir);
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      // Legacy entry — `repoName` + `issuePrefix` absent on disk.
      const legacy = {
        issueId: "ISS-810",
        attempt: 1,
        queuedAt: 1,
        nextEligibleAt: 1_000_000,
        lastErr: "",
      };
      writeFileSync(
        resolve(queueDirPath, "001.json"),
        JSON.stringify(legacy),
      );

      const result = bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
      });

      expect(result).toEqual({ rearmed: 1, malformed: 0 });
      // The on-disk file is untouched at boot rearm — backfill is in
      // memory only — but the in-memory entry that armed the timer
      // carries the boot-supplied identity. (Disk-backfill happens
      // when the timer fires + rewrites on failure.)
    });

    it("fireRetry malformed-on-fire (entry rewritten to junk after arming) drops the queue entry without a tracker call", async () => {
      const issue = makeIssue({ id: "ISS-820", external_id: "ext-820" });
      writeOpenIssue(tmpDir, issue);
      vi.setSystemTime(1700000000000);

      enqueueRetry({
        issueId: "ISS-820",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        skipArm: true,
      });
      // Boot rearm sets up the timer + tracker registry.
      bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
      });

      // Corrupt the queue entry on disk AFTER the timer is armed but
      // BEFORE it fires — the timer callback re-reads the file and must
      // gracefully drop it.
      const files = listQueueFiles(tmpDir);
      const path = resolve(
        tmpDir,
        ".danxbot",
        ".trello-retry",
        files[0]!,
      );
      writeFileSync(path, "{{not json}}");

      await vi.advanceTimersByTimeAsync(121_000);

      expect(syncIssue).not.toHaveBeenCalled();
      expect(listQueueFiles(tmpDir)).toEqual([]);
    });

    it("fireRetry hits the defensive `entry.attempt > MAX_ATTEMPTS` branch when boot-rearmed entry is already past the cap", async () => {
      ensureIssuesDirs(tmpDir);
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const overflowing: RetryQueueEntry = {
        issueId: "ISS-821",
        attempt: MAX_ATTEMPTS + 1, // Defensive branch — past the cap on disk.
        queuedAt: 1700000000000,
        nextEligibleAt: 1700000000000,
        lastErr: "prior",
        repoName: "test-repo",
        issuePrefix: "ISS",
      };
      writeFileSync(
        resolve(queueDirPath, "001.json"),
        JSON.stringify(overflowing),
      );
      const recordSystemError = vi.fn();

      bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        recordSystemError,
      });
      vi.setSystemTime(1700000000000);

      await vi.advanceTimersByTimeAsync(0);

      // Defensive drop — no syncIssue, no rewrite, file unlinked, hook fires.
      expect(syncIssue).not.toHaveBeenCalled();
      expect(listQueueFiles(tmpDir)).toEqual([]);
      expect(recordSystemError).toHaveBeenCalledTimes(1);
    });

    it("fireRetry (timer path) defers without bumping attempt when the circuit is open AT FIRE TIME", async () => {
      // DX-300: the production hot path is `fireRetry`, not
      // `drainRetries`. The drain tests pin the same semantics but
      // pin them at the wrong code path — this test exercises the
      // setTimeout-driven branch.
      const issue = makeIssue({ id: "ISS-2310", external_id: "ext-2310" });
      writeOpenIssue(tmpDir, issue);
      vi.mocked(syncIssue).mockResolvedValue({
        updatedLocal: issue,
        remoteWriteCount: 0,
      });
      vi.setSystemTime(1_700_000_000_000);
      // Wire the breaker's now-provider to the same fake clock as the
      // queue so they stay in lockstep across the fake-timer advances.
      setCircuitNow(() => Date.now());

      enqueueRetry({
        issueId: "ISS-2310",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        errMessage: "tracker 503",
      });

      // Advance to just before the 120s backoff window so the
      // breaker trip happens RIGHT before the timer fires (otherwise
      // the breaker's 60s cooldown expires before the queue's 120s
      // backoff and the fire-time check observes half-open).
      await vi.advanceTimersByTimeAsync(115_000);
      circuitRecordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /pre-fire)"),
        { endpoint: "GET /pre-fire" },
      );

      // Now cross the original 120s threshold → timer fires →
      // observes open breaker → defers w/o tracker call.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(syncIssue).not.toHaveBeenCalled();
      // Entry still queued, attempt STILL 1 (no bump), rescheduled
      // for past the cooldown window.
      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
      const e = readQueueEntry(tmpDir, files[0]!);
      expect(e.attempt).toBe(1);
      // Breaker tripped at t = 1_700_000_000_000 + 115_000; cooldown
      // ends at +60_000 = 1_700_000_000_175_000. Defer reschedules
      // past that. The exact value depends on jitter; just assert
      // it sits strictly past the cooldown floor.
      expect(e.nextEligibleAt).toBeGreaterThanOrEqual(
        1_700_000_000_000 + 115_000 + 60_000,
      );
    });

    it("fireRetry: race-case — syncIssue throws TrelloCircuitOpen-shaped error after the up-front check → defers w/o attempt bump", async () => {
      // Pin the post-call branch in `fireRetry` (the `isCircuitOpenMessage`
      // matcher inside the error path). Without this, the production
      // path would bump the attempt counter on a race-failure that
      // semantically was a deferral, not a real failure.
      const issue = makeIssue({ id: "ISS-2311", external_id: "ext-2311" });
      writeOpenIssue(tmpDir, issue);
      // Simulate the wrapper short-circuiting AFTER fireRetry's
      // up-front check passed. syncIssue throws a circuit-open shape
      // on EVERY call (the breaker stays open across re-fires until
      // the cooldown elapses; subsequent timers re-arm via defer).
      vi.mocked(syncIssue).mockRejectedValue(
        new Error("Trello circuit open until 2026-05-12T00:00:00.000Z"),
      );
      vi.setSystemTime(1_700_000_000_000);
      setCircuitNow(() => Date.now());

      enqueueRetry({
        issueId: "ISS-2311",
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        errMessage: "tracker 503",
      });

      // Cross the 120s window — fireRetry fires, the up-front
      // isOpen() check returns false (we didn't trip the breaker
      // via `circuitRecordFailure`), syncIssue runs (rejected mock),
      // the catch returns a circuit-open-shaped error, the post-call
      // branch matches it and defers without bumping attempt.
      // `mockRejectedValue` (persistent) keeps producing the same
      // error on every re-armed fire so the test exercises the
      // race-branch repeatedly without flipping into normal-failure
      // accounting on a second call.
      await vi.advanceTimersByTimeAsync(121_000);

      // At least one call landed (the race-branch matched it).
      expect(vi.mocked(syncIssue).mock.calls.length).toBeGreaterThanOrEqual(1);
      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
      const e = readQueueEntry(tmpDir, files[0]!);
      // Attempt NOT bumped — every race-branch invocation in this
      // sequence treated the wrapper short-circuit as a deferral.
      expect(e.attempt).toBe(1);
    });

    it("recordSystemError hook throwing on timer-driven exhaustion does not crash the timer or leave the entry on disk", async () => {
      ensureIssuesDirs(tmpDir);
      // Plant the YAML so attemptPush reaches syncIssue (which throws),
      // bumping attempt past the cap → dropExhausted → hook fires.
      writeOpenIssue(tmpDir, makeIssue({ id: "ISS-822", external_id: "ext-822" }));
      const queueDirPath = resolve(tmpDir, ".danxbot", ".trello-retry");
      mkdirSync(queueDirPath, { recursive: true });
      const cap: RetryQueueEntry = {
        issueId: "ISS-822",
        attempt: MAX_ATTEMPTS,
        queuedAt: 1700000000000,
        nextEligibleAt: 1700000000000,
        lastErr: "prior",
        repoName: "test-repo",
        issuePrefix: "ISS",
      };
      writeFileSync(
        resolve(queueDirPath, "001.json"),
        JSON.stringify(cap),
      );
      vi.mocked(syncIssue).mockRejectedValue(new Error("tracker 401"));
      const recordSystemError = vi
        .fn()
        .mockRejectedValue(new Error("dashboard down"));
      // Set system time BEFORE arming so the timer's delay calculation
      // (`nextEligibleAt - Date.now()`) sees the past-due window
      // immediately.
      vi.setSystemTime(1700000000000);

      bootRescheduleRetryQueue({
        repoLocalPath: tmpDir,
        repoName: "test-repo",
        issuePrefix: "ISS",
        tracker,
        recordSystemError,
      });

      // Advance past the 0-delay timer; one fire bumps attempt MAX → MAX+1 → drop.
      await vi.advanceTimersByTimeAsync(100);

      // Entry is unlinked despite the hook throw.
      expect(listQueueFiles(tmpDir)).toEqual([]);
      expect(recordSystemError).toHaveBeenCalledTimes(1);
    }, 10_000);
  });

  /**
   * DX-300 — retry queue defers without consuming an attempt while
   * the process-wide Trello circuit breaker is open. The wiring is
   * the load-bearing bit: a 429 from any caller pauses every queue
   * entry's next fire for the cooldown window, then drains as
   * normal once the breaker probes closed.
   */
  describe("circuit-breaker integration (DX-300)", () => {
    it("drainRetries defers an eligible entry WITHOUT bumping attempt when the circuit is open", async () => {
      const issue = makeIssue({ id: "ISS-2301", external_id: "ext-2301" });
      writeOpenIssue(tmpDir, issue);
      enqueueRetry({
        issueId: "ISS-2301",
        repoLocalPath: tmpDir,
        now: () => 1_000,
        random: () => "a",
      });

      // Trip the circuit at t=200_000 so it's open through the drain.
      let nowMs = 200_000;
      setCircuitNow(() => nowMs);
      circuitRecordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /cards/x)"),
        { endpoint: "GET /cards/x" },
      );

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => nowMs,
        log: noopLog,
      });

      // No tracker call, no attempt bump.
      expect(syncIssue).not.toHaveBeenCalled();
      expect(result.attempted).toBe(0);
      expect(result.skipped).toBe(1);
      // Entry still queued, attempt still 1, nextEligibleAt past circuit cooldown.
      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
      const rewritten = readQueueEntry(tmpDir, files[0]!);
      expect(rewritten.attempt).toBe(1);
      // Cooldown ended at 200_000 + 60s = 260_000; jitter pinned to 0
      // by the beforeEach rng seam, so wake is exactly 260_000.
      expect(rewritten.nextEligibleAt).toBe(260_000);
    });

    it("N concurrent entries all defer through ONE circuit-open event (no flood of tracker calls)", async () => {
      // Plant 5 eligible entries; trip the circuit once; verify NONE
      // of them issued a tracker call, and they all rescheduled to
      // the same circuit-cooldown wake-up.
      const ids = ["ISS-2302", "ISS-2303", "ISS-2304", "ISS-2305", "ISS-2306"];
      for (let i = 0; i < ids.length; i++) {
        writeOpenIssue(
          tmpDir,
          makeIssue({ id: ids[i]!, external_id: `ext-${i}` }),
        );
        enqueueRetry({
          issueId: ids[i]!,
          repoLocalPath: tmpDir,
          now: () => 1_000 + i,
          random: () => String.fromCharCode(97 + i).repeat(8),
        });
      }
      expect(listQueueFiles(tmpDir)).toHaveLength(5);

      let nowMs = 300_000;
      setCircuitNow(() => nowMs);
      circuitRecordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /cards/y)"),
        { endpoint: "GET /cards/y" },
      );

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => nowMs,
        log: noopLog,
      });

      expect(syncIssue).not.toHaveBeenCalled();
      expect(result.attempted).toBe(0);
      expect(result.skipped).toBe(5);
      // Every entry deferred to circuit wake-up = 300_000 + 60s = 360_000
      // (jitter pinned to 0 in beforeEach).
      const all = listQueueFiles(tmpDir);
      expect(all).toHaveLength(5);
      for (const fn of all) {
        const e = readQueueEntry(tmpDir, fn);
        expect(e.attempt).toBe(1);
        expect(e.nextEligibleAt).toBe(360_000);
      }
    });

    it("race: circuit went open mid-syncIssue → outcome's TrelloCircuitOpen message defers w/o attempt bump", async () => {
      // Simulate the wrapper short-circuiting mid-call (e.g. another
      // caller tripped the breaker between the drain's top-of-loop
      // isOpen() check and syncIssue's first sub-call). syncIssue
      // throws a synthetic TrelloCircuitOpen-shaped Error here.
      const issue = makeIssue({ id: "ISS-2307", external_id: "ext-2307" });
      writeOpenIssue(tmpDir, issue);
      enqueueRetry({
        issueId: "ISS-2307",
        repoLocalPath: tmpDir,
        now: () => 1_000,
        random: () => "r",
      });

      let nowMs = 400_000;
      setCircuitNow(() => nowMs);
      // Note: do NOT trip the breaker here — drain's top-of-loop check
      // sees closed and proceeds into attemptPush. The mock then throws
      // a circuit-open-shaped error from inside.
      vi.mocked(syncIssue).mockRejectedValueOnce(
        new Error("Trello circuit open until 2026-05-11T20:00:00.000Z"),
      );

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => nowMs,
        log: noopLog,
      });

      // The wrapper short-circuited; queue treats it as a defer.
      expect(result.attempted).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);
      const files = listQueueFiles(tmpDir);
      expect(files).toHaveLength(1);
      const rewritten = readQueueEntry(tmpDir, files[0]!);
      expect(rewritten.attempt).toBe(1); // NOT bumped
    });

    it("deferEntryForCircuit jitter uses the breaker's INITIAL cooldown as the base, NOT the remaining cooldown window", async () => {
      // Pin the fix for the "late-deferral jitter collapse" failure mode:
      // when an entry defers RIGHT before the cooldown ends, the jitter
      // window must STILL be ~6s wide (10% of 60s INITIAL cooldown),
      // not ~0.1s (10% of remaining cooldown).
      const issue = makeIssue({ id: "ISS-2309", external_id: "ext-2309" });
      writeOpenIssue(tmpDir, issue);
      enqueueRetry({
        issueId: "ISS-2309",
        repoLocalPath: tmpDir,
        now: () => 1_000,
        random: () => "z",
      });

      // Trip the breaker at t=500_000; cooldown ends at t=560_000.
      let nowMs = 500_000;
      setCircuitNow(() => nowMs);
      circuitRecordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /late)"),
        { endpoint: "GET /late" },
      );

      // Drain LATE in the cooldown (5s before it ends). With the
      // remaining-cooldown jitter, max-jitter would be ~500ms. With
      // INITIAL-cooldown jitter, max-jitter is ~6s.
      nowMs = 555_000;
      // Max-jitter rng → 0.999 → jitter ~ 0.999 * 0.1 * 60_000 = 5994ms.
      _setRngForTesting(() => 0.999);
      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => nowMs,
        log: noopLog,
      });
      expect(result.skipped).toBe(1);
      const files = listQueueFiles(tmpDir);
      const e = readQueueEntry(tmpDir, files[0]!);
      // Cooldown ends at 560_000. With INITIAL-base jitter we expect
      // 560_000 + ~5990 (well above 560_500 the remaining-base math
      // would have produced).
      expect(e.nextEligibleAt).toBeGreaterThan(560_500);
      expect(e.nextEligibleAt).toBeLessThan(560_000 + 6_000);
    });

    it("normal (non-circuit) tracker error STILL bumps attempt — sanity check the new branch didn't accidentally swallow real failures", async () => {
      const issue = makeIssue({ id: "ISS-2308", external_id: "ext-2308" });
      writeOpenIssue(tmpDir, issue);
      enqueueRetry({
        issueId: "ISS-2308",
        repoLocalPath: tmpDir,
        now: () => 1_000,
        random: () => "r",
      });

      vi.mocked(syncIssue).mockRejectedValueOnce(new Error("Trello API error: 500 Server Error (GET /cards/z)"));

      const result = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 200_000,
        log: noopLog,
      });

      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      const files = listQueueFiles(tmpDir);
      const rewritten = readQueueEntry(tmpDir, files[0]!);
      // Normal failure → attempt bumped to 2.
      expect(rewritten.attempt).toBe(2);
    });
  });
});
