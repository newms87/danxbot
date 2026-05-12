/**
 * Per-repo dispatch scheduler — Phase 4 of Event-Driven Worker (DX-219).
 *
 * Today this module is a thin coordinator that ports four protections
 * from the legacy `runSync` single-card dispatch path (which DX-242
 * removed) onto the multi-agent dispatch path (DX-200). Without these
 * ports the multi-agent picker is a regression vs the legacy path it
 * replaces. The full event-driven scheduler (reconcile step 8 wiring,
 * triage `expires_at` setTimeout, per-dispatch TTL setTimeout,
 * settings.json file-watch + `onAgentRosterChange`, `runSync` decision
 * deletion) is deferred to follow-up phases — those concerns are NOT
 * in this card's `ac[]`.
 *
 * The four ports:
 *
 *   1. **Tracker-comment lock + release.** Already wired through
 *      `tryAcquireLock` + `dispatch()`'s `lockRelease` callback in
 *      `src/poller/multi-agent-pick.ts` (DX-241). This module re-exports
 *      the lock helpers from `src/issue-tracker/lock.js` so the
 *      scheduler is the single API surface for dispatch-time protections.
 *      No call-site move required.
 *
 *   2. **Pre-claim DB liveness guard.** `guardLiveDispatchForCard`
 *      wraps `hasLiveDispatchForCard` (ISS-69) and injects the DB +
 *      PID-liveness deps. The multi-agent picker calls this AFTER
 *      `pickCardForAgent` and BEFORE the tracker-comment lock acquire
 *      so that a card currently being worked by a host-mode dispatch
 *      (whose claude reparented to PID 1 after a worker restart) is
 *      not double-claimed. Without this port the picker would spawn a
 *      second claude on the same card after every restart.
 *
 *   3. **Boot-time TrelloTracker credentials guard.** `bootScheduler`
 *      throws when the repo's tracker is a TrelloTracker but
 *      `repo.trello.{apiKey,apiToken,boardId}` is incomplete. Surfaces
 *      config drift at worker boot instead of at the first dispatch
 *      (which might be minutes later) — and registers the tracker in
 *      `trackersByRepo` for the post-dispatch progress check.
 *
 *   4. **Post-dispatch card-progress check + CRITICAL_FAILURE halt.**
 *      `runPostDispatchProgressCheck` is the extracted form of
 *      `checkCardProgressedOrHalt` from `src/cron/sync-and-audit.ts`. The
 *      multi-agent picker wires it into the dispatch's `onComplete`
 *      callback; when the tracked card stayed in ToDo after the
 *      dispatch ended, the function writes `<repo>/.danxbot/CRITICAL_FAILURE`
 *      so the next poll tick's halt gate refuses further dispatches.
 *      This is the $1k/day token-burn safeguard from production.
 *
 * `trackersByRepo` mirrors the registry pattern from
 * `src/issue/reconcile.ts` (Phase 3 / DX-218) — keeps tracker lookup
 * out of the multi-agent picker's argument list. Reset via
 * `_resetSchedulerTrackers` in tests only.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { hostname as osHostname } from "node:os";
import { findNonTerminalDispatches } from "../dashboard/dispatches-db.js";
import { isPidAlive } from "../agent/host-pid.js";
import { writeFlag } from "../critical-failure.js";
import { hasLiveDispatchForCard } from "../poller/live-dispatch-guard.js";
import { TrelloTracker } from "../issue-tracker/trello.js";
import {
  clearDispatchAndWrite,
  findByExternalId,
  loadLocal,
} from "../poller/yaml-lifecycle.js";
import { checkYamlDispatchLiveness } from "../poller/dispatch-liveness-yaml.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import {
  scanAndArmTriageTimers,
  type ReconcileFn as TriageReconcileFn,
} from "./triage-timer.js";
import {
  scanAndArmTtlTimers,
  type TtlReconcileFn,
  type TtlTimerDeps,
} from "./ttl-timer.js";
import { watchSettingsFile } from "../settings-file.js";
import { createLogger } from "../logger.js";

const log = createLogger("scheduler");

const trackersByRepo = new Map<string, IssueTracker>();

/**
 * Picker registration — Phase 4b.1 (DX-288) of the Event-Driven Worker
 * epic. Each repo registers a `runPicker` callback at `bootScheduler`
 * time so `onReconcileResult` can fire the picker when reconcile
 * reports a dispatch-eligibility change. The callback is repo-bound:
 * production wires `tryMultiAgentDispatch` with a fresh card snapshot
 * on each invocation; tests register a spy.
 *
 * `pendingPokes` debounces multiple back-to-back reconciles for the
 * same repo to a single picker run per microtask burst — without
 * debouncing, two reconciles in a tick would queue two redundant
 * picker invocations that compete for the same agent slots.
 */
export type RunPickerFn = (input: { now: Date }) => Promise<unknown>;
const pickersByRepo = new Map<string, RunPickerFn>();
const pendingPokes = new Set<string>();

/**
 * DX-305: per-repo single-flight mutex around picker execution. Three
 * sources can fire a picker invocation in the same macrotask burst —
 * `onReconcileResult`'s setImmediate, `onAgentRosterChange`'s
 * setImmediate, AND the legacy `runSync` direct call (until DX-290 retires
 * the latter). Without this mutex two consecutive macrotasks each invoke
 * `runPicker` against the same `busy`/`assigned` snapshot — both pick
 * the same agent + card and `spawnAgent` runs twice. The two existing
 * debounce sets (`pendingPokes`, `pendingRosterPokes`) coalesce within
 * their OWN source per macrotask burst; this mutex is the cross-source
 * + per-execution layer.
 *
 * Semantics: when a poke arrives during an inflight run the request
 * coalesces into ONE `pendingTailRun` flag. After the active run
 * resolves a single tail run fires (still under the mutex — defensive
 * against a poke landing during the tail itself). Try/finally guards
 * against a thrown picker permanently locking the repo.
 */
const pickerInflight = new Set<string>();
const pendingTailRun = new Set<string>();

/**
 * Phase 4b.2 (DX-289). settings.json file-watch handles registered per-
 * repo at `bootScheduler` time. Worker shutdown drains via `unwatch()`.
 * Map shape mirrors `pickersByRepo` + `trackersByRepo`.
 */
const settingsWatchersByRepo = new Map<
  string,
  { unwatch: () => Promise<void> }
>();

/**
 * Phase 4b.2 — pending `onAgentRosterChange` pokes per repo. Same shape
 * + debounce semantics as `pendingPokes` for `onReconcileResult`.
 * Decoupled set because a roster-change burst and a reconcile burst can
 * be in flight concurrently, and either source coalescing the other's
 * fire would be incorrect.
 */
const pendingRosterPokes = new Set<string>();

/**
 * Lookup the tracker registered by `bootScheduler`. Returns undefined
 * when no boot has happened for this repo — callers that need to
 * fail-loud should branch on that.
 */
export function getSchedulerTracker(
  repoName: string,
): IssueTracker | undefined {
  return trackersByRepo.get(repoName);
}

/**
 * Test seam. Reset all registered trackers between tests so a stale
 * registration from a prior test does not leak into a later one.
 * Extends the legacy DX-219 reset to also drain the Phase 4b.1
 * picker registry + pending-poke debounce set so onReconcileResult
 * tests start from a clean state.
 */
export function _resetSchedulerTrackers(): void {
  trackersByRepo.clear();
  pickersByRepo.clear();
  pendingPokes.clear();
  pendingRosterPokes.clear();
  pickerInflight.clear();
  pendingTailRun.clear();
  // Close any settings watchers registered by prior tests so a vitest
  // worker doesn't leak fs handles between describes. Awaiting per
  // entry inside the synchronous reset hook would change the public
  // contract (every caller would have to `await _reset...`); instead
  // we fire-and-forget the unwatch — chokidar's `close()` swallows
  // its own errors and tests already use `_resetForTesting` in
  // settings-file.ts to drain in-process state.
  for (const watcher of settingsWatchersByRepo.values()) {
    void watcher.unwatch().catch(() => undefined);
  }
  settingsWatchersByRepo.clear();
}

/**
 * Boot-time scheduler initialization for one repo. Validates that a
 * TrelloTracker has populated credentials and registers the tracker
 * for later use by the post-dispatch progress check.
 *
 * Called from worker boot (`src/index.ts`) BEFORE the poller starts.
 * Throws synchronously on a missing-creds TrelloTracker so the worker
 * fails to start instead of running with broken dispatch-followup. A
 * MemoryTracker (DANXBOT_TRACKER=memory) constructs without creds and
 * passes the check.
 *
 * Idempotent — re-registering on a hot reload replaces the prior
 * tracker reference cleanly.
 *
 * AC #3 of DX-219.
 */
export function bootScheduler(args: {
  repo: RepoContext;
  tracker: IssueTracker;
  /**
   * Phase 4b.1 (DX-288). Optional picker callback registered for the
   * repo so `onReconcileResult` can fire the multi-agent dispatch loop
   * when reconcile reports a dispatch-eligibility change. Production
   * wires a closure that re-fetches dispatchable + in-progress card
   * lists and invokes `tryMultiAgentDispatch`. Tests register a spy.
   * Omitting the callback keeps `onReconcileResult` a no-op for that
   * repo — the legacy `runSync` per-tick path still runs picks until
   * Phase 4b.3 deletes it.
   */
  runPicker?: RunPickerFn;
  /**
   * Phase 4b.2 (DX-289). Reconcile function reference forwarded to the
   * triage-timer boot-scan + the settings.json file-watch. Production
   * wires `reconcileIssue` from `src/issue/reconcile.ts`; tests pass a
   * spy. When omitted, the boot-scan + file-watch are SKIPPED — most
   * tests don't need them, and omitting avoids forcing every caller to
   * thread a stub through.
   */
  reconcile?: TriageReconcileFn;
}): void {
  const { repo, tracker, runPicker, reconcile } = args;
  if (tracker instanceof TrelloTracker) {
    const trello = repo.trello;
    if (!trello?.apiKey || !trello?.apiToken || !trello?.boardId) {
      throw new Error(
        `[scheduler] boot validation failed for repo "${repo.name}": ` +
          `tracker is TrelloTracker but trello credentials on RepoContext are incomplete ` +
          `(apiKey=${Boolean(trello?.apiKey)}, apiToken=${Boolean(trello?.apiToken)}, boardId=${Boolean(trello?.boardId)})`,
      );
    }
  }
  trackersByRepo.set(repo.name, tracker);
  if (runPicker) {
    pickersByRepo.set(repo.name, runPicker);
  } else {
    // Explicit clear on re-boot without a picker — defends against a
    // hot-reload scenario where a prior boot registered a picker that
    // a later boot does not want to keep. Idempotent when no entry
    // was set.
    pickersByRepo.delete(repo.name);
  }

  // Phase 4b.2 (DX-289). Start the settings.json watcher + triage
  // boot-scan re-arm, both keyed on the reconcile dep. Idempotent over
  // re-boot — replace the prior watcher handle if one exists.
  if (reconcile) {
    const prior = settingsWatchersByRepo.get(repo.name);
    if (prior) {
      void prior.unwatch().catch((err) =>
        log.warn(
          `[${repo.name}] scheduler boot: prior settings-watch unwatch failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    const reconcileRepo: ReconcileRepoContext = {
      name: repo.name,
      localPath: repo.localPath,
      issuePrefix: repo.issuePrefix,
    };
    const handle = watchSettingsFile({
      localPath: repo.localPath,
      onChange: () => {
        onAgentRosterChange(repo.name);
      },
    });
    settingsWatchersByRepo.set(repo.name, handle);
    scanAndArmTriageTimers({ repo: reconcileRepo, reconcile });
  } else {
    // No reconcile dep — drop any prior watcher cleanly. Matches the
    // hot-reload-without-picker branch above.
    const prior = settingsWatchersByRepo.get(repo.name);
    if (prior) {
      void prior.unwatch().catch(() => undefined);
      settingsWatchersByRepo.delete(repo.name);
    }
  }

  log.info(
    `[${repo.name}] scheduler boot: ${tracker instanceof TrelloTracker ? "TrelloTracker validated" : "MemoryTracker"} and registered${runPicker ? " (picker wired)" : ""}${reconcile ? " (settings watch + triage boot-scan wired)" : ""}`,
  );
}

/**
 * Boot-rehydrate — Phase 5 of Event-Driven Worker (DX-220).
 *
 * Consolidates every "on worker boot, walk on-disk state and re-arm
 * the in-memory side" pass into one entry point. Replaces the
 * pre-Phase-5 `runStartupReattach` from `src/cron/sync-and-audit.ts` and adds
 * a fresh TTL-timer boot scan.
 *
 * What runs:
 *
 *   1. **Dead-dispatch clearing.** Walks every open YAML; for each
 *      with a non-null `dispatch{}` block, derives a liveness verdict
 *      via `checkYamlDispatchLiveness`. Verdict `alive` is left in
 *      place (the per-dispatch TTL timer + heartbeat tick own it from
 *      here); `dead-pid` / `dead-ttl` / `cross-host` clear the
 *      `dispatch` field via `clearDispatchAndWrite` so the scheduler
 *      can re-offer the slot.
 *   2. **TTL timer re-arm.** Reads non-terminal dispatches from the
 *      `dispatches` table; for each with an alive PID + non-null
 *      `issueId`, arms a fresh TTL timer via `scanAndArmTtlTimers`.
 *      The heartbeat tick re-arms on its next fire — the boot scan
 *      bridges the gap.
 *   3. **Triage timer re-arm.** `scanAndArmTriageTimers` walks every
 *      open YAML and arms a triage `setTimeout` per card based on
 *      `triage.expires_at`. Idempotent with the parallel call inside
 *      `bootScheduler` — arming the same (repo, card) replaces the
 *      prior timer cleanly.
 *
 * Must run AFTER `startIssuesMirror` (so the DB is consistent with
 * disk) and BEFORE the cron's first tick (so reconcile sees a clean
 * baseline). The boot order in `src/index.ts` is responsible for that
 * sequencing.
 *
 * Cross-host verdicts on a local-only deploy are treated as cleared
 * (matches the prior `runStartupReattach` contract). Tolerates
 * malformed YAMLs (logs + skips) so a single corrupt file cannot halt
 * the boot phase. Per-card / per-dispatch failures are isolated; the
 * function never throws past its caller.
 */
export async function bootRehydrate(args: {
  repo: RepoContext;
  reconcile: TriageReconcileFn & TtlReconcileFn;
  ttlMs: number;
  ttlTimerDeps: TtlTimerDeps;
}): Promise<{ alive: number; cleared: number; ttlArmed: number }> {
  const { repo, reconcile, ttlMs, ttlTimerDeps } = args;
  const reconcileRepo: ReconcileRepoContext = {
    name: repo.name,
    localPath: repo.localPath,
    issuePrefix: repo.issuePrefix,
  };

  // Step 1 — clear dead-dispatch records from open YAMLs.
  let alive = 0;
  let cleared = 0;
  const openDir = resolve(repo.localPath, ".danxbot", "issues", "open");
  if (existsSync(openDir)) {
    const issues: Issue[] = [];
    for (const entry of readdirSync(openDir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      try {
        const issue = await loadLocal(repo.localPath, stem, repo.issuePrefix);
        if (issue && issue.dispatch !== null) {
          issues.push(issue);
        }
      } catch (err) {
        log.warn(
          `[${repo.name}] bootRehydrate: skipping ${entry}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (issues.length > 0) {
      const livenessDeps = {
        currentHost: osHostname(),
        now: Date.now(),
        isPidAlive,
      };
      for (const issue of issues) {
        if (issue.dispatch === null) continue;
        const verdict = checkYamlDispatchLiveness(issue.dispatch, livenessDeps);
        if (verdict.kind === "alive") {
          alive += 1;
          log.info(
            `[${repo.name}] bootRehydrate: ${issue.id} alive (pid=${issue.dispatch.pid}, dispatch=${issue.dispatch.id}) — left in place`,
          );
        } else {
          cleared += 1;
          log.warn(
            `[${repo.name}] bootRehydrate: clearing ${issue.id} (verdict=${verdict.kind}, dispatch=${issue.dispatch.id})`,
          );
          try {
            void clearDispatchAndWrite(repo.localPath, issue).catch((err) =>
              log.warn(
                `[${repo.name}] bootRehydrate: clearDispatch mirror ack failed for ${issue.id}`,
                err,
              ),
            );
          } catch (err) {
            log.error(
              `[${repo.name}] bootRehydrate: clearDispatch failed for ${issue.id}`,
              err,
            );
          }
        }
      }
    }
  }

  // Step 2 — arm TTL timers from DB non-terminal dispatches.
  const ttlScan = await scanAndArmTtlTimers({
    repo: reconcileRepo,
    ttlMs,
    deps: ttlTimerDeps,
    findNonTerminalDispatches,
  });

  // Step 3 — arm triage timers from open YAMLs. Idempotent with the
  // parallel call inside `bootScheduler`; arming the same (repo, card)
  // replaces any prior timer cleanly.
  scanAndArmTriageTimers({ repo: reconcileRepo, reconcile });

  log.info(
    `[${repo.name}] bootRehydrate: alive=${alive} cleared=${cleared} ttl-armed=${ttlScan.armed} ttl-skipped=${ttlScan.skipped}`,
  );

  return { alive, cleared, ttlArmed: ttlScan.armed };
}

/**
 * Phase 4b.2 (DX-289). Drain the settings.json file-watch for one repo.
 * Tests use this between cases to release chokidar handles deterministically.
 * Idempotent — silent no-op when no watcher is armed for the repo.
 */
export async function unwatchSettingsFileForRepo(
  repoName: string,
): Promise<void> {
  const handle = settingsWatchersByRepo.get(repoName);
  if (!handle) return;
  settingsWatchersByRepo.delete(repoName);
  await handle.unwatch();
}

/**
 * Phase 4b.2 (DX-289). Drain every registered settings-file watcher
 * across all repos. Called from `src/shutdown.ts` so chokidar handles
 * don't outlive the worker process on SIGTERM. Idempotent — empty
 * registry is a no-op. Failures per watcher are logged and swallowed
 * so shutdown stays bounded.
 */
export async function unwatchAllSettingsFiles(): Promise<void> {
  const handles = Array.from(settingsWatchersByRepo.entries());
  settingsWatchersByRepo.clear();
  await Promise.allSettled(
    handles.map(([repoName, handle]) =>
      handle.unwatch().catch((err) =>
        log.warn(
          `[${repoName}] settings watcher drain failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      ),
    ),
  );
}

/**
 * DX-305: invoke the registered picker for `repoName` under the
 * single-flight mutex. When a run is already in flight, set the tail
 * flag and return immediately — the active run's `finally` schedules
 * exactly one follow-up. Recursively self-schedules the tail run via
 * `setImmediate` so the post-tail re-check (a poke landing during the
 * tail) is observed on the next macrotask.
 *
 * Errors from the picker are caught and logged here so the inflight
 * flag always clears — a thrown picker MUST NOT permanently lock out
 * the repo. Sync throws and async rejections both land in the catch
 * because `await fn(...)` covers both.
 */
async function firePickerWithMutex(repoName: string): Promise<void> {
  if (pickerInflight.has(repoName)) {
    pendingTailRun.add(repoName);
    return;
  }
  const picker = pickersByRepo.get(repoName);
  if (!picker) return;
  pickerInflight.add(repoName);
  try {
    await picker({ now: new Date() });
  } catch (err) {
    log.error(
      `[${repoName}] scheduler picker run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    pickerInflight.delete(repoName);
    if (pendingTailRun.has(repoName)) {
      pendingTailRun.delete(repoName);
      setImmediate(() => {
        void firePickerWithMutex(repoName);
      });
    }
  }
}

/**
 * DX-305: bridge for callers that want to run their OWN picker function
 * (specifically the legacy `runSync` path which still calls
 * `tryMultiAgentDispatch` directly and observes its `MultiAgentPickResult`
 * to decide whether to short-circuit the prior single-card dispatch fallthrough).
 * Acquires the same single-flight mutex as the registered-picker path so
 * all three concurrency sources coalesce.
 *
 * Returns `{ran: false}` when a run is already in flight — caller MUST
 * treat that as "no dispatch happened this tick" (the tail run will
 * fire via the registered picker). Returns `{ran: true, value}` when
 * `fn` ran to completion. A thrown `fn` propagates AFTER the mutex
 * clears, so callers can apply their own catch.
 */
export async function runWithPickerMutex<T>(
  repoName: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (pickerInflight.has(repoName)) {
    pendingTailRun.add(repoName);
    return { ran: false };
  }
  pickerInflight.add(repoName);
  try {
    const value = await fn();
    return { ran: true, value };
  } finally {
    // The tail-run schedule fires REGARDLESS of whether `fn` threw.
    // Intentional: a thrown `runSync`-side picker still represents
    // unattended dispatch demand (cards remain dispatchable) — the
    // registered picker should get a chance to make progress on the
    // next macrotask. Caller's outer try/catch sees the original
    // rejection unchanged.
    pickerInflight.delete(repoName);
    if (pendingTailRun.has(repoName)) {
      pendingTailRun.delete(repoName);
      setImmediate(() => {
        void firePickerWithMutex(repoName);
      });
    }
  }
}

/**
 * Phase 4b.2 (DX-289). Poke the scheduler that the agent roster for a
 * repo changed (typically: operator toggled an agent on/off via the
 * dashboard, or `<repo>/.danxbot/settings.json` was rewritten by
 * `make deploy`). Wires identically to `onReconcileResult` — fires the
 * registered picker once per macrotask burst so a roster change
 * surfaces newly-idle agents to the dispatch loop without waiting for
 * the next `runSync` tick.
 *
 * Skip conditions:
 *   - No picker registered for the repo (legacy `runSync` path still
 *     runs picks; the change will be picked up there).
 *   - A roster-change poke is already pending for this repo on the
 *     current macrotask burst — debounce coalesces 2+ writes within
 *     the same tick into one picker invocation.
 *
 * Scheduling: `setImmediate` puts the picker on the macrotask queue
 * AFTER the chokidar handler returns. Same fire-and-forget model as
 * `onReconcileResult`.
 */
export function onAgentRosterChange(repoName: string): void {
  if (pendingRosterPokes.has(repoName)) return;
  const runPicker = pickersByRepo.get(repoName);
  if (!runPicker) return;
  pendingRosterPokes.add(repoName);
  setImmediate(() => {
    pendingRosterPokes.delete(repoName);
    // DX-305: route through the single-flight mutex so a concurrent
    // `onReconcileResult` poke (or legacy `runSync` direct picker call)
    // cannot land a duplicate `runPicker` invocation against the same
    // `busy`/`assigned` snapshot.
    void firePickerWithMutex(repoName);
  });
}

/**
 * Boot-time picker kick. Post-DX-290 the picker fires ONLY on
 * `onReconcileResult({dispatchableChanged:true})` or
 * `onAgentRosterChange`. If a worker boots while every ToDo card is
 * already in steady dispatchable state (no field flips during the boot
 * reconcile pass) and no operator rewrites settings.json, the picker
 * never gets invoked → worker sits idle with cards available. This
 * helper fires the picker exactly once via the same single-flight
 * mutex, intended to be called by the worker boot sequence after
 * `bootRehydrate` completes (so the picker observes a consistent
 * disk + DB snapshot). No-op when no picker is registered for the
 * repo (test harnesses + mock-tracker boots).
 */
export function kickPickerOnceAtBoot(repoName: string): void {
  const runPicker = pickersByRepo.get(repoName);
  if (!runPicker) return;
  setImmediate(() => {
    void firePickerWithMutex(repoName);
  });
}

/**
 * Reconcile-result poke from the chokepoint in `src/issue/reconcile.ts`
 * (Phase 4b.1 / DX-288). Fires the registered picker for the repo
 * when reconcile flipped a field the dispatch scheduler keys on
 * (`status`, `waiting_on`, `blocked`, `requires_human`, `dispatch`).
 *
 * Skip conditions:
 *   - `result.fanout.dispatchableChanged === false` — nothing changed
 *     in the scheduler's view; no picker run needed.
 *   - No picker registered for the repo — `bootScheduler` was called
 *     without `runPicker`. Until Phase 4b.3 wires every production
 *     caller, some repos legitimately have no picker (the legacy
 *     `runSync` path is still doing picks).
 *   - A picker run is already queued for this repo on the current
 *     macrotask burst — debounce coalesces 2+ reconciles in the same
 *     tick into one picker invocation.
 *
 * Scheduling: `setImmediate` puts the picker on the macrotask queue
 * AFTER reconcile's mutex unwinds. This is the same "slot/mutex
 * separation" pattern Phase 3 (DX-218) established for `pushTrelloDiff`
 * — reconcile body returns fast, the picker runs without holding the
 * reconcile lock.
 *
 * Error propagation: picker failures land on the picker's `.catch`
 * branch and are logged. Reconcile's caller never observes them; the
 * scheduler poke is fire-and-forget.
 */
export function onReconcileResult(args: {
  repo: ReconcileRepoContext;
  result: ReconcileResult;
}): void {
  if (!args.result.fanout.dispatchableChanged) return;
  const repoName = args.repo.name;
  if (pendingPokes.has(repoName)) return;
  const runPicker = pickersByRepo.get(repoName);
  if (!runPicker) return;
  pendingPokes.add(repoName);
  setImmediate(() => {
    pendingPokes.delete(repoName);
    // DX-305: route through the single-flight mutex so a concurrent
    // `onAgentRosterChange` poke (or legacy `runSync` direct picker call)
    // cannot land a duplicate `runPicker` invocation against the same
    // `busy`/`assigned` snapshot.
    void firePickerWithMutex(repoName);
  });
}

/**
 * Pre-claim DB liveness guard. Returns true when a non-terminal
 * dispatch row exists for `cardId` AND its worker PID is still alive.
 *
 * The multi-agent picker MUST skip the candidate when this returns
 * true — a host-mode dispatch reparented to PID 1 after a worker
 * restart still owns the card; spawning a second claude on the same
 * card melts the working tree. Live-PID detection is the only signal
 * available across worker restarts; the DB row alone is ambiguous
 * (the row says "running" whether the agent is alive or zombied).
 *
 * `findNonTerminalDispatches` errors fall through to `false`
 * (fail-open) so a transient DB hiccup does not permanently halt the
 * picker. Worst case we lose duplicate-protection for one tick; the
 * tracker-comment lock still applies as defense-in-depth.
 *
 * AC #2 of DX-219.
 */
export async function guardLiveDispatchForCard(args: {
  repoName: string;
  cardId: string;
  internalIssueId?: string;
}): Promise<boolean> {
  return hasLiveDispatchForCard(
    args.repoName,
    args.cardId,
    {
      findNonTerminalDispatches,
      isPidAlive,
      log: { warn: (m) => log.warn(m) },
    },
    args.internalIssueId,
  );
}

export interface PostDispatchCheckInput {
  repo: RepoContext;
  cardId: string;
  jobId: string;
  jobStatus: string;
  jobSummary: string;
}

/**
 * Post-dispatch card-progress check. After a trello-triggered dispatch
 * exits (success OR failure), fetch the tracked card. If it stayed in
 * ToDo, the dispatch did zero progress — an environment-level blocker
 * the worker cannot self-recover from. Write the CRITICAL_FAILURE flag
 * so the next poll tick's halt gate refuses further dispatches.
 *
 * Skipped (no flag written) when:
 *   - `getCard` throws (false-negative is safer than false-positive on
 *     a tracker transient — the next tick reattempts).
 *   - Card moved out of ToDo (any other status = some progress).
 *   - Local YAML has `waiting_on != null` (the agent intentionally
 *     parked the card behind other in-flight work — the worker
 *     forces `status: ToDo` on save, so the tracker will report
 *     ToDo as expected).
 *   - No tracker registered for this repo (`bootScheduler` not called)
 *     — fail-open with a warning rather than a flag write.
 *
 * Extracted from `checkCardProgressedOrHalt` in `src/cron/sync-and-audit.ts`
 * and parameterized so the multi-agent picker can wire it into
 * `onComplete` without depending on `state.trackedCardId`. The
 * production safeguard the legacy `runSync` path had against
 * $1k/day token-burn loops now applies to every multi-agent dispatch.
 *
 * AC #4 of DX-219.
 */
export async function runPostDispatchProgressCheck(
  input: PostDispatchCheckInput,
): Promise<void> {
  const { repo, cardId, jobId, jobStatus, jobSummary } = input;
  const tracker = trackersByRepo.get(repo.name);
  if (!tracker) {
    log.warn(
      `[${repo.name}] post-dispatch check: no tracker registered for repo — skipping (bootScheduler not called?)`,
    );
    return;
  }

  let card: Issue;
  try {
    card = await tracker.getCard(cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] post-dispatch check: failed to fetch ${cardId} — skipping flag`,
      err,
    );
    return;
  }

  if (card.status !== "ToDo") {
    return;
  }

  let local: Issue | null;
  try {
    local = await findByExternalId(repo.localPath, cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] post-dispatch check: failed to read local YAML for ${cardId} — skipping flag`,
      err,
    );
    return;
  }
  if (!local || local.status !== "ToDo") {
    log.info(
      `[${repo.name}] post-dispatch check: local YAML for ${cardId} status=${local?.status ?? "(closed/missing)"} — tracker reports ToDo but local moved on, skipping flag (tracker likely stale, e.g. trello sync disabled)`,
    );
    return;
  }
  if (local?.waiting_on) {
    log.info(
      `[${repo.name}] post-dispatch check: card "${card.title}" (${cardId}) intentionally waiting on ${local.waiting_on.by.join(", ")} — skipping flag`,
    );
    return;
  }

  log.error(
    `[${repo.name}] post-dispatch check: tracked card "${card.title}" (${cardId}) still in ToDo after dispatch ${jobId} — writing critical-failure flag`,
  );
  writeFlag(repo.localPath, {
    source: "post-dispatch-check",
    dispatchId: jobId,
    cardId,
    cardUrl: `https://trello.com/c/${cardId}`,
    reason: `Tracked card "${card.title}" did not move out of ToDo after dispatch`,
    detail:
      `Card ${cardId} (${card.title}) stayed in the ToDo list across dispatch ${jobId} ` +
      `(status=${jobStatus}, summary=${jobSummary || "none"}). ` +
      `Poller halts until this flag is cleared and the underlying environment blocker is fixed.`,
  });
}

/**
 * Re-export the tracker-comment lock helpers so `scheduler` is the
 * single API surface for dispatch-time protections. The actual call
 * sites in `src/poller/multi-agent-pick.ts` already use these via the
 * direct `../issue-tracker/lock.js` import path; new callers SHOULD
 * import from here.
 *
 * AC #1 of DX-219.
 */
export {
  buildLockHolderInfo,
  releaseLock,
  tryAcquireLock,
} from "../issue-tracker/lock.js";
