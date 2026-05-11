/**
 * Phases 1, 2, and 3 of the Event-Driven Worker epic
 * (DX-215 / DX-216 / DX-217 / DX-218).
 *
 * `reconcileIssue(repo, id, trigger)` is the chokepoint every entry point
 * (chokidar watcher, dispatch lifecycle, scheduler, cron audit, Trello
 * inbound hydration) calls when a single card's state may have changed.
 * Phase 1 wired the function with steps 1, 2, 4, 5, 6 implemented (load,
 * validate, hash diff, atomic write, await DB mirror). Phase 2 absorbed
 * two poller helpers into step 3 and activated steps 9-10. Phase 3
 * (this commit) lights up step 7 — the outbound tracker push — and
 * retires the per-tick `_poll` mirror that previously did the same job.
 *
 *   - Step 3a: parent-status derive from children (was
 *     `recomputeParentStatuses`).
 *   - Step 3b: file location heal — `open/` ↔ `closed/` move based on
 *     terminal/non-terminal status (was `healLocalYamls`). (The earlier
 *     step 3b `waiting_on` auto-clear was REMOVED — see
 *     `src/issue/effective-waiting-on.ts` for why `waiting_on` is now
 *     a durable record, derived effectively at read time.)
 *   - Step 7 (Phase 3): outbound tracker push via `pushTrelloDiff` from
 *     `./reconcile/trello.ts`. The push is FIFO-serialized per card by
 *     the trello module's own slot map; reconcile schedules but does
 *     not await on `watcher` / `audit` / `hydrate` triggers (return-
 *     before-network-roundtrip). The `lifecycle` trigger (used by
 *     `auto-sync.ts` after `danxbot_complete`) DOES await so the
 *     dashboard sees terminal tracker state by the time the agent
 *     process exits.
 *   - Step 9: recurse on `parent_id` after a mutating write so the
 *     parent's reconcile re-derives its own status from the new union.
 *   - Step 10: recurse on dependents (every card with
 *     `waiting_on.by[]` containing this id) so dep-chain unblocks
 *     propagate immediately.
 *
 * The pure decision helpers live next door under
 * `src/issue/reconcile/{parent,heal}.ts` so they're testable
 * with hand-built fixtures (no fs, no DB). The orchestrator below does
 * the IO, calls the pure helpers, and writes the result.
 *
 * Per-card mutex serialization: a module-scoped
 * `Map<repoName-id, Promise<unknown>>` chains every reconcile body for
 * the same `(repo, id)` pair onto the previous one's resolution. New
 * triggers for the SAME id queue; reconciles for DIFFERENT ids run in
 * parallel. Callers see only their own returned Promise — the mutex is
 * private bookkeeping. Rejection of one body never blocks the next: the
 * map stores a swallowed-rejection version so the chain continues past
 * a thrown error.
 *
 * Recursion: steps 9 + 10 schedule reconciles for the parent + every
 * dependent. Cycles are bounded by an explicit visited set (`Set<id>`)
 * threaded through the internal context, plus a hard depth cap
 * (`MAX_RECURSION_DEPTH = 5`). Either guard is sufficient — both are in
 * place because the cost of a redundant guard is one Set lookup and the
 * cost of a missed guard is a runaway cascade in production.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { getMirrorByLocalPath } from "../db/issues-mirror.js";
import {
  appendHistory,
  parseIssue,
  serializeIssue,
  IssueParseError,
} from "../issue-tracker/yaml.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import {
  dbListChildrenByParent,
  dbListDependentsByWaitingOnId,
} from "../poller/issues-db.js";
import { repoNameFromPath } from "../poller/repo-name.js";
import type {
  Issue,
  IssueHistoryEntry,
} from "../issue-tracker/interface.js";
import {
  applyParentDeriveMutation,
  deriveParentStatus,
} from "./reconcile/parent.js";
import { decideFileMove, type IssueBucket } from "./reconcile/heal.js";
import {
  ReconcileValidationError,
  type ReconcileError,
  type ReconcileFanout,
  type ReconcileResult,
  type ReconcileTrigger,
} from "./reconcile-types.js";
import { pushTrelloDiff } from "./reconcile/trello.js";
import type { IssueTracker } from "../issue-tracker/interface.js";
import { createLogger } from "../logger.js";

const log = createLogger("reconcile");

const RECONCILE_AWAIT_MIRROR_TIMEOUT_MS = 5_000;

/**
 * Recursion depth cap. Reconciles triggered transitively from steps 9 +
 * 10 (parent + dependents) carry an incremented depth counter; once the
 * counter hits this constant the chain stops fanning out. Combined with
 * the per-call visited set, either guard is sufficient — both are in
 * place because cycle hazards in production are far more expensive than
 * a redundant runtime check.
 */
const MAX_RECURSION_DEPTH = 5;

/**
 * Minimum context shape consumed by `reconcileIssue`. Subset of
 * `RepoContext` so callers can pass either the full context or a
 * lightweight test stub. Only the identity + filesystem fields are
 * referenced — the function is otherwise pure relative to the repo.
 */
export interface ReconcileRepoContext {
  /** Repo name; used for mutex keying + DB mirror lookups. */
  name: string;
  /** Absolute path to the connected repo's worktree. */
  localPath: string;
  /** Per-repo issue-id prefix (e.g. `"DX"` or `"ISS"`). */
  issuePrefix: string;
}

interface RecursionContext {
  /** Ids already reconciled in this trigger's transitive chain. */
  visited: Set<string>;
  /** Distance from the original (operator-facing) trigger. */
  depth: number;
}

const mutexes = new Map<string, Promise<unknown>>();

function mutexKey(repoName: string, id: string): string {
  return `${repoName} ${id}`;
}

/**
 * Per-repo IssueTracker registry — populated once at worker boot from
 * `src/index.ts` so reconcile step 7 can resolve the tracker without
 * threading it through every callsite. Production has one tracker per
 * worker process (the worker is single-repo); the map shape supports
 * future multi-repo dashboards.
 *
 * Tests register their own tracker via `setReconcileTrackerForRepo`
 * (typically a `MemoryTracker`). When no tracker is registered for a
 * given repo, step 7 silently skips — fail-safe for tests that exercise
 * derived-state mutation but don't care about the outbound tracker push.
 */
const trackersByRepo = new Map<string, IssueTracker>();

export function setReconcileTrackerForRepo(
  repoName: string,
  tracker: IssueTracker,
): void {
  trackersByRepo.set(repoName, tracker);
}

export function clearReconcileTrackerForRepo(repoName: string): void {
  trackersByRepo.delete(repoName);
}

/**
 * Per-repo `recordSystemError` hook — same registration pattern as the
 * tracker registry. The hook fires from inside the trello push path
 * when the retry queue exhausts max attempts (see
 * `src/issue-tracker/retry-queue.ts#dropExhausted`).
 */
const systemErrorHooksByRepo = new Map<
  string,
  (message: string) => void | Promise<void>
>();

export function setReconcileSystemErrorHookForRepo(
  repoName: string,
  hook: (message: string) => void | Promise<void>,
): void {
  systemErrorHooksByRepo.set(repoName, hook);
}

export function clearReconcileSystemErrorHookForRepo(repoName: string): void {
  systemErrorHooksByRepo.delete(repoName);
}

/**
 * Per-card cache of "what hash did we last push to the tracker?". When
 * the on-disk hash matches the cached value, step 7 skips the push
 * entirely — saves one `tracker.getCard` round-trip per no-op chokidar
 * fire.
 *
 * Cold cache (first reconcile after worker boot) → first push always
 * fires; idempotent at the tracker layer (`syncIssue` returns 0 writes
 * when nothing differs). Subsequent reconciles short-circuit until the
 * agent edits the YAML again.
 *
 * Updated AFTER a successful push (no errors). On error the cache stays
 * stale, so the next reconcile retries the push too — belt-and-
 * suspenders against a dropped retry-queue entry.
 */
// DX-218 Phase 3: cache moved to its own module so retry-queue.ts can
// also write to it after a successful timer-armed retry, without
// closing a circular import chain (reconcile → trello → retry-queue →
// would-be reconcile).
import {
  getLastPushedHash as cacheGet,
  setLastPushedHash as cacheSet,
  _resetPushHashCache,
} from "./reconcile/push-hash-cache.js";

/** Visible for tests — read the cache. */
export function _getLastPushedHash(
  repoName: string,
  id: string,
): string | undefined {
  return cacheGet(repoName, id);
}

/** Visible for tests — clear the cache between cases. */
export function _resetLastPushedHashes(): void {
  _resetPushHashCache();
}

/**
 * Run `fn` while holding the per-key mutex. Concurrent calls for the
 * same key queue. A rejected `fn` does NOT block the next caller — the
 * map tail catches and swallows the rejection so the chain stays alive.
 * Visible for tests that need to verify queue order.
 */
function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail: Promise<unknown> = next.catch(() => undefined);
  mutexes.set(key, tail);
  void tail.then(() => {
    if (mutexes.get(key) === tail) mutexes.delete(key);
  });
  return next;
}

/** Visible for tests — observe whether a mutex entry is currently held. */
export function _hasReconcileMutex(repoName: string, id: string): boolean {
  return mutexes.has(mutexKey(repoName, id));
}

interface LoadedYaml {
  /** Absolute path the file was read from (`open/<id>.yml` or `closed/<id>.yml`). */
  path: string;
  /** `"open"` or `"closed"` — the bucket the file currently lives in. */
  bucket: IssueBucket;
  /** Raw file text. */
  text: string;
  /** Parsed YAML object (untyped — `parseIssue` later validates the shape). */
  parsed: Record<string, unknown>;
}

/**
 * Locate `<repo>/.danxbot/issues/{open,closed}/<id>.yml` and return its
 * contents. `null` when the file is gone (tombstone). Throws
 * `ReconcileValidationError` when the YAML is non-parseable or non-object.
 *
 * "Open wins" tie-breaker: when both `open/<id>.yml` and `closed/<id>.yml`
 * exist (operator manually re-opened a Done card), reconcile reads from
 * `open/`. Same semantics as `moveToClosedIfTerminal` already enforces.
 */
function loadYaml(
  repoLocalPath: string,
  id: string,
): LoadedYaml | null {
  const openPath = issuePath(repoLocalPath, id, "open");
  const closedPath = issuePath(repoLocalPath, id, "closed");
  let path: string | null = null;
  let bucket: IssueBucket = "open";
  if (existsSync(openPath)) {
    path = openPath;
    bucket = "open";
  } else if (existsSync(closedPath)) {
    path = closedPath;
    bucket = "closed";
  }
  if (path === null) return null;
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYamlText(text);
  } catch (err) {
    throw new ReconcileValidationError(
      `Malformed YAML at ${path}: ${(err as Error).message}`,
      { id, path },
    );
  }
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new ReconcileValidationError(
      `Non-object YAML at ${path}`,
      { id, path },
    );
  }
  return { path, bucket, text, parsed: parsed as Record<string, unknown> };
}

function emptyFanout(): ReconcileFanout {
  return {
    parentId: null,
    dependents: [],
    dispatchableChanged: false,
  };
}

/**
 * Tombstone result: file is gone. Returns a no-op result; the parent /
 * dependents fanout cannot run because we have no Issue payload to read
 * `parent_id` from. Step 9-10 fanout for tombstones is a Phase 4
 * concern (the dispatch scheduler may want to react when a card
 * disappears mid-flight).
 */
function tombstoneResult(): ReconcileResult {
  return {
    changed: false,
    prevHash: null,
    nextHash: "",
    errors: [],
    fanout: emptyFanout(),
  };
}

/**
 * Apply the heal-direction history entry produced by `decideFileMove`.
 * The pure helper leaves `timestamp: ""` so the orchestrator can stamp
 * the write-time clock; we fill it in here.
 */
function applyHealHistory(
  issue: Issue,
  entry: IssueHistoryEntry,
  now: string,
): Issue {
  return {
    ...issue,
    history: appendHistory(issue.history, { ...entry, timestamp: now }),
  };
}

async function reconcileBody(
  repo: ReconcileRepoContext,
  id: string,
  trigger: ReconcileTrigger,
  rec: RecursionContext,
): Promise<ReconcileResult> {
  // ---- Step 1: load YAML / detect tombstone ----
  const loaded = loadYaml(repo.localPath, id);
  if (loaded === null) {
    log.debug(`[${repo.name}] ${id}: tombstone (trigger=${trigger})`);
    return tombstoneResult();
  }

  // ---- Step 2: validate Issue shape ----
  let issue: Issue;
  try {
    issue = parseIssue(loaded.text, { expectedPrefix: repo.issuePrefix });
  } catch (err) {
    if (err instanceof IssueParseError) {
      throw new ReconcileValidationError(
        `Issue validation failed at ${loaded.path}: ${err.message}`,
        { id, path: loaded.path },
      );
    }
    throw err;
  }

  // The on-disk hash matches what the watcher computes when it mirrors
  // this same file: `sha256(canonicalize(parseYamlText(text)))`.
  const prevHash = sha256(canonicalize(loaded.parsed));
  const repoName = repoNameFromPath(repo.localPath);
  const errors: ReconcileError[] = [];

  // ---- Step 3: compute derived state ----
  let mutated: Issue = issue;
  let mutatedFlag = false;
  const now = new Date().toISOString();

  // 3a. Parent-derive — only when this card has children AND is not
  // itself queued behind other work. The waiting_on guard mirrors the
  // legacy `recomputeParentStatuses` skip (worker forces waiting-on
  // parents to ToDo, deriving over them would churn IO).
  if (mutated.children.length > 0 && mutated.waiting_on === null) {
    const children = await dbListChildrenByParent(repoName, mutated.id);
    if (children.length > 0) {
      const derived = deriveParentStatus(children);
      if (derived !== null && derived.status !== mutated.status) {
        mutated = applyParentDeriveMutation(mutated, derived, now);
        mutatedFlag = true;
      }
    }
  }

  // 3b. File location heal — terminal status in `open/` moves to
  // `closed/`; non-terminal status in `closed/` moves to `open/` AND
  // appends a `worker:heal` history entry (real state delta).
  const fileMove = decideFileMove(mutated, loaded.bucket);
  if (fileMove !== null && fileMove.healEntry !== null) {
    mutated = applyHealHistory(mutated, fileMove.healEntry, now);
    mutatedFlag = true;
  }
  const targetBucket: IssueBucket = fileMove?.targetDir ?? loaded.bucket;
  const bucketChanged = targetBucket !== loaded.bucket;

  // ---- Step 4: diff vs prior canonical ----
  // Even when step 3 detected no derived-state mutation, the on-disk
  // YAML may have changed since this worker last pushed to the tracker
  // (the agent's own `Edit` call fired chokidar → reconcile). Step 7
  // below decides independently whether to push by comparing the
  // current hash to the per-card lastPushedHash cache. Step 5 (write)
  // and step 9-10 (recurse) still gate on `mutatedFlag || bucketChanged`
  // because writing identical bytes is a no-op and recursing on
  // identical state is wasted work.

  // ---- Step 5: atomic write YAML + bucket move ----
  // Pure-bucket-move (terminal status with no content delta) writes the
  // existing serialized body to the target dir; mutated cards re-
  // serialize. Either way, after the write we unlink the previous
  // location if it differs from the target.
  const reconcileMutated = mutatedFlag || bucketChanged;
  const nextSerialized = mutatedFlag ? serializeIssue(mutated) : loaded.text;
  if (reconcileMutated) {
    ensureIssuesDirs(repo.localPath);
    const targetPath = issuePath(repo.localPath, mutated.id, targetBucket);
    writeFileSync(targetPath, nextSerialized);
    if (resolve(targetPath) !== resolve(loaded.path)) {
      try {
        unlinkSync(loaded.path);
      } catch (err) {
        errors.push({
          step: "bucket-move",
          message: `Failed to unlink ${loaded.path}: ${(err as Error).message}`,
          fatal: false,
        });
      }
    }
  }

  // The next-hash MUST match what the watcher computes when it observes
  // this write — same recipe as `prevHash`: parse the on-disk text,
  // canonicalize, sha256. When step 5 didn't write, the hash is
  // identical to prevHash.
  const nextHash = reconcileMutated
    ? sha256(
        canonicalize(parseYamlText(nextSerialized) as Record<string, unknown>),
      )
    : prevHash;

  // ---- Step 6: await DB mirror upsert ----
  // Only when step 5 wrote. A no-op reconcile already saw the watcher
  // upsert (it's the trigger that called us); awaiting again would
  // wait on an upsert that already happened.
  if (reconcileMutated) {
    const mirror = getMirrorByLocalPath(repo.localPath);
    if (mirror) {
      try {
        await mirror.awaitMirror(repo.name, id, nextHash, {
          timeoutMs: RECONCILE_AWAIT_MIRROR_TIMEOUT_MS,
        });
      } catch (err) {
        errors.push({
          step: "await-mirror",
          message: (err as Error).message,
          fatal: false,
        });
      }
    }
  }

  // ---- Step 7: outbound tracker push ----
  // Push to the tracker when the on-disk hash differs from what we last
  // pushed for this card. Cold cache (worker just booted) → first push
  // always fires; idempotent at the tracker layer (`syncIssue` issues
  // 0 mutating calls when nothing differs).
  //
  // Trigger semantics:
  //   - `lifecycle` (auto-sync from `danxbot_complete`) AWAITS the push
  //     so the dashboard sees terminal tracker state by the time the
  //     agent process exits.
  //   - Every other trigger schedules the push on the per-card slot
  //     and returns. The slot enforces FIFO order across concurrent
  //     reconciles for the same card without holding reconcile's
  //     mutex during the network round-trip.
  const tracker = trackersByRepo.get(repo.name);
  const lastPushed = cacheGet(repo.name, id);
  if (tracker && lastPushed !== nextHash) {
    const recordSystemError = systemErrorHooksByRepo.get(repo.name);
    const pushPromise = pushTrelloDiff({
      issue: mutated,
      repoName: repo.name,
      repoLocalPath: repo.localPath,
      issuePrefix: repo.issuePrefix,
      tracker,
      ...(recordSystemError && { deps: { recordSystemError } }),
    }).then((pushResult) => {
      // Only update the lastPushedHash cache when the push fully
      // succeeded (no errors). On error the retry queue takes over;
      // leaving the cache stale ensures the next reconcile retries the
      // push too — belt-and-suspenders against a dropped queue entry.
      if (pushResult.errors.length === 0) {
        cacheSet(repo.name, id, nextHash);
      }
      return pushResult;
    });
    if (trigger === "lifecycle") {
      try {
        const pushResult = await pushPromise;
        for (const e of pushResult.errors) {
          errors.push({
            step: `tracker-push:${e.step}`,
            message: e.message,
            fatal: false,
          });
        }
      } catch (err) {
        errors.push({
          step: "tracker-push",
          message: (err as Error).message,
          fatal: false,
        });
      }
    } else {
      // Non-lifecycle: don't await. Attach a tail-catch so an
      // unawaited rejection doesn't surface as `UnhandledPromiseRejection`.
      void pushPromise.catch((err) => {
        log.warn(
          `[${repo.name}] ${id} async tracker push rejected: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  // ---- Step 8: scheduler poke (Phase 4) ----
  // `dispatchableChanged` stays `false` until Phase 4 wires the picker.

  // ---- Steps 9 + 10: parent + dependents fanout ----
  // Only fanout when reconcile actually mutated state. A no-op
  // reconcile (chokidar fired but step 3 found nothing to derive)
  // means the upstream agent edit has already triggered its own
  // chokidar event chain — recursing again would double-process.
  // The early-return semantics from Phase 1 are preserved here for
  // the fanout decision; only step 7 (tracker push) is hash-driven.
  let parentRecursed: string | null = null;
  let dependents: string[] = [];
  if (reconcileMutated) {
    if (mutated.parent_id) {
      parentRecursed = mutated.parent_id;
      if (
        rec.depth < MAX_RECURSION_DEPTH &&
        !rec.visited.has(parentRecursed)
      ) {
        const childVisited = new Set(rec.visited);
        childVisited.add(id);
        try {
          await reconcileWithContext(repo, parentRecursed, "watcher", {
            visited: childVisited,
            depth: rec.depth + 1,
          });
        } catch (err) {
          errors.push({
            step: "recurse-parent",
            message: `Parent reconcile (${parentRecursed}) failed: ${(err as Error).message}`,
            fatal: false,
          });
        }
      }
    }

    try {
      const depRows = await dbListDependentsByWaitingOnId(repoName, id);
      dependents = depRows.map((d) => d.id);
    } catch (err) {
      errors.push({
        step: "fetch-dependents",
        message: `Failed to look up dependents of ${id}: ${(err as Error).message}`,
        fatal: false,
      });
    }
    const stepTenVisited = new Set(rec.visited);
    stepTenVisited.add(id);
    if (parentRecursed !== null) stepTenVisited.add(parentRecursed);
    for (const depId of dependents) {
      if (rec.depth >= MAX_RECURSION_DEPTH) break;
      if (stepTenVisited.has(depId)) continue;
      try {
        await reconcileWithContext(repo, depId, "watcher", {
          visited: new Set(stepTenVisited),
          depth: rec.depth + 1,
        });
      } catch (err) {
        errors.push({
          step: "recurse-dependents",
          message: `Dependent reconcile (${depId}) failed: ${(err as Error).message}`,
          fatal: false,
        });
      }
      stepTenVisited.add(depId);
    }
  }

  return {
    changed: reconcileMutated,
    prevHash,
    nextHash,
    errors,
    fanout: {
      parentId: parentRecursed,
      dependents,
      dispatchableChanged: false,
    },
  };
}

function reconcileWithContext(
  repo: ReconcileRepoContext,
  id: string,
  trigger: ReconcileTrigger,
  rec: RecursionContext,
): Promise<ReconcileResult> {
  return withMutex(mutexKey(repo.name, id), () =>
    reconcileBody(repo, id, trigger, rec),
  );
}

/**
 * Reconcile the on-disk YAML for a single card. See module header for
 * the full contract. The mutex guarantees per-`(repo, id)` serialization:
 * concurrent triggers for the same id queue; different ids run in
 * parallel.
 *
 * Errors:
 *  - `ReconcileValidationError` — the YAML on disk does not parse OR
 *    fails the strict `Issue` validator. Callers MUST decide whether
 *    to surface (chokidar wiring → `recordSystemError`) or propagate
 *    (lifecycle / scheduler / audit / hydrate triggers).
 *  - Any other error — system fault (fs, mirror, future tracker push).
 *    Propagated to the caller; non-watcher triggers re-throw, watcher
 *    wiring records via `recordSystemError`.
 */
export function reconcileIssue(
  repo: ReconcileRepoContext,
  id: string,
  trigger: ReconcileTrigger,
): Promise<ReconcileResult> {
  return reconcileWithContext(repo, id, trigger, {
    visited: new Set<string>(),
    depth: 0,
  });
}

/** Visible for tests — drain the mutex map between cases. */
export function _resetReconcileMutexes(): void {
  mutexes.clear();
}

/** Visible for tests — recursion depth cap (read-only). */
export const _MAX_RECURSION_DEPTH = MAX_RECURSION_DEPTH;
