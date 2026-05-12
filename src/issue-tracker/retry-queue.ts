/**
 * Event-driven Trello retry queue (Phase 3 of the Event-Driven Worker
 * epic, DX-218 — replaces the tick-drained model from DX-132).
 *
 * Phase 1 (DX-131) made `runSync` local-first — the YAML on disk is
 * always written before the tracker push fires. Phase 2 (DX-132) added
 * a disk-backed retry queue so failed tracker pushes weren't lost
 * across worker restarts. Phase 3 (this commit) replaces the tick-
 * drained drain loop with a `setTimeout`-armed scheduler so a recovery
 * push fires within seconds of its backoff window expiring instead of
 * waiting up to one full poller tick.
 *
 * Contract:
 *
 *   1. `enqueueRetry({issueId, repoLocalPath, repoName, issuePrefix,
 *      tracker, errMessage?, recordSystemError?})` writes a JSON file at
 *      `<repo>/.danxbot/.trello-retry/<seq>.json` capturing the issue id,
 *      attempt counter, queued-at timestamp, and backoff-eligibility
 *      timestamp. THEN arms a `setTimeout` to fire the retry callback at
 *      `nextEligibleAt - now` ms.
 *
 *   2. The timer callback (`fireRetry`) re-reads the queue entry from
 *      disk (in case it was rewritten by a concurrent enqueue), reads
 *      the YAML fresh from disk, and runs the push via
 *      `attemptRetryPush` from `src/issue/reconcile/trello.ts`. Outcome
 *      branches:
 *        - success: unlink queue entry, persist updatedLocal if changed
 *          (handled inside `attemptRetryPush`).
 *        - YAML missing on disk: unlink queue entry without a tracker
 *          call (operator deleted, closed → tombstone).
 *        - YAML parse failure: unlink queue entry, log warning
 *          (operator-fix territory — retrying every backoff against an
 *          unparseable file would burn attempt slots).
 *        - tracker error: bump attempt, rewrite the file with a new
 *          `nextEligibleAt`, arm a fresh timer for the new window.
 *        - max attempts exceeded: unlink queue entry + fire
 *          `recordSystemError` so the dashboard banner surfaces the
 *          permanent failure.
 *
 *   3. Backoff (unchanged from DX-132): attempt 1 → 30s, 2 → 2min, 3 →
 *      10min, 4+ → 1h.
 *
 *   4. Boot rescheduling: `bootRescheduleRetryQueue(deps)` walks the
 *      queue dir and arms a timer for every persisted entry at its
 *      stored `nextEligibleAt` (or immediately if past due). Called once
 *      from `src/index.ts` at worker start so retries that were in-
 *      flight before a restart resume on schedule.
 *
 *   5. Per-entry timer registry: module-scoped `Map<filePath,
 *      NodeJS.Timeout>`. New enqueues add an entry; cleared on
 *      `_resetForTesting` and on successful drain. The retry queue dir
 *      is local-only and survives worker restarts (just JSON files).
 *      `<repo>/.danxbot/.gitignore` already lists `.trello-retry/`.
 *
 *   6. **Why not `drainRetries`?** Phase 3 retires the per-tick
 *      `drainRetries` call from `runSync`. Polling for backoff windows is
 *      per-tick noise — `setTimeout` fires within milliseconds of the
 *      window expiring, beats a per-minute drain by 30-90s on average.
 *      The function is preserved as a manual flush helper for tests
 *      that want a deterministic await-point.
 *
 * Out of scope (Phase 3 spec):
 *   - Webhook-based Trello inbound (separate effort).
 *   - Retries against trackers without transient-error semantics
 *     (`MemoryTracker` never throws → queue stays empty for tests).
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
import type { Issue, IssueTracker } from "./interface.js";
import { IssueParseError, parseIssue } from "./yaml.js";
import { issuePath } from "./paths.js";
import { loadActionItemTitles, syncIssue } from "./sync.js";
import {
  CIRCUIT_OPEN_MESSAGE_PREFIX,
  INITIAL_COOLDOWN_MS as CIRCUIT_INITIAL_COOLDOWN_MS,
  isOpen as circuitIsOpen,
  openUntilMs as circuitOpenUntilMs,
  TrelloCircuitOpen,
} from "./circuit-breaker.js";
import { persistIfDifferent } from "../issue/reconcile/trello-persist.js";
import { setLastPushedHash } from "../issue/reconcile/push-hash-cache.js";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { isTrelloSyncOverrideDisabled } from "../settings-file.js";
import { createLogger, type Logger } from "../logger.js";

const log = createLogger("retry-queue");

/** Hard cap on retry attempts. After this, the queue entry is dropped. */
export const MAX_ATTEMPTS = 24;

/**
 * Exponential backoff base (DX-300). Wait before attempt 1 is
 * `BACKOFF_BASE_MS`; each subsequent attempt doubles the prior delay,
 * capped at `BACKOFF_CAP_MS`. Schedule:
 *
 *   attempt 1 → 120s
 *   attempt 2 → 240s
 *   attempt 3 → 480s
 *   attempt 4 → 960s
 *   attempt 5+ → 1800s (cap)
 *
 * Replaces the pre-DX-300 fixed-step schedule (30s, 2min, 10min, 1h).
 * The shift is deliberate: 30s was too aggressive against Trello's
 * rate-limit cooldown (a 429 with a per-card 30s retry storms back
 * inside the rate-limit window). 120s+ gives Trello time to relax,
 * and combined with the process-wide circuit breaker
 * (`circuit-breaker.ts`) every concurrent caller is paused on the
 * first 429 so the queue alone doesn't extend the rate-limit window.
 */
export const BACKOFF_BASE_MS = 120 * 1000;
export const BACKOFF_CAP_MS = 30 * 60 * 1000;

/**
 * Jitter fraction — `delay += rng() * BACKOFF_JITTER_FRACTION * delay`,
 * so the realized delay is uniformly distributed in `[delay, delay * 1.1)`.
 * Spreads N cards that all hit 429 simultaneously across the backoff
 * window instead of having them all retry at the same instant.
 */
export const BACKOFF_JITTER_FRACTION = 0.1;

/**
 * Module-level jitter source. Production reads `Math.random`; tests
 * swap via `_setRngForTesting` (typically `() => 0` for deterministic
 * backoff equal to the un-jittered base, or `() => 0.999` to pin the
 * worst-case jitter ceiling). Swapping per-call would require threading
 * `rng` through every caller (enqueue, fire-retry rescheduler, drain
 * rescheduler, boot rescheduler), which is much noisier.
 */
let rng: () => number = Math.random;

/** Test seam — swap the jitter source. */
export function _setRngForTesting(f: () => number): void {
  rng = f;
}

/**
 * Compute the delay (ms) to wait BEFORE attempt `attempt` (1-indexed).
 *
 * Formula: `min(BACKOFF_BASE_MS * 2^(attempt-1), BACKOFF_CAP_MS)`
 *          + uniform jitter in `[0, BACKOFF_JITTER_FRACTION * baseDelay)`.
 *
 * The jitter source is module-level — see `_setRngForTesting`. Tests
 * may also pass an explicit `rng` argument for one-off overrides.
 */
export function backoffMsForAttempt(
  attempt: number,
  rngOverride?: () => number,
): number {
  if (attempt < 1) return 0;
  const exp = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
    BACKOFF_CAP_MS,
  );
  const r = rngOverride ?? rng;
  const jitter = r() * BACKOFF_JITTER_FRACTION * exp;
  return Math.floor(exp + jitter);
}

/** On-disk shape — one JSON file per queued entry. */
export interface RetryQueueEntry {
  issueId: string;
  attempt: number;
  queuedAt: number;
  nextEligibleAt: number;
  lastErr: string;
  /**
   * Repo identity — needed by the timer callback to resolve the tracker.
   * Optional in the type so legacy entries from a worker boot before
   * the Phase 3 schema bump round-trip cleanly. The boot scan +
   * `drainRetries` + manual constructions in tests backfill from
   * caller-supplied defaults; production `enqueueRetry` always writes
   * non-empty strings.
   */
  repoName?: string;
  issuePrefix?: string;
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
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Per-file timer registry. The key is the absolute path of the queue
 * entry's JSON file. Used to cancel timers in `_resetForTesting` and to
 * avoid re-arming a timer for an entry that already has one pending.
 */
const armedTimers = new Map<string, NodeJS.Timeout>();

/**
 * Track one tracker registration per repo so the timer callback (which
 * runs without a request-level deps object) can resolve which tracker
 * to use. The retry-queue's enqueue path stores the `repoName` in the
 * JSON entry, and the timer looks up the tracker via this registry.
 *
 * Production registers from `src/index.ts` once per worker boot;
 * tests register their own (memory or stub) tracker via
 * `setRetryQueueTrackerForRepo`.
 */
const trackersByRepo = new Map<string, IssueTracker>();

export function setRetryQueueTrackerForRepo(
  repoName: string,
  tracker: IssueTracker,
): void {
  trackersByRepo.set(repoName, tracker);
}

/**
 * Same role as the tracker registry — `recordSystemError` hook resolved
 * by repo. Keeps the timer callback decoupled from any specific
 * dashboard wiring.
 */
const systemErrorHookByRepo = new Map<
  string,
  (message: string) => void | Promise<void>
>();

export function setRetryQueueSystemErrorHookForRepo(
  repoName: string,
  hook: (message: string) => void | Promise<void>,
): void {
  systemErrorHookByRepo.set(repoName, hook);
}

export interface EnqueueRetryOptions {
  issueId: string;
  repoLocalPath: string;
  /**
   * Repo identity — written into the entry so the timer callback can
   * resolve a tracker. Optional in tests; production callers
   * (`pushTrelloDiff`, `runSync`) MUST pass both fields. When omitted,
   * the entry defaults to `repoName: ""` + `issuePrefix: ""`, the
   * timer callback's tracker lookup re-arms in 30s, and the manual
   * `drainRetries` flush helper backfills the test's repoName.
   */
  repoName?: string;
  issuePrefix?: string;
  /** Tracker injected ONLY for the immediate-test path; production resolves via repo registry. */
  tracker?: IssueTracker;
  /** Last tracker-error message — surfaced via persistent-failure hook on max attempts. */
  errMessage?: string;
  /** Persistent-failure hook — fired when an entry hits MAX_ATTEMPTS. */
  recordSystemError?: (message: string) => void | Promise<void>;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
  /** Test seam — defaults to `randomUUID().slice(0, 8)`. */
  random?: () => string;
  /**
   * Test seam — when `true`, `enqueueRetry` returns without arming a
   * timer (tests that want to verify the on-disk JSON without
   * triggering the timer callback). Production never sets this.
   */
  skipArm?: boolean;
}

/**
 * Persist a fresh retry intent for `issueId` to disk and arm a
 * `setTimeout` for the backoff window. Each call writes a NEW file (no
 * dedup-by-issueId); duplicate entries from rapid retries process FIFO
 * with the second-and-later being effective no-ops once the first
 * succeeds.
 */
export function enqueueRetry(opts: EnqueueRetryOptions): void {
  // DX-302 — `trelloSync=false` halts every outbound Trello call for the
  // repo, including freshly-failed pushes that would otherwise enter
  // the retry queue. Drop the enqueue on the floor; the upstream caller
  // (reconcile step 7 / runSync) sees no error since this is a
  // best-effort retry write. Reads `overrides.trelloSync.enabled` only;
  // null + true + read errors all fall through to normal enqueue.
  if (isTrelloSyncOverrideDisabled(opts.repoLocalPath)) {
    log.info(
      `Retry queue: trello sync disabled for repo (${opts.repoName ?? "unknown"}) — dropping enqueue for ${opts.issueId}`,
    );
    return;
  }
  const queuedAt = opts.now?.() ?? Date.now();
  const random = opts.random?.() ?? randomUUID().slice(0, 8);
  ensureQueueDir(opts.repoLocalPath);
  const filename = entryFilename(queuedAt, random);
  const path = resolve(queueDir(opts.repoLocalPath), filename);
  const repoName = opts.repoName ?? "";
  const issuePrefix = opts.issuePrefix ?? "";
  const entry: RetryQueueEntry = {
    issueId: opts.issueId,
    attempt: 1,
    queuedAt,
    nextEligibleAt: queuedAt + backoffMsForAttempt(1),
    lastErr: opts.errMessage ?? "",
    repoName,
    issuePrefix,
  };
  writeFileSync(path, JSON.stringify(entry));

  // Register the tracker + hook now so a boot-rescheduled timer can
  // find them on fire. Production passes both in via opts; tests can
  // either pass them or pre-register via the setter helpers.
  if (opts.tracker && repoName !== "") {
    trackersByRepo.set(repoName, opts.tracker);
  }
  if (opts.recordSystemError && repoName !== "") {
    systemErrorHookByRepo.set(repoName, opts.recordSystemError);
  }

  if (opts.skipArm) return;
  armTimer(path, entry, opts.now);
}

/**
 * Arm a `setTimeout` to fire the retry callback at the entry's
 * `nextEligibleAt`. If multiple enqueues arm a timer for the same path
 * (shouldn't happen — each enqueue produces a unique filename), the
 * latest replaces the prior. Past-due entries fire immediately
 * (`Math.max(0, …)`).
 */
function armTimer(
  path: string,
  entry: RetryQueueEntry,
  now: (() => number) | undefined,
): void {
  const nowMs = now?.() ?? Date.now();
  const delayMs = Math.max(0, entry.nextEligibleAt - nowMs);
  const prior = armedTimers.get(path);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    armedTimers.delete(path);
    void fireRetry(path, now).catch((err) => {
      log.warn(
        `Retry queue: fireRetry crashed for ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }, delayMs);
  // unref so a pending timer doesn't keep the process alive at shutdown.
  if (typeof timer.unref === "function") timer.unref();
  armedTimers.set(path, timer);
}

/**
 * Re-read the entry + YAML, run the push, branch on outcome. Called
 * from the `setTimeout` callback in `armTimer`. Re-reading the entry
 * from disk lets a concurrent enqueue mid-flight cooperate cleanly:
 * the timer fires, sees the (possibly-updated) attempt/backoff state,
 * and proceeds.
 */
async function fireRetry(
  path: string,
  now: (() => number) | undefined,
): Promise<void> {
  if (!existsSync(path)) {
    // Race: another fireRetry instance for the same path drained it
    // (e.g. test reset). Nothing to do.
    return;
  }
  let entry: RetryQueueEntry;
  try {
    const raw = readFileSync(path, "utf-8");
    entry = JSON.parse(raw) as RetryQueueEntry;
    if (
      typeof entry.issueId !== "string" ||
      typeof entry.attempt !== "number" ||
      typeof entry.queuedAt !== "number" ||
      typeof entry.nextEligibleAt !== "number" ||
      typeof entry.lastErr !== "string"
    ) {
      throw new Error("missing required fields");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Retry queue: dropping malformed entry ${path}: ${msg}`);
    unlinkIfExists(path);
    return;
  }

  const entryRepoName = entry.repoName ?? "";
  const entryIssuePrefix = entry.issuePrefix ?? "";

  if (entry.attempt > MAX_ATTEMPTS) {
    // Defensive: hand-edited or partially-written file with attempt
    // already past the cap. Mirrors the legacy drainRetries behavior.
    await dropExhausted(path, entry, log);
    return;
  }

  // DX-300: defer (without consuming an attempt) when the process-wide
  // Trello circuit breaker is open. The breaker was tripped by another
  // caller hitting 429, so we already know any Trello-bound call would
  // either short-circuit with TrelloCircuitOpen or — worse — actually
  // hit the API mid-cooldown and extend the rate-limit window.
  if (circuitIsOpen()) {
    deferEntryForCircuit(path, entry, now);
    return;
  }

  const tracker = entryRepoName
    ? trackersByRepo.get(entryRepoName)
    : undefined;
  if (!tracker) {
    // No tracker registered for this repo (e.g. boot scan ran before
    // the index.ts wiring registered it, or a hand-written test
    // entry omitted `repoName`). Re-arm a 30s timer to wait for
    // registration and try again.
    log.warn(
      `Retry queue: no tracker registered for repo "${entryRepoName}"; re-arming in 30s for ${entry.issueId}`,
    );
    const nowMs = now?.() ?? Date.now();
    const rearmedEntry: RetryQueueEntry = {
      ...entry,
      nextEligibleAt: nowMs + 30_000,
    };
    writeFileSync(path, JSON.stringify(rearmedEntry));
    armTimer(path, rearmedEntry, now);
    return;
  }

  // Find the YAML and run the push attempt.
  const repoLocalPath = repoLocalPathFromQueueFile(path);

  // DX-302 — re-check the override at fire time so an operator who
  // flipped `trelloSync=false` between enqueue and fire halts the
  // attempt without losing the queue entry. The entry STAYS on disk;
  // when the operator re-enables, a future enqueue or boot replay re-
  // arms the timer and the attempt fires. Re-arm a 30s timer so a
  // setTimeout-armed entry doesn't sit orphaned until the next worker
  // boot if the operator never flips it back.
  if (isTrelloSyncOverrideDisabled(repoLocalPath)) {
    log.info(
      `Retry queue: trello sync disabled for repo (${entryRepoName}) — deferring ${entry.issueId} (entry stays on disk)`,
    );
    const nowMs = now?.() ?? Date.now();
    const deferredEntry: RetryQueueEntry = {
      ...entry,
      nextEligibleAt: nowMs + 30_000,
    };
    writeFileSync(path, JSON.stringify(deferredEntry));
    armTimer(path, deferredEntry, now);
    return;
  }

  const result = await attemptPush({
    issueId: entry.issueId,
    repoName: entryRepoName,
    repoLocalPath,
    issuePrefix: entryIssuePrefix,
    tracker,
  });

  if ("yamlMissing" in result) {
    log.info(
      `Retry queue: ${entry.issueId} YAML missing on disk — dropping queue entry`,
    );
    unlinkIfExists(path);
    return;
  }
  if ("yamlInvalid" in result) {
    log.warn(
      `Retry queue: YAML parse failure for ${entry.issueId}, dropping queue entry: ${result.errMessage}`,
    );
    unlinkIfExists(path);
    return;
  }
  if (result.succeeded) {
    log.info(
      `Retry queue: drained ${entry.issueId} on attempt ${entry.attempt}`,
    );
    unlinkIfExists(path);
    return;
  }

  // DX-300: race-case — the circuit-open check at fireRetry top saw
  // closed, then syncIssue's first sub-call tripped the breaker (or
  // raced another caller's trip). The wrapper rethrows
  // `TrelloCircuitOpen` whose message comes through here verbatim;
  // treat it as a deferral (no attempt bump), same as the pre-check.
  if (isCircuitOpenMessage(result.errMessage)) {
    deferEntryForCircuit(path, entry, now);
    return;
  }

  // Tracker errored — bump attempt and reschedule, OR exhaust.
  const newAttempt = entry.attempt + 1;
  if (newAttempt > MAX_ATTEMPTS) {
    const exhaustedEntry: RetryQueueEntry = {
      ...entry,
      attempt: newAttempt,
      lastErr: result.errMessage,
    };
    await dropExhausted(path, exhaustedEntry, log);
    return;
  }
  const nowMs = now?.() ?? Date.now();
  const delayMs = backoffMsForAttempt(newAttempt);
  const rewritten: RetryQueueEntry = {
    ...entry,
    attempt: newAttempt,
    nextEligibleAt: nowMs + delayMs,
    lastErr: result.errMessage,
  };
  writeFileSync(path, JSON.stringify(rewritten));
  log.warn(
    `Retry queue: ${entry.issueId} attempt ${entry.attempt} failed (${result.errMessage}); next attempt in ${Math.round(
      delayMs / 1000,
    )}s`,
  );
  armTimer(path, rewritten, now);
}

/**
 * Match the error shape `TrelloCircuitOpen.message` produces from
 * `circuit-breaker.ts`. Used by the queue's race-handler — when the
 * tracker wrapper short-circuits mid-syncIssue, the error makes its
 * way back here as a string in `outcome.errMessage`, not the typed
 * `TrelloCircuitOpen` class, so we check the prefix.
 */
function isCircuitOpenMessage(msg: string): boolean {
  return msg.startsWith(CIRCUIT_OPEN_MESSAGE_PREFIX);
}

/**
 * Defer an entry until just past the breaker's `openUntilMs`, without
 * bumping the per-card attempt counter (the breaker is a separate
 * back-pressure axis from the per-card retry budget). Adds the same
 * 0-10% jitter as a normal reschedule so 20 entries blocked on the
 * breaker don't all wake up at the same instant.
 */
function deferEntryForCircuit(
  path: string,
  entry: RetryQueueEntry,
  now: (() => number) | undefined,
): void {
  const nowMs = now?.() ?? Date.now();
  const cooldownEnds = circuitOpenUntilMs();
  // Sanity: if the breaker has already elapsed by the time we get
  // here (raced state), set the wake-up slightly into the future to
  // avoid a busy-loop where the timer fires immediately into another
  // open-state observation.
  const baseTarget = Math.max(cooldownEnds, nowMs + 1_000);
  // Jitter window is anchored on the breaker's INITIAL cooldown (not
  // the per-call remaining-cooldown). Anchoring on remaining-cooldown
  // would collapse jitter for entries that defer LATE in the cooldown
  // (e.g. an entry hitting `circuitIsOpen()` ~1s before the cooldown
  // ends would have `[0, 100ms)` jitter and pile onto the wake-up
  // edge along with every other late entry).
  const jitterMs = Math.floor(
    rng() * BACKOFF_JITTER_FRACTION * CIRCUIT_INITIAL_COOLDOWN_MS,
  );
  const rearmedEntry: RetryQueueEntry = {
    ...entry,
    nextEligibleAt: baseTarget + jitterMs,
  };
  writeFileSync(path, JSON.stringify(rearmedEntry));
  log.info(
    `Retry queue: ${entry.issueId} deferred — Trello circuit open (cooldown ends ${new Date(cooldownEnds).toISOString()})`,
  );
  armTimer(path, rearmedEntry, now);
}

/**
 * Resolve `<repo>/` from the absolute path of a queue entry. Layout is
 * `<repo>/.danxbot/.trello-retry/<file>.json`, so the repo root is two
 * dirs up.
 */
function repoLocalPathFromQueueFile(filePath: string): string {
  return resolve(filePath, "..", "..", "..");
}

async function dropExhausted(
  path: string,
  entry: RetryQueueEntry,
  logger: Logger,
): Promise<void> {
  unlinkIfExists(path);
  const msg = `Retry queue: max attempts (${MAX_ATTEMPTS}) exceeded for ${entry.issueId}; last error: ${entry.lastErr}`;
  logger.error(msg);
  const hookRepoName = entry.repoName ?? "";
  const hook = hookRepoName
    ? systemErrorHookByRepo.get(hookRepoName)
    : undefined;
  if (hook) {
    try {
      await hook(msg);
    } catch (err) {
      logger.warn(
        `Retry queue: recordSystemError hook threw for ${entry.issueId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Boot scan — walk every per-repo queue dir and arm a timer for each
 * persisted entry. Called once from `src/index.ts` after the tracker
 * registry is populated.
 */
export interface BootRescheduleArgs {
  repoLocalPath: string;
  repoName: string;
  issuePrefix: string;
  tracker: IssueTracker;
  recordSystemError?: (message: string) => void | Promise<void>;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
}

export function bootRescheduleRetryQueue(args: BootRescheduleArgs): {
  rearmed: number;
  malformed: number;
} {
  trackersByRepo.set(args.repoName, args.tracker);
  if (args.recordSystemError) {
    systemErrorHookByRepo.set(args.repoName, args.recordSystemError);
  }
  const dir = queueDir(args.repoLocalPath);
  if (!existsSync(dir)) return { rearmed: 0, malformed: 0 };
  let rearmed = 0;
  let malformed = 0;
  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".json")) continue;
    const path = resolve(dir, filename);
    let entry: RetryQueueEntry;
    try {
      const raw = readFileSync(path, "utf-8");
      entry = JSON.parse(raw) as RetryQueueEntry;
      if (
        typeof entry.issueId !== "string" ||
        typeof entry.attempt !== "number" ||
        typeof entry.queuedAt !== "number" ||
        typeof entry.nextEligibleAt !== "number" ||
        typeof entry.lastErr !== "string"
      ) {
        throw new Error("missing required fields");
      }
      // Backfill repo identity for legacy entries written before this
      // schema bump — assume they belong to the boot-scanning repo.
      if (typeof entry.repoName !== "string" || entry.repoName === "") {
        entry.repoName = args.repoName;
      }
      if (typeof entry.issuePrefix !== "string" || entry.issuePrefix === "") {
        entry.issuePrefix = args.issuePrefix;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Retry queue: boot rescan dropping malformed ${filename}: ${msg}`);
      unlinkIfExists(path);
      malformed++;
      continue;
    }
    armTimer(path, entry, args.now);
    rearmed++;
  }
  return { rearmed, malformed };
}

/**
 * Single-entry retry push — invoked by the timer callback when a
 * backoff window expires AND by the manual `drainRetries` flush helper.
 * Re-reads the YAML fresh from disk (per Phase 2 of DX-132: the local
 * YAML is already authoritative when the drain fires; the queue stores
 * only `{issueId}` so the push always sees the latest state), runs
 * `syncIssue`, and on success persists `updatedLocal` if the bytes
 * differ.
 */
type AttemptPushResult =
  | { succeeded: true }
  | { succeeded: false; errMessage: string }
  | { yamlMissing: true }
  | { yamlInvalid: true; errMessage: string };

interface AttemptPushArgs {
  issueId: string;
  repoName: string;
  repoLocalPath: string;
  issuePrefix: string;
  tracker: IssueTracker;
}

async function attemptPush(args: AttemptPushArgs): Promise<AttemptPushResult> {
  const openPath = issuePath(args.repoLocalPath, args.issueId, "open");
  const closedPath = issuePath(args.repoLocalPath, args.issueId, "closed");
  const path = existsSync(openPath)
    ? openPath
    : existsSync(closedPath)
      ? closedPath
      : null;
  if (path === null) {
    return { yamlMissing: true };
  }

  let issue: Issue;
  try {
    issue = parseIssue(readFileSync(path, "utf-8"), {
      expectedPrefix: args.issuePrefix,
    });
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    return { yamlInvalid: true, errMessage: msg };
  }

  const actionItemTitles = loadActionItemTitles(
    args.repoLocalPath,
    issue.retro.action_item_ids,
    args.issuePrefix,
    log,
  );

  try {
    const { updatedLocal } = await syncIssue(args.tracker, issue, {
      actionItemTitles,
    });
    persistIfDifferent(args.repoLocalPath, issue.id, updatedLocal, log);
    // DX-218: stamp the reconcile cache so the NEXT reconcile for this
    // card sees a hit and skips a redundant pushTrelloDiff. Without this,
    // every reconcile after a transient outage would re-fire the push
    // until the synchronous path happened to update the cache itself.
    setLastPushedHash(
      args.repoName,
      issue.id,
      sha256(canonicalize(updatedLocal as unknown as Record<string, unknown>)),
    );
    return { succeeded: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { succeeded: false, errMessage: msg };
  }
}

/**
 * Cancel every armed timer + clear the tracker / hook registries.
 * Tests call this between cases to avoid cross-test timer leaks. Also
 * useful for clean shutdown though the timers are `unref`'d.
 */
export function _resetForTesting(): void {
  for (const timer of armedTimers.values()) clearTimeout(timer);
  armedTimers.clear();
  trackersByRepo.clear();
  systemErrorHookByRepo.clear();
  rng = Math.random;
}

/**
 * Visible for tests — drain every persisted queue entry NOW, regardless
 * of `nextEligibleAt`. Replaces the legacy `drainRetries` callsite (the
 * poller no longer drains per-tick) and gives tests a deterministic
 * `await` point. Returns a result similar to the legacy DrainResult so
 * existing test assertions keep working.
 */
export interface DrainResult {
  attempted: number;
  succeeded: number;
  failed: number;
  exhausted: number;
  yamlMissing: number;
  yamlInvalid: number;
  skipped: number;
  malformed: number;
}

export interface DrainDeps {
  tracker: IssueTracker;
  repoLocalPath: string;
  repoName?: string;
  prefix: string;
  now?: () => number;
  recordSystemError?: (message: string) => void | Promise<void>;
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
 * Manual flush helper. Runs every eligible entry through one push
 * attempt, advancing or unlinking each. Tests use this to assert
 * deterministic drain semantics without needing fake timers.
 *
 * The repoName defaults to a fixture key (`"test-repo"`) when callers
 * omit it — matches the legacy DX-132 tests' single-repo assumption.
 */
export async function drainRetries(deps: DrainDeps): Promise<DrainResult> {
  const dir = queueDir(deps.repoLocalPath);
  if (!existsSync(dir)) return { ...EMPTY_DRAIN_RESULT };

  // DX-302 — toggle gate. drainRetries is the synchronous-flush
  // counterpart to fireRetry's setTimeout path; both must halt when the
  // operator has disabled trelloSync for this repo so no tracker call
  // fires from EITHER drain path. Entries stay on disk so the next
  // enqueue or boot reschedules them when the toggle is re-enabled.
  if (isTrelloSyncOverrideDisabled(deps.repoLocalPath)) {
    log.info(
      `Retry queue: trello sync disabled for repo (${deps.repoName ?? "test-repo"}) — drainRetries returning empty (entries stay on disk)`,
    );
    return { ...EMPTY_DRAIN_RESULT };
  }

  const now = deps.now ?? (() => Date.now());
  const logger = deps.log ?? log;
  const repoName = deps.repoName ?? "test-repo";
  trackersByRepo.set(repoName, deps.tracker);
  if (deps.recordSystemError) {
    systemErrorHookByRepo.set(repoName, deps.recordSystemError);
  }

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
      // Backfill repo identity for legacy entries.
      if (typeof parsed.repoName !== "string" || parsed.repoName === "") {
        parsed.repoName = repoName;
      }
      if (
        typeof parsed.issuePrefix !== "string" ||
        parsed.issuePrefix === ""
      ) {
        parsed.issuePrefix = deps.prefix;
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
      await dropExhausted(path, entry, logger);
      result.exhausted++;
      continue;
    }
    // DX-300: defer past the circuit-breaker cooldown without burning
    // the per-card attempt budget. Mirrors `fireRetry`'s up-front gate
    // so the test-flush path observes identical semantics. The entry
    // is rewritten with a new `nextEligibleAt` so the next drain skips
    // it cleanly until the breaker has recovered.
    if (circuitIsOpen()) {
      deferEntryForCircuit(path, entry, deps.now);
      result.skipped++;
      continue;
    }
    const outcome = await attemptPush({
      issueId: entry.issueId,
      repoName: entry.repoName ?? repoName,
      repoLocalPath: deps.repoLocalPath,
      issuePrefix: entry.issuePrefix ?? deps.prefix,
      tracker: deps.tracker,
    });
    if ("yamlMissing" in outcome) {
      unlinkIfExists(path);
      result.yamlMissing++;
      logger.info(
        `Retry queue: ${entry.issueId} YAML missing on disk — dropping queue entry`,
      );
      continue;
    }
    if ("yamlInvalid" in outcome) {
      unlinkIfExists(path);
      logger.warn(
        `Retry queue: YAML parse failure for ${entry.issueId}, dropping queue entry: ${outcome.errMessage}`,
      );
      result.yamlInvalid++;
      continue;
    }
    // DX-300: race-case (circuit went open mid-syncIssue) → defer
    // without burning the per-card attempt budget AND without bumping
    // `attempted` — the tracker wrapper short-circuited before the
    // outbound HTTP call, so no tracker call was actually issued.
    if (!outcome.succeeded && isCircuitOpenMessage(outcome.errMessage)) {
      deferEntryForCircuit(path, entry, deps.now);
      result.skipped++;
      continue;
    }
    // `attempted` counts only entries that issued a tracker call. yamlMissing
    // / yamlInvalid short-circuited above without one; circuit-open is
    // handled in the branch immediately above. Matches the DX-132
    // semantics the legacy drain promised.
    result.attempted++;
    if (outcome.succeeded) {
      unlinkIfExists(path);
      result.succeeded++;
      logger.info(
        `Retry queue: drained ${entry.issueId} on attempt ${entry.attempt}`,
      );
      continue;
    }
    const newAttempt = entry.attempt + 1;
    if (newAttempt > MAX_ATTEMPTS) {
      const exhaustedEntry: RetryQueueEntry = {
        ...entry,
        attempt: newAttempt,
        lastErr: outcome.errMessage,
      };
      await dropExhausted(path, exhaustedEntry, logger);
      result.exhausted++;
      continue;
    }
    const delayMs = backoffMsForAttempt(newAttempt);
    const rewritten: RetryQueueEntry = {
      ...entry,
      attempt: newAttempt,
      nextEligibleAt: now() + delayMs,
      lastErr: outcome.errMessage,
    };
    writeFileSync(path, JSON.stringify(rewritten));
    result.failed++;
    logger.warn(
      `Retry queue: ${entry.issueId} attempt ${entry.attempt} failed (${outcome.errMessage}); next attempt in ${Math.round(
        delayMs / 1000,
      )}s`,
    );
  }

  return result;
}
