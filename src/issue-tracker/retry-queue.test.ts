/**
 * Unit tests for the disk-backed Trello retry queue (DX-132 / Phase 2 of
 * the trello-decouple epic DX-130).
 *
 * Test isolation: each test creates a fresh `mkdtempSync` repo dir and
 * `rmSync`s it in `afterEach`. `syncIssue` is mocked at the module
 * level — the queue's contract is "call syncIssue, persist if differs,
 * unlink on success / rewrite on failure", so mocking the tracker layer
 * keeps these tests fast and deterministic without paying the
 * `MemoryTracker`'s per-test setup cost.
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
  backoffMsForAttempt,
  drainRetries,
  enqueueRetry,
  MAX_ATTEMPTS,
  type RetryQueueEntry,
} from "./retry-queue.js";
import { ensureIssuesDirs, issuePath } from "../poller/yaml-lifecycle.js";
import { parseIssue, serializeIssue } from "./yaml.js";
import type { Issue, IssueTracker } from "./interface.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 4,
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

describe("backoffMsForAttempt", () => {
  it("attempt 1 → 30s", () => {
    expect(backoffMsForAttempt(1)).toBe(30 * 1000);
  });
  it("attempt 2 → 2min", () => {
    expect(backoffMsForAttempt(2)).toBe(2 * 60 * 1000);
  });
  it("attempt 3 → 10min", () => {
    expect(backoffMsForAttempt(3)).toBe(10 * 60 * 1000);
  });
  it("attempt 4 → 1h", () => {
    expect(backoffMsForAttempt(4)).toBe(60 * 60 * 1000);
  });
  it("attempt 24 → 1h (cap)", () => {
    expect(backoffMsForAttempt(24)).toBe(60 * 60 * 1000);
  });
});

describe("retry-queue", () => {
  let tmpDir: string;
  const tracker = {} as IssueTracker;

  beforeEach(() => {
    vi.mocked(syncIssue).mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), "danxbot-retry-queue-"));
  });

  afterEach(() => {
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
      expect(entry).toMatchObject({
        issueId: "ISS-100",
        attempt: 1,
        queuedAt: 1700000000000,
        nextEligibleAt: 1700000000000 + 30 * 1000,
        lastErr: "tracker 500",
      });
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
      const reread = parseIssue(readFileSync(yamlPath, "utf-8"));
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

      // First drain: tracker fails.
      vi.mocked(syncIssue).mockRejectedValueOnce(new Error("Trello 500"));
      const result1 = await drainRetries({
        tracker,
        repoLocalPath: tmpDir,
        prefix: "ISS",
        now: () => 100_000, // entry's nextEligibleAt was 1000 + 30000 = 31000 — eligible
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
      // attempt 2 backoff is 2min from now (100_000)
      expect(entry1.nextEligibleAt).toBe(100_000 + 2 * 60 * 1000);

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
        now: () => 100_000 + 30_000, // still inside the 2min window
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
        now: () => 100_000 + 2 * 60 * 1000 + 1, // just past eligibility
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
        now: () => 1000, // exactly at queuedAt — nextEligibleAt = 1000+30000 > 1000
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
});
