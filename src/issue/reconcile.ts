/**
 * Phases 1, 2, 3, and 4b.1 of the Event-Driven Worker epic
 * (DX-215 / DX-216 / DX-217 / DX-218 / DX-288).
 *
 * `reconcileIssue(repo, id, trigger)` is the chokepoint every entry point
 * (chokidar watcher, dispatch lifecycle, scheduler, cron audit, Trello
 * inbound hydration) calls when a single card's state may have changed.
 * Phase 1 wired the function with steps 1, 2, 4, 5, 6 implemented (load,
 * validate, hash diff, atomic write, await DB mirror). Phase 2 absorbed
 * two poller helpers into step 3 and activated steps 9-10. Phase 3 lit
 * up step 7 — the outbound tracker push — and retired the per-tick
 * `runSync` mirror. Phase 4b.1 (this commit / DX-288) lights up step 8 —
 * `fanout.dispatchableChanged` computed via a per-card cache diff, and
 * a per-repo scheduler hook fired AFTER the per-card mutex resolves so
 * the dispatch picker can react to reconcile-observed state flips
 * without waiting for the next `runSync` tick.
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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import {
  appendHistory,
  parseIssue,
  serializeIssue,
  IssueParseError,
} from "../issue-tracker/yaml.js";
import { getEnvGen } from "./env-generation.js";
import { issuePath } from "../issue-tracker/paths.js";
import {
  writeIssue,
  moveToClosedIfTerminal,
} from "../poller/yaml-lifecycle.js";
import {
  dbListChildrenByParent,
  dbListDependentsByWaitingOnId,
} from "../poller/issues-db.js";
import { repoNameFromPath } from "../poller/repo-name.js";
import { deriveStatus } from "./derive-status.js";
import type { Issue, IssueHistoryEntry } from "../issue-tracker/interface.js";
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
import {
  armTriageTimer,
  clearTriageTimer,
  parseTriageExpiresAtMs,
} from "../dispatch/triage-timer.js";
import type { IssueTracker } from "../issue-tracker/interface.js";
import { createLogger } from "../logger.js";
import { isTrelloSyncOverrideDisabled } from "../settings-file.js";
import { checkYamlDispatchLiveness } from "../poller/dispatch-liveness-yaml.js";
import { isPidAlive } from "../agent/host-pid.js";
import { hostname as osHostname } from "node:os";
import {
  deriveListTypeFromSemanticStatus,
  resolveListNameForType,
} from "./list-resolve.js";

// Stable for the lifetime of the worker process — hoist out of the
// per-reconcile body so 3d's liveness check doesn't repeat the syscall
// once per audit-pass card.
const HOST_NAME = osHostname();

const log = createLogger("reconcile");

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
 * (typically the test stub). When no tracker is registered for a given
 * repo, step 7 silently skips — fail-safe for tests that exercise
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

/**
 * Per-card cache of dispatch-eligibility — `<repoName>-<id>` → boolean
 * (DX-288 / Phase 4b.1 of the Event-Driven Worker epic).
 *
 * The cache lets each reconcile compute `fanout.dispatchableChanged` by
 * diffing the post-reconcile dispatch-eligibility against the prior
 * observation. Dispatch-eligibility is the same predicate the poller's
 * `listDispatchableYamls` enforces: `status === "ToDo" && blocked ===
 * null && waiting_on === null && requires_human === null && dispatch
 * === null`.
 *
 * Semantics:
 *   - First observation of an `(repoName, id)` pair: `dispatchableChanged`
 *     equals the current dispatch-eligibility. Newly-visible dispatchable
 *     cards poke the scheduler; newly-visible non-dispatchable cards do
 *     not (nothing for the picker to do).
 *   - Subsequent observations: `dispatchableChanged = current !== prior`.
 *   - Tombstone (file deleted): cache entry cleared. A subsequent
 *     re-creation triggers a fresh first-observation.
 *
 * Cold cache (worker boot) sees every card on its first reconcile and
 * pokes the scheduler for each currently-dispatchable card — equivalent
 * to a one-time boot rehydrate of the picker's dispatchable set.
 */
const dispatchableByCardId = new Map<string, boolean>();

function dispatchableKey(repoName: string, id: string): string {
  return `${repoName}-${id}`;
}

function isCardDispatchable(issue: Issue): boolean {
  // DX-584 (Phase 4) — derived semantic state, mirror of the poller's
  // `listDispatchableYamls` filter. A card whose timestamps say "Done"
  // / "Cancelled" / "Blocked" must NOT be dispatchable regardless of
  // any stale raw `status` field.
  return (
    deriveStatus(issue) === "ToDo" &&
    issue.blocked === null &&
    issue.waiting_on === null &&
    issue.requires_human === null &&
    issue.dispatch === null
  );
}

/** Visible for tests — drain the dispatchability cache between cases. */
export function _resetDispatchableCache(): void {
  dispatchableByCardId.clear();
}

/**
 * Per-card cache of last-observed `triage.expires_at` — `<repoName>-<id>`
 * → string (DX-289 / Phase 4b.2). Same per-card-key shape as
 * `dispatchableByCardId`, but the stored value is the prior raw string
 * (not a boolean) so reconcile can detect "new value written by the
 * triage agent" via plain string-equality. Cache miss = first
 * observation; always arms with the current value.
 */
const triageExpiresAtByCardId = new Map<string, string>();

function triageExpiresAtKey(repoName: string, id: string): string {
  return `${repoName}-${id}`;
}

/** Visible for tests — drain the triage-expires cache between cases. */
export function _resetTriageExpiresCache(): void {
  triageExpiresAtByCardId.clear();
}

/**
 * Per-repo scheduler hook registry — populated by `src/index.ts` at
 * worker boot so reconcile can poke the dispatch scheduler when a
 * card's dispatch-eligibility changes. Identical registration shape
 * to `trackersByRepo` and `systemErrorHooksByRepo` above so the three
 * extension points are read the same way.
 *
 * Production wires `scheduler.onReconcileResult` here. Tests register
 * their own spy hook. When no hook is registered for a repo, reconcile
 * silently skips the poke — fail-safe for tests that exercise the
 * derivation path but don't care about the scheduler edge.
 */
type ReconcileSchedulerHook = (args: {
  repo: ReconcileRepoContext;
  result: ReconcileResult;
}) => void;

const schedulerHooksByRepo = new Map<string, ReconcileSchedulerHook>();

export function setReconcileSchedulerHookForRepo(
  repoName: string,
  hook: ReconcileSchedulerHook,
): void {
  schedulerHooksByRepo.set(repoName, hook);
}

export function clearReconcileSchedulerHookForRepo(repoName: string): void {
  schedulerHooksByRepo.delete(repoName);
}

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
 * Per-card `(hash, envGen)` skip-cache — `<repoName>-<id>` →
 * `{lastReconciledHash, lastReconciledEnvGen}` (DX-640 / Phase 2 of
 * the Computed Card State epic, DX-638).
 *
 * The pure-projection reconcile body produces `desired =
 * deriveAll(observed, env)`. When both inputs are unchanged since
 * the previous reconcile, `desired === observed`, the action set is
 * empty, and the body is a no-op modulo cache bookkeeping.
 *
 * Hash = `sha256(canonicalize(parseYamlText(text)))` — the same recipe
 * the chokidar mirror uses, so a YAML byte-stable re-write does NOT
 * invalidate the cache.
 *
 * envGen = per-repo monotonic counter (see `env-generation.ts`).
 * Bumped on every environment-level write that can move `desired`:
 * `lists.yaml`, `children[]` / `parent_id` of OTHER cards (via the
 * `writeIssue` path), the `agents{}` map in `settings.json`. Bumping
 * invalidates EVERY card's skip-cache entry on its next reconcile —
 * cheap, since cards whose `desired` truly didn't move will re-derive
 * once and re-cache.
 *
 * Recursion bypass: when a reconcile fires via step 9/10 recursion
 * (rec.depth > 0), the cache is BYPASSED on entry. The whole point of
 * the recursion is "downstream state changed"; the parent's own hash
 * may be unchanged but its derived state needs re-evaluation against
 * the freshly-mutated child. The cache update at end-of-body still
 * stamps the latest (hash, envGen) so a subsequent top-level reconcile
 * can short-circuit if no environment input has moved.
 *
 * Tombstone clears the cache entry (mirrors the dispatchability +
 * triage caches).
 */
interface SkipCacheEntry {
  hash: string;
  envGen: number;
}

const skipCacheByCardId = new Map<string, SkipCacheEntry>();

function skipCacheKey(repoName: string, id: string): string {
  return `${repoName}-${id}`;
}

/** Visible for tests — read the cache. */
export function _getSkipCacheEntry(
  repoName: string,
  id: string,
): SkipCacheEntry | undefined {
  return skipCacheByCardId.get(skipCacheKey(repoName, id));
}

/** Visible for tests — drain the cache between cases. */
export function _resetSkipCache(): void {
  skipCacheByCardId.clear();
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
function loadYaml(repoLocalPath: string, id: string): LoadedYaml | null {
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
    throw new ReconcileValidationError(`Non-object YAML at ${path}`, {
      id,
      path,
    });
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
    // Clear the dispatchability cache so a future re-creation of this
    // id triggers a fresh first-observation poke. Keeping the stale
    // entry would make a subsequent re-create observe `priorDispatchable
    // === currentDispatchable` and skip the scheduler poke even though
    // the card is brand new from the scheduler's POV.
    dispatchableByCardId.delete(dispatchableKey(repo.name, id));
    // Phase 4b.2 (DX-289). Tombstone clears any armed triage timer —
    // a fire would call reconcileIssue against a missing file and
    // tombstone again with no work to do. The cache entry is dropped
    // so a future re-creation of this id triggers a fresh first-
    // observation arm via the cache-miss branch in step 7b below.
    clearTriageTimer(repo.name, id);
    triageExpiresAtByCardId.delete(triageExpiresAtKey(repo.name, id));
    // DX-640 — tombstone clears the skip-cache so a future re-creation
    // of this id triggers a full re-derive (the body should not skip
    // against a hash from before the file disappeared).
    skipCacheByCardId.delete(skipCacheKey(repo.name, id));
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

  // ---- Step 2b: skip-cache fast-path (DX-640) ----
  // Pure-projection invariant: `desired = deriveAll(observed, env)`.
  // When `observed` (= prevHash) AND `env` (= envGen) are both unchanged
  // since the last reconcile of this card, the body would re-derive the
  // same `desired` and produce zero actions. Short-circuit.
  //
  // Recursion bypass: step 9/10 recursion fires precisely when downstream
  // state changed (a child / dependent's reconcile mutated something).
  // The parent / dependent's own hash may not have moved, but its
  // derived-from-children state needs re-evaluation. Force the body
  // to run by skipping the cache check on rec.depth > 0.
  const currentEnvGen = getEnvGen(repoName);
  if (rec.depth === 0) {
    const cacheKey = skipCacheKey(repo.name, id);
    const cached = skipCacheByCardId.get(cacheKey);
    if (
      cached !== undefined &&
      cached.hash === prevHash &&
      cached.envGen === currentEnvGen
    ) {
      log.debug(
        `[${repo.name}] ${id}: skip-cache hit (hash=${prevHash.slice(0, 8)}, envGen=${currentEnvGen}, trigger=${trigger})`,
      );
      // Zero actions = zero side effects. The dispatchability +
      // triage caches are already stamped from the previous reconcile
      // that populated this skip-cache entry; they hold the correct
      // values for the unchanged inputs.
      //
      // fanout.parentId intentionally `null` here even though the
      // card may have a non-null `parent_id` — fanout describes the
      // ACTIONS this reconcile would take, and a skip emits zero
      // recursion. The only current consumer of `fanout.parentId`
      // is the observability surface (logs / metrics); the picker
      // reads `dispatchableChanged` only. Revisit if a downstream
      // grows a cache-keyed lookup off `parentId`.
      return {
        changed: false,
        prevHash,
        nextHash: prevHash,
        errors: [],
        fanout: {
          parentId: null,
          dependents: [],
          dispatchableChanged: false,
        },
      };
    }
  }

  // ---- Step 3: derive desired state from (observed, env) ----
  // Pure-projection seam — every step that produces an `actions` entry
  // gates its mutation on a strict (observed != desired) check, so a
  // steady-state re-derive emits ZERO history entries / writes /
  // recursion. Phase 3 / DX-641 extends this slot with new heal steps;
  // the contract that `applyHealHistory` only fires on real semantic
  // deltas (not steady-state projection re-affirm) is enforced inside
  // each gate below.
  //
  // Sub-step ordering:
  //   3g — epic-lifecycle reset (clears stale Epic completion / cancel
  //        / blocked / dispatch when any child is non-terminal). Runs
  //        FIRST so subsequent sub-steps observe the cleaned state.
  //   3d — orphan dispatch heal (clears `dispatch` when the PID /
  //        TTL says the dispatch is dead). Runs early because clearing
  //        `dispatch` flips derived status (rule 4) which feeds the
  //        parent-derive.
  //   3e — invariant heal (shape re-assert). Today: clear
  //        `assigned_agent` on derived-Blocked cards (the picker's
  //        resume-owned-card path would pin the agent forever).
  //        `waiting_on` / `conflict_on[]` / `requires_human` shape
  //        invariants are enforced by the parse-time validator; the
  //        no-clobber path here protects in-flight `conflict_on[]`
  //        partner stamps from accidental mutation.
  //   3a — parent-derive (from children's union). Runs after the heals
  //        so it observes consistent derived-status inputs.
  //   3b — file location heal (open ↔ closed).
  //   3c — list_name audit (projection re-affirm; ZERO history).
  //   3f — triage TTL refresh (scheduler poke; ZERO YAML write).
  let mutated: Issue = issue;
  let mutatedFlag = false;
  const now = new Date().toISOString();

  // Shared children lookup — 3g (Epic-lifecycle reset gate) AND 3a
  // (parent-derive) both read the same row set keyed by `(repoName,
  // mutated.id)`. Hoisting the fetch above 3g halves the DB round-trip
  // count for every Epic with children that fires the audit pass.
  // Fetched ONLY when this card has children (the only sub-steps that
  // consume the result both gate on children.length > 0 — see 3g + 3a
  // bodies below). Cards with empty children skip the query.
  let childrenForDerive: Issue[] | null = null;
  if (mutated.children.length > 0) {
    childrenForDerive = await dbListChildrenByParent(repoName, mutated.id);
  }

  // 3g. Epic-lifecycle reset (DX-641).
  //
  // When an Epic carries any of {completed_at, cancelled_at, blocked,
  // dispatch} populated AND any child is non-terminal, the trigger is
  // stale and the epic must return to the ready ladder. Two regression
  // classes are covered:
  //
  //   (a) DX-576 / DX-580 — an agent erroneously called
  //       `danxbot_complete({status: "completed"})` on an Epic whose
  //       children were still non-terminal; the worker stamped
  //       `completed_at` and the epic stuck at derived `Done` while
  //       children kept advancing. Pre-DX-641 reconcile then flipped
  //       between Done (from `completed_at`) and the children's union
  //       status (from parent-derive) every tick — ~250 history entries
  //       in 3 minutes.
  //   (b) Epic-conversion — an operator/agent flipped `type: Epic`
  //       mid-life-cycle without clearing residual triggers
  //       (`dispatch` from the prior Feature life cycle, `ready_at`
  //       from a past pickup). The conversion places the card back on
  //       the ready ladder; residual triggers must clear.
  //
  // State-based + idempotent: re-running on a clean state (no residual
  // triggers OR every child terminal) is a no-op. Runs BEFORE 3a so
  // the parent-derive that follows runs on cleaned state.
  //
  // Single history entry on each fire (the `status_change` shape with
  // `note: "Epic-lifecycle reset — non-terminal children present"`
  // identifies the semantic). The schema's `IssueHistoryEvent` enum
  // does not include `epic_reset` (cross-repo MCP coordination would
  // be needed to add it); the existing `status_change` event carries
  // the same observability — `from` / `to` track the derived-status
  // transition AND the note carries the rule name.
  if (mutated.type === "Epic") {
    const hasResidualTrigger =
      mutated.completed_at !== null ||
      mutated.cancelled_at !== null ||
      mutated.blocked !== null ||
      mutated.dispatch !== null;
    if (hasResidualTrigger) {
      const epicChildren = childrenForDerive ?? [];
      const hasNonTerminalChild = epicChildren.some((c) => {
        const d = deriveStatus(c);
        return d !== "Done" && d !== "Cancelled";
      });
      if (hasNonTerminalChild) {
        const fromStatus = deriveStatus(mutated);
        // Clear all four residual triggers AND `ready_at`. Why also
        // `ready_at` despite the AC text saying "stamp ready_at if
        // null"? `deriveStatus` rule 5 (ready_at populated → ToDo)
        // takes precedence over rule 7 (fallthrough to raw status).
        // For an Epic whose post-3g state should reflect parent-derive
        // (3a) from children, a stamped ready_at would lock the
        // derived value at ToDo regardless of what 3a writes to the
        // raw status field — making 3a's parent-derive a no-op
        // observable through `deriveStatus`. The right semantic for an
        // Epic is "status comes from children's union" — i.e. rule 7
        // fallthrough to whatever 3a writes to raw status. Clearing
        // `ready_at` lands the right derive precedence for both the
        // DX-576/DX-580 case (all-ToDo children → raw "ToDo" → derive
        // "ToDo") AND the non-ToDo children case (e.g. Blocked + IP
        // child → 3a sets raw "In Progress" → derive "In Progress").
        const cleared: Issue = {
          ...mutated,
          completed_at: null,
          cancelled_at: null,
          blocked: null,
          dispatch: null,
          ready_at: null,
          // Set raw status to "ToDo" as the "back to ready ladder"
          // default. 3a's parent-derive will overwrite this when
          // children's union resolves to a different status. With
          // all-ToDo children, the post-3g raw "ToDo" matches the 3a
          // derived "ToDo" so 3a is a no-op — single history entry
          // per epic-reset event (AC #7 / regression repro).
          status: "ToDo",
        };
        const toStatus = deriveStatus(cleared);
        mutated = {
          ...cleared,
          history: appendHistory(cleared.history, {
            timestamp: now,
            actor: "worker:auto-derive",
            event: "status_change",
            from: fromStatus,
            to: toStatus,
            note: "Epic-lifecycle reset — non-terminal children present",
          }),
        };
        mutatedFlag = true;
      }
    }
  }

  // 3d. Orphan dispatch heal (folded from src/poller/heal.ts /
  // healOrphanInvariantViolations).
  //
  // When `dispatch != null` AND the PID/TTL says the dispatch is dead
  // (cross-host, dead-pid, dead-ttl per `checkYamlDispatchLiveness`),
  // clear the slot. The orphan crash IS a state event — flagged as
  // real delta so a `worker:heal` history entry fires (DX-147 AC #3
  // semantics, extended to dispatch slots).
  //
  // Liveness gate matches the legacy pass exactly so the per-card
  // reconcile observes the same outcome the per-tick scan produced
  // pre-DX-641. The legacy `runInvariantHeal` per-tick / boot scans
  // can be retired in favor of the audit-pass per-card
  // `reconcileIssue` walk (which calls THIS sub-step on every open
  // YAML).
  if (mutated.dispatch !== null) {
    const verdict = checkYamlDispatchLiveness(mutated.dispatch, {
      currentHost: HOST_NAME,
      now: Date.now(),
      isPidAlive,
    });
    if (verdict.kind !== "alive") {
      const priorDispatchId = mutated.dispatch.id;
      const fromStatus = deriveStatus(mutated);
      const cleared: Issue = { ...mutated, dispatch: null };
      const toStatus = deriveStatus(cleared);
      mutated = {
        ...cleared,
        history: appendHistory(cleared.history, {
          timestamp: now,
          actor: "worker:heal",
          event: "status_change",
          from: fromStatus,
          to: toStatus,
          note: `Cleared orphan dispatch ${priorDispatchId} (${verdict.kind})`,
        }),
      };
      mutatedFlag = true;
    }
  }

  // 3e. Invariant heal — shape re-assert (folded from
  // src/poller/heal.ts / healOrphanInvariantViolations
  // blocked-with-assignment branch).
  //
  // Today's invariant: a card whose DERIVED status is `Blocked` MUST
  // have `assigned_agent: null` — Blocked means the agent declared
  // "done from my side, operator action needed"; keeping
  // `assigned_agent` populated would let the picker's resume-owned-card
  // path pin the agent on a card it cannot work. Clear the stamp.
  //
  // Other shape invariants (`waiting_on.{reason, timestamp, by}` shape,
  // `conflict_on[]` entry shape, `requires_human.{reason, steps, set_by,
  // set_at}` shape) are enforced at parse time by the validator — by
  // the time a YAML reaches reconcile it has already passed shape
  // checks. This sub-step is therefore a NO-CLOBBER zone for those
  // three fields: reconcile NEVER mutates a non-null `conflict_on[]`,
  // `waiting_on`, or `requires_human` payload (the agent / prep-verdict
  // route owns them).
  if (deriveStatus(mutated) === "Blocked" && mutated.assigned_agent !== null) {
    const fromStatus = deriveStatus(mutated);
    const cleared: Issue = { ...mutated, assigned_agent: null };
    const toStatus = deriveStatus(cleared);
    mutated = {
      ...cleared,
      history: appendHistory(cleared.history, {
        timestamp: now,
        actor: "worker:heal",
        event: "status_change",
        from: fromStatus,
        to: toStatus,
        note: "Cleared assigned_agent on Blocked card (shape invariant)",
      }),
    };
    mutatedFlag = true;
  }

  // 3a. Parent-derive — only when this card has children AND is not
  // itself queued behind other work. The waiting_on guard mirrors the
  // legacy `recomputeParentStatuses` skip (worker forces waiting-on
  // parents to ToDo, deriving over them would churn IO).
  //
  // History-gating: `applyParentDeriveMutation` fires the
  // `worker:auto-derive` history entry only when the derived status
  // ACTUALLY differs from observed (gated below on `derived.status !==
  // mutated.status`). A re-derive that lands the same status —
  // steady-state projection re-affirm — emits zero history.
  if (mutated.children.length > 0 && mutated.waiting_on === null) {
    const children = childrenForDerive ?? [];
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
  //
  // History-gating: `decideFileMove` returns a `healEntry` ONLY on the
  // closed→open direction (real semantic delta — non-terminal status
  // restored). The open→closed direction returns `targetDir: "closed",
  // healEntry: null` — a janitorial fix that does NOT mint a history
  // entry. Either branch lands in the no-history side when the file is
  // already in the correct bucket (`decideFileMove` returns null).
  const fileMove = decideFileMove(mutated, loaded.bucket);
  if (fileMove !== null && fileMove.healEntry !== null) {
    mutated = applyHealHistory(mutated, fileMove.healEntry, now);
    mutatedFlag = true;
  }
  const targetBucket: IssueBucket = fileMove?.targetDir ?? loaded.bucket;
  const bucketChanged = targetBucket !== loaded.bucket;

  // 3c. list_name audit — projection re-affirm (DX-641).
  //
  // `list_name` is display-only (workers never read it; static guard
  // at `src/__tests__/no-list-name-reads.test.ts`). Even so, write
  // paths CAN drift the field — the stamp-paths (`stamp-terminal.ts`,
  // `stamp-blocked.ts`, `dispatch/core.ts`) all stamp event-stamped
  // `list_name` on their writes, and a dashboard list-move dropdown
  // can desync the field from the derived semantic. This audit
  // recomputes the expected list name from the current derived status
  // and re-asserts when mismatched.
  //
  // Flagged as PROJECTION RE-AFFIRM — NO history entry. The semantic
  // state (derived status) was already represented before this audit;
  // the field was a stale denormalization. DX-624 class.
  //
  // Scope: re-asserts ONLY when `list_name` is non-null but doesn't
  // match the derived expected name. A `list_name: null` card has no
  // stamp to audit — the next stamp path (terminal / blocked /
  // dispatch / list-move PATCH) fills the field. Filling null on
  // audit would churn every never-stamped card on every reconcile,
  // and the contract elsewhere (e.g. `createEmptyIssue` returning
  // `list_name: null`) treats null as a valid steady state.
  //
  // Policy: audit always re-asserts on derived-inconsistent
  // `list_name`. A human override via the dashboard list-move dropdown
  // must re-stamp the trigger (e.g. `ready_at` to move to ToDo) for
  // the change to stick — otherwise the audit reverts it on the next
  // reconcile. Decision recorded on DX-641 comments.
  if (mutated.list_name !== null) {
    const derivedStatus = deriveStatus(mutated);
    const expectedListType = deriveListTypeFromSemanticStatus(derivedStatus);
    let expectedListName: string | null = null;
    try {
      expectedListName = resolveListNameForType(
        repo.localPath,
        expectedListType,
      );
    } catch (err) {
      // lists.yaml missing or unreadable — record a non-fatal error but
      // keep going. The audit is best-effort; production has the seeded
      // 7-default `lists.yaml` so this branch fires only in tests that
      // skipped the seed setup.
      errors.push({
        step: "list-name-audit",
        message: `Failed to resolve expected list name for type ${expectedListType}: ${(err as Error).message}`,
        fatal: false,
      });
    }
    if (expectedListName !== null && mutated.list_name !== expectedListName) {
      mutated = { ...mutated, list_name: expectedListName };
      mutatedFlag = true;
      // No history entry — projection re-affirm.
    }
  }

  // ---- Step 4: diff vs prior canonical ----
  // Even when step 3 detected no derived-state mutation, the on-disk
  // YAML may have changed since this worker last pushed to the tracker
  // (the agent's own `Edit` call fired chokidar → reconcile). Step 7
  // below decides independently whether to push by comparing the
  // current hash to the per-card lastPushedHash cache. Step 5 (write)
  // and step 9-10 (recurse) still gate on `mutatedFlag || bucketChanged`
  // because writing identical bytes is a no-op and recursing on
  // identical state is wasted work.

  // ---- Step 5: write YAML via writeIssue + bucket move ----
  // `writeIssue` always writes to `open/` and performs `upsertIssueRowNow`
  // BEFORE the file write (DX-555 — closes the async-DB-mirror gap where
  // reconcile's bare `writeFileSync` bypassed the synchronous-DB invariant).
  // For terminal status the file then moves to `closed/` via
  // `moveToClosedIfTerminal`. For the heal direction (`closed/ → open/`)
  // we unlink the old closed copy manually after `writeIssue`.
  const reconcileMutated = mutatedFlag || bucketChanged;
  const nextSerialized = mutatedFlag ? serializeIssue(mutated) : loaded.text;
  if (reconcileMutated) {
    const stamped = await writeIssue(repo.localPath, mutated);
    const movedToClosed = moveToClosedIfTerminal(repo.localPath, stamped);
    if (!movedToClosed && loaded.bucket === "closed") {
      // Healed from closed → open; unlink the stale closed copy.
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

  // ---- Step 6 (retired DX-549, gap closed DX-555): DB is synchronous ----
  // Pre-DX-549 this step awaited chokidar's mirror upsert. Post-DX-549
  // the comment noted reconcile's writeFileSync bypassed the synchronous-DB
  // invariant. DX-555 routes step 5 through writeIssue, which calls
  // upsertIssueRowNow BEFORE writeFileSync — DB is current the moment step
  // 5 resolves. Step 7 reads in-memory Issue + per-card lastPushedHash, so
  // it still does not need the DB row, but any future reader that queries
  // DB right after reconcileIssue resolves sees fresh state immediately.

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
  // DX-302 — operator override halts step 7. The chokidar-event reconcile
  // path is the main outbound mirror channel (every agent YAML save fires
  // here); without this gate, flipping `overrides.trelloSync.enabled =
  // false` would NOT actually stop Trello pushes — auto-sync would skip,
  // retry-queue would skip, but every agent save would still hit Trello
  // through this path. Override-only (consistent with auto-sync) so the
  // env default + trigger-filter combo on the dispatch row remain the
  // canonical "is this a Trello sync" signals; this is the additive
  // operator-pause. The lastPushedHash cache is left UNCHANGED on skip so
  // the next reconcile after re-enable still fires the push.
  const trelloSyncDisabled =
    tracker !== undefined &&
    lastPushed !== nextHash &&
    isTrelloSyncOverrideDisabled(repo.localPath);
  if (tracker && lastPushed !== nextHash && !trelloSyncDisabled) {
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
      if (rec.depth < MAX_RECURSION_DEPTH && !rec.visited.has(parentRecursed)) {
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

  // ---- Step 7b: triage timer re-arm (DX-289 / Phase 4b.2)
  //              + 3f triage TTL refresh poke (DX-641) ----
  // Re-arm the per-card triage `setTimeout` whenever `triage.expires_at`
  // differs from the value we last saw for this `(repo, id)` pair AND
  // the card is currently in the triage agent's scope (Review /
  // Blocked / waiting_on != null). Cards outside scope cannot be triaged
  // — arming the timer would just fire a moot audit reconcile that
  // re-arms again, looping on `expires_at === ""`. Terminal status (or
  // bucket move to closed) clears the timer too.
  //
  // DX-641 / Sub-step 3f extends this block: when `triage.expires_at` is
  // EMPTY AND the card is in triage scope (i.e. it needs to be triaged
  // BUT no triage agent has stamped an expiry yet), emit the signal
  // `fanout.schedulerPokeReason: "triage-empty"`. Idempotent: the
  // `triageExpiresAtByCardId` cache holds the last-observed value; the
  // signal fires ONLY on the cache miss / value change. The triage
  // agent stamps a non-empty `expires_at` on dispatch which flips the
  // cache; subsequent reconciles with the same expiry observe `prior
  // === current` and skip the signal.
  //
  // NOTE — signal-only today (no consumer wiring). The
  // `onReconcileResult` hook in `src/dispatch/scheduler.ts` reads only
  // `fanout.dispatchableChanged`, so the `schedulerPokeReason` field is
  // observable through `ReconcileResult` but does NOT itself trigger a
  // triage dispatch. The per-tick cron path's `checkAndSpawnTriage`
  // (in `src/cron/sync-and-audit.ts`) remains the dispatch source.
  // Wiring `onReconcileResult` to also fire a triage poke when this
  // signal fires is a follow-up task (Phase 3 ships the producer; the
  // consumer ships in a later DX-* phase). Until that lands, 3f's
  // observable effect is limited to the signal surface — it shortens
  // triage time only via the existing per-tick path.
  //
  // The triage-timer import is module-cyclic-safe because the timer
  // imports `ReconcileRepoContext` as a type-only symbol.
  // DX-584 (Phase 4) — derived semantic state. A card whose
  // `completed_at` / `cancelled_at` is stamped reads as terminal even
  // when the raw `status` is stale.
  const mutatedDerived = deriveStatus(mutated);
  const isTerminalStatus =
    mutatedDerived === "Done" || mutatedDerived === "Cancelled";
  const inTriageScope =
    mutated.waiting_on !== null ||
    mutatedDerived === "Review" ||
    mutatedDerived === "Blocked";
  const triageCacheKey = triageExpiresAtKey(repo.name, id);
  let triagePokeReason: string | null = null;
  if (isTerminalStatus || targetBucket === "closed" || !inTriageScope) {
    clearTriageTimer(repo.name, id);
    triageExpiresAtByCardId.delete(triageCacheKey);
  } else {
    const nextTriageExpiresAt = mutated.triage.expires_at;
    const priorTriageExpiresAt = triageExpiresAtByCardId.get(triageCacheKey);
    if (priorTriageExpiresAt !== nextTriageExpiresAt) {
      // First observation OR triage agent stamped a fresh expiry —
      // re-arm the timer to fire at the new value. The string-to-ms
      // translation lives in `triage-timer.ts` so the empty / past /
      // unparseable handling stays in one place.
      armTriageTimer({
        repo,
        cardId: id,
        expiresAtMs: parseTriageExpiresAtMs(nextTriageExpiresAt),
        reconcile: reconcileIssue,
      });
      triageExpiresAtByCardId.set(triageCacheKey, nextTriageExpiresAt);
      // DX-641 / 3f — emit the scheduler poke when the new value is
      // empty (the existing arm logic is a no-op on empty, so without
      // the poke a card whose triage hasn't run yet would sit until
      // the next 60s audit-pass picked it up).
      if (nextTriageExpiresAt === "") {
        triagePokeReason = "triage-empty";
      }
    }
  }

  // ---- Step 8: dispatchableChanged (DX-288 / Phase 4b.1) ----
  // Diff the post-reconcile dispatch-eligibility against the prior
  // observation cached at module scope. First observation reports
  // `dispatchableChanged === currentDispatchable` — a fresh card that's
  // currently dispatchable pokes the scheduler so the picker sees it
  // without waiting for the next chokidar event.
  //
  // The cache update happens BEFORE the scheduler hook fires (in
  // `reconcileIssue` below). Two reconciles for the same id queued via
  // the per-card mutex therefore see a consistent prior value: the
  // first run stamps current, the second run diffs against that stamp.
  const currentDispatchable = isCardDispatchable(mutated);
  const cacheKey = dispatchableKey(repo.name, id);
  const priorDispatchable = dispatchableByCardId.get(cacheKey);
  const dispatchableChanged =
    priorDispatchable === undefined
      ? currentDispatchable
      : currentDispatchable !== priorDispatchable;
  dispatchableByCardId.set(cacheKey, currentDispatchable);

  // ---- Step 8b: skip-cache stamp (DX-640) ----
  // Stamp the post-reconcile (hash, envGen) so the next top-level
  // reconcile on this card can short-circuit if neither input has
  // moved. Stamped at end-of-body so a partial body (thrown error
  // before this point) does NOT leave the cache claiming "no work
  // needed" — the next reconcile will then re-attempt every step,
  // matching the trace + retry contract reconcile already provides
  // through the catch/recordSystemError chain.
  skipCacheByCardId.set(skipCacheKey(repo.name, id), {
    hash: nextHash,
    envGen: currentEnvGen,
  });

  return {
    changed: reconcileMutated,
    prevHash,
    nextHash,
    errors,
    fanout: {
      parentId: parentRecursed,
      dependents,
      dispatchableChanged,
      ...(triagePokeReason !== null && {
        schedulerPokeReason: triagePokeReason,
      }),
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
  const resultPromise = reconcileWithContext(repo, id, trigger, {
    visited: new Set<string>(),
    depth: 0,
  });
  // Step 8 (scheduler poke) runs OUTSIDE the per-card mutex so a slow
  // picker run does not pile up other reconciles for the same id.
  // `lifecycle` triggers (auto-sync from `danxbot_complete`) intentionally
  // skip the poke — lifecycle awaits the trailing tracker push and a
  // re-poke from lifecycle would re-introduce the lag the event-driven
  // path is meant to eliminate. See DX-218 carryover note.
  if (trigger !== "lifecycle") {
    void resultPromise.then(
      (result) => {
        const hook = schedulerHooksByRepo.get(repo.name);
        if (hook) {
          try {
            hook({ repo, result });
          } catch (err) {
            log.warn(
              `[${repo.name}] ${id} scheduler hook threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      },
      () => {
        // Rejected promise (ReconcileValidationError or unhandled
        // throw inside the body): no result to poke with. Errors
        // surface to the caller through `resultPromise` itself; we
        // simply don't run the scheduler hook on failure.
      },
    );
  }
  return resultPromise;
}

/** Visible for tests — drain the mutex map between cases. */
export function _resetReconcileMutexes(): void {
  mutexes.clear();
}

/** Visible for tests — recursion depth cap (read-only). */
export const _MAX_RECURSION_DEPTH = MAX_RECURSION_DEPTH;
