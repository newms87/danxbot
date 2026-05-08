/**
 * On-disk Trello retry queue (DX-132 / Phase 2 of the trello-decouple
 * epic DX-130).
 *
 * Phase 1 (DX-131) made `runSync` local-first — the YAML on disk is
 * always written before the tracker push fires, so a Trello outage no
 * longer strands terminal-status YAMLs in `open/`. Phase 1 still drops
 * the FAILED tracker push on the floor: a comment / retro / status the
 * agent appended during a Trello outage is invisible to the tracker
 * until ANOTHER successful save fires (which may be hours away). This
 * module fills the gap.
 *
 * Contract:
 *
 *   1. `enqueueRetry({issueId, repoLocalPath, errMessage?})` writes a
 *      single JSON file at `<repo>/.danxbot/.trello-retry/<seq>.json`
 *      capturing the issue id, the queued-at timestamp, and the
 *      backoff-eligibility timestamp. Filename starts with the queued-
 *      at ms (zero-padded) so a `readdirSync().sort()` produces FIFO
 *      order even before we re-sort by `queuedAt` inside.
 *
 *   2. `drainRetries({tracker, repoLocalPath, prefix, ...})` reads the
 *      queue dir, snapshots the file list at start (concurrent enqueues
 *      during drain are processed next tick — pinned by test 6), sorts
 *      FIFO by `queuedAt`, and for each eligible entry:
 *         - re-reads the YAML fresh from disk (Phase 1 handoff:
 *           "drainRetries should read the YAML directly … the local
 *           YAML is already authoritative when the drain fires — only
 *           the TRACKER side is behind"). If the YAML was deleted
 *           between enqueue and drain, the queue entry is unlinked
 *           with no tracker call (test 5).
 *         - calls `syncIssue` directly (NOT `runSync` — that path's
 *           local-first persist is redundant when the YAML on disk is
 *           already the truth).
 *         - on success: persists `updatedLocal` to the SAME path it
 *           was read from, but only if the serialized bytes differ
 *           (matching `runSync`'s second-persist contract — orphan-
 *           recovered external_id, check_item_id stamps, inbound human
 *           comments may have changed). Then unlinks the queue entry.
 *         - on failure: bumps `attempt`, schedules `nextEligibleAt`
 *           per the backoff table, rewrites the queue file in place.
 *           After `MAX_ATTEMPTS` (24) failures, the queue file is
 *           unlinked and a persistent-failure event is emitted via
 *           `recordSystemError` (Phase 4 / DX-134 wires the dashboard
 *           SSE channel; until then the hook logs only).
 *
 *   3. Backoff: attempt 1 → 30s, 2 → 2min, 3 → 10min, 4+ → 1h. The
 *      number is "ms to wait BEFORE attempting this number."
 *
 *   4. Single drain pass per tick. The poller calls `drainRetries`
 *      ONCE at the top of `_poll`, before any list fetches. Avoids
 *      hammering Trello during a recovery window.
 *
 *   5. Filename format: `<paddedQueuedAtMs>-<random>.json`. Random is
 *      a short 8-char suffix to prevent collisions when two enqueues
 *      land in the same millisecond. Sorting filenames lexicographically
 *      yields FIFO; the in-memory sort by `queuedAt` is a belt-and-
 *      suspenders against clock skew or out-of-order rewrites.
 *
 *   6. Idempotent + tracker-independent — the queue dir is local-only
 *      and survives worker restarts (just JSON files on disk).
 *      `<repo>/.danxbot/.gitignore` gets `.trello-retry/` appended via
 *      `ensureGitignoreEntry` from the poller's per-tick sync stage —
 *      the entries hold raw upstream tracker error text and must
 *      never be committed.
 *
 * Out of scope (per card description):
 *   - Dashboard surface for queue depth (Phase 4 / DX-134).
 *   - Retries against trackers that don't have transient-error semantics
 *     (e.g. `MemoryTracker` never throws, so the queue would simply
 *     never produce entries for that backend).
 *   - Compacting the queue across restarts (single drain pass per tick
 *     is plenty).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  IssueParseError,
  parseIssue,
  serializeIssue,
} from "./yaml.js";
import { loadActionItemTitles, syncIssue } from "./sync.js";
import type { Issue, IssueTracker } from "./interface.js";
import { issuePath } from "./paths.js";
import { createLogger, type Logger } from "../logger.js";

const log = createLogger("retry-queue");

/** Hard cap on retry attempts. After this, the queue entry is dropped. */
export const MAX_ATTEMPTS = 24;

/** Backoff schedule (ms) — wait time BEFORE the attempt at this number. */
const BACKOFF_MS_BY_ATTEMPT: ReadonlyArray<number> = [
  // index 0 is unused; attempts are 1-indexed
  0,
  30 * 1000, // attempt 1: 30s
  2 * 60 * 1000, // attempt 2: 2min
  10 * 60 * 1000, // attempt 3: 10min
];
const BACKOFF_MS_DEFAULT = 60 * 60 * 1000; // attempt 4+: 1h

/** ms to wait BEFORE the given attempt number. */
export function backoffMsForAttempt(attempt: number): number {
  if (attempt < BACKOFF_MS_BY_ATTEMPT.length && attempt >= 1) {
    return BACKOFF_MS_BY_ATTEMPT[attempt]!;
  }
  return BACKOFF_MS_DEFAULT;
}

/**
 * On-disk shape. Stored as JSON (one file per queued issue retry).
 * Field documentation:
 *  - `issueId` — the local primary key. The drain re-reads the YAML
 *    fresh, so we DON'T snapshot the issue body here (see "stale-
 *    payload class of bugs" in the card description).
 *  - `attempt` — number of the NEXT attempt. Initialized to 1 on
 *    enqueue. Incremented on each failure.
 *  - `queuedAt` — epoch ms; pinned at first enqueue, never updated.
 *    Sort key for FIFO ordering during drain.
 *  - `nextEligibleAt` — epoch ms; the absolute time at which the
 *    upcoming attempt becomes eligible. On enqueue (`attempt = 1`)
 *    this is `queuedAt + backoffMs(1) = queuedAt + 30s`. On each
 *    failure rewrite it becomes `now + backoffMs(newAttempt)`.
 *  - `lastErr` — the most recent tracker error message. Surfaced via
 *    `recordSystemError` when MAX_ATTEMPTS is hit so the operator can
 *    see WHY the queue gave up.
 */
export interface RetryQueueEntry {
  issueId: string;
  attempt: number;
  queuedAt: number;
  nextEligibleAt: number;
  lastErr: string;
}

/** `<repo>/.danxbot/.trello-retry/` */
function queueDir(repoLocalPath: string): string {
  return resolve(repoLocalPath, ".danxbot", ".trello-retry");
}

function ensureQueueDir(repoLocalPath: string): void {
  mkdirSync(queueDir(repoLocalPath), { recursive: true });
}

function entryFilename(queuedAtMs: number, randomSuffix: string): string {
  // 15 digits covers Date.now() comfortably (year 5138). Pad so
  // lexicographic readdir() ordering matches numeric ordering.
  return `${String(queuedAtMs).padStart(15, "0")}-${randomSuffix}.json`;
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    // ENOENT is fine — concurrent drain pass already removed it.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export interface EnqueueRetryOptions {
  issueId: string;
  repoLocalPath: string;
  /** Last tracker-error message — surfaced via persistent-failure hook on max attempts. */
  errMessage?: string;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
  /** Test seam — defaults to `randomUUID().slice(0, 8)`. */
  random?: () => string;
}

/**
 * Persist a fresh retry intent for `issueId` to the queue dir. Called
 * from `runSync`'s catch branch right after `recordError`.
 *
 * Each call writes a NEW file (no dedup-by-issueId). If the same issue
 * fails repeatedly inside one outage window, every save adds another
 * queue entry — drain processes them in FIFO order, and the second-and-
 * later entries hit a no-op `syncIssue` (the local YAML is already the
 * latest state, so the diff is empty after the first entry succeeds).
 * The duplication is bounded (one entry per failed save) and far less
 * harmful than the alternatives (overwriting an existing entry would
 * reset the backoff schedule; merging would require lock state on disk).
 */
export function enqueueRetry(opts: EnqueueRetryOptions): void {
  const queuedAt = opts.now?.() ?? Date.now();
  const random = opts.random?.() ?? randomUUID().slice(0, 8);
  ensureQueueDir(opts.repoLocalPath);
  const filename = entryFilename(queuedAt, random);
  const path = resolve(queueDir(opts.repoLocalPath), filename);
  const entry: RetryQueueEntry = {
    issueId: opts.issueId,
    attempt: 1,
    queuedAt,
    nextEligibleAt: queuedAt + backoffMsForAttempt(1),
    lastErr: opts.errMessage ?? "",
  };
  writeFileSync(path, JSON.stringify(entry));
}

export interface DrainResult {
  /** Number of eligible entries we attempted a tracker call for. */
  attempted: number;
  /** Tracker push succeeded → queue entry unlinked. */
  succeeded: number;
  /** Tracker push failed → queue entry rewritten with backoff. */
  failed: number;
  /** Hit MAX_ATTEMPTS this drain → queue entry unlinked + persistent failure. */
  exhausted: number;
  /** Queue entry pointed at a YAML that no longer exists on disk → entry unlinked. */
  yamlMissing: number;
  /**
   * Queue entry's YAML exists on disk but failed `parseIssue` (corrupt
   * shape, missing required fields, prefix mismatch). Distinct from
   * `yamlMissing` so operators can distinguish "deleted" (normal) from
   * "corrupt" (operator-fix territory) when reading the per-tick log.
   */
  yamlInvalid: number;
  /** Entry not yet eligible for retry (still inside backoff window). */
  skipped: number;
  /** Queue file unparseable → entry unlinked, drain continued. */
  malformed: number;
}

export interface DrainDeps {
  tracker: IssueTracker;
  repoLocalPath: string;
  prefix: string;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
  /**
   * Persistent-failure hook fired when an entry hits MAX_ATTEMPTS. Phase
   * 4 (DX-134) wires this into the dashboard `system_errors` SSE channel;
   * until then the default is no-op (logging happens unconditionally).
   */
  recordSystemError?: (message: string) => void | Promise<void>;
  /** Test seam — defaults to the module-level logger. */
  log?: Logger;
}

const EMPTY_DRAIN_RESULT: DrainResult = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  exhausted: 0,
  yamlMissing: 0,
  yamlInvalid: 0,
  skipped: 0,
  malformed: 0,
};

/**
 * Drain one pass of the retry queue. Snapshots the file list at start so
 * concurrent enqueues during drain are processed on the NEXT tick.
 * Idempotent on a clean queue. Tracker independent for the eligibility
 * gate — `nextEligibleAt > now` short-circuits without reading the
 * YAML or hitting the network.
 */
export async function drainRetries(deps: DrainDeps): Promise<DrainResult> {
  const dir = queueDir(deps.repoLocalPath);
  if (!existsSync(dir)) return { ...EMPTY_DRAIN_RESULT };

  const now = deps.now ?? (() => Date.now());
  const logger = deps.log ?? log;

  // Snapshot file list at the top — concurrent enqueues hitting this dir
  // during the drain pass are intentionally invisible until the next
  // tick. Sort lexicographically (filename starts with padded queuedAt
  // so this matches numeric FIFO order); we re-sort by parsed
  // `queuedAt` below as belt-and-suspenders.
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const result: DrainResult = { ...EMPTY_DRAIN_RESULT };
  const entries: { path: string; entry: RetryQueueEntry }[] = [];
  for (const filename of filenames) {
    const path = resolve(dir, filename);
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as RetryQueueEntry;
      if (
        typeof parsed.issueId !== "string" ||
        typeof parsed.attempt !== "number" ||
        typeof parsed.queuedAt !== "number" ||
        typeof parsed.nextEligibleAt !== "number" ||
        typeof parsed.lastErr !== "string"
      ) {
        throw new Error("missing required fields");
      }
      entries.push({ path, entry: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Retry queue: dropping malformed entry ${filename}: ${msg}`,
      );
      unlinkIfExists(path);
      result.malformed++;
    }
  }
  entries.sort((a, b) => a.entry.queuedAt - b.entry.queuedAt);

  for (const { path, entry } of entries) {
    if (entry.nextEligibleAt > now()) {
      result.skipped++;
      continue;
    }

    if (entry.attempt > MAX_ATTEMPTS) {
      // Defensive: an entry rewritten with attempt > MAX shouldn't exist
      // (the failure branch unlinks instead of rewriting), but if a
      // hand-edited or partially-written file slips through, drop it.
      await dropExhausted(path, entry, logger, deps.recordSystemError);
      result.exhausted++;
      continue;
    }

    const openPath = issuePath(deps.repoLocalPath, entry.issueId, "open");
    const closedPath = issuePath(deps.repoLocalPath, entry.issueId, "closed");
    const yamlPath = existsSync(openPath)
      ? openPath
      : existsSync(closedPath)
        ? closedPath
        : null;

    if (!yamlPath) {
      // YAML was deleted between enqueue and drain (operator action,
      // closed→deleted, etc.). Without a YAML on disk there's nothing
      // to push; drop the queue entry without touching the tracker.
      unlinkIfExists(path);
      result.yamlMissing++;
      logger.info(
        `Retry queue: ${entry.issueId} YAML missing on disk — dropping queue entry`,
      );
      continue;
    }

    let issue: Issue;
    try {
      issue = parseIssue(readFileSync(yamlPath, "utf-8"), {
        expectedPrefix: deps.prefix,
      });
    } catch (err) {
      const msg = err instanceof IssueParseError ? err.message : String(err);
      // Local YAML corruption is operator-fix territory. Drop the queue
      // entry rather than retrying every tick against an unparseable
      // file. Counted as `yamlInvalid` (distinct from `yamlMissing`)
      // so operators can tell "deleted" (normal) from "corrupt" (needs
      // a fix) at a glance in the per-tick log.
      unlinkIfExists(path);
      logger.warn(
        `Retry queue: YAML parse failure for ${entry.issueId}, dropping queue entry: ${msg}`,
      );
      result.yamlInvalid++;
      continue;
    }

    const actionItemTitles = loadActionItemTitles(
      deps.repoLocalPath,
      issue.retro.action_item_ids,
      deps.prefix,
      logger,
    );

    result.attempted++;

    try {
      const { updatedLocal } = await syncIssue(deps.tracker, issue, {
        actionItemTitles,
      });
      // Persist only if syncIssue produced any local-side mutation
      // (orphan-recovered external_id, check_item_id stamps, inbound
      // comments, retro stamp). Mirror runSync's second-persist
      // contract; idempotent — same bytes back means zero filesystem
      // writes.
      const newBytes = serializeIssue(updatedLocal);
      const oldBytes = readFileSync(yamlPath, "utf-8");
      if (newBytes !== oldBytes) writeFileSync(yamlPath, newBytes);
      unlinkIfExists(path);
      result.succeeded++;
      logger.info(
        `Retry queue: drained ${entry.issueId} on attempt ${entry.attempt}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const newAttempt = entry.attempt + 1;
      if (newAttempt > MAX_ATTEMPTS) {
        const exhaustedEntry: RetryQueueEntry = {
          ...entry,
          attempt: newAttempt,
          lastErr: errMsg,
        };
        await dropExhausted(path, exhaustedEntry, logger, deps.recordSystemError);
        result.exhausted++;
      } else {
        const rewritten: RetryQueueEntry = {
          ...entry,
          attempt: newAttempt,
          nextEligibleAt: now() + backoffMsForAttempt(newAttempt),
          lastErr: errMsg,
        };
        writeFileSync(path, JSON.stringify(rewritten));
        result.failed++;
        logger.warn(
          `Retry queue: ${entry.issueId} attempt ${entry.attempt} failed (${errMsg}); next attempt in ${Math.round(
            backoffMsForAttempt(newAttempt) / 1000,
          )}s`,
        );
      }
    }
  }

  return result;
}

async function dropExhausted(
  path: string,
  entry: RetryQueueEntry,
  logger: Logger,
  recordSystemError: DrainDeps["recordSystemError"],
): Promise<void> {
  unlinkIfExists(path);
  const msg = `Retry queue: max attempts (${MAX_ATTEMPTS}) exceeded for ${entry.issueId}; last error: ${entry.lastErr}`;
  logger.error(msg);
  if (recordSystemError) {
    try {
      await recordSystemError(msg);
    } catch (err) {
      // Don't let a broken dashboard hook poison the rest of the drain.
      logger.warn(
        `Retry queue: recordSystemError hook threw for ${entry.issueId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

