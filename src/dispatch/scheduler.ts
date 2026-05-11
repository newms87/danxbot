/**
 * Per-repo dispatch scheduler — Phase 4 of Event-Driven Worker (DX-219).
 *
 * Today this module is a thin coordinator that ports four protections
 * from the legacy `_poll` single-card dispatch path (which DX-242
 * removed) onto the multi-agent dispatch path (DX-200). Without these
 * ports the multi-agent picker is a regression vs the legacy path it
 * replaces. The full event-driven scheduler (reconcile step 8 wiring,
 * triage `expires_at` setTimeout, per-dispatch TTL setTimeout,
 * settings.json file-watch + `onAgentRosterChange`, `_poll` decision
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
 *      `checkCardProgressedOrHalt` from `src/poller/index.ts`. The
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

import { findNonTerminalDispatches } from "../dashboard/dispatches-db.js";
import { isPidAlive } from "../agent/host-pid.js";
import { writeFlag } from "../critical-failure.js";
import { hasLiveDispatchForCard } from "../poller/live-dispatch-guard.js";
import { TrelloTracker } from "../issue-tracker/trello.js";
import { findByExternalId } from "../poller/yaml-lifecycle.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import {
  scanAndArmTriageTimers,
  type ReconcileFn as TriageReconcileFn,
} from "./triage-timer.js";
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
   * repo — the legacy `_poll` per-tick path still runs picks until
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
 * Phase 4b.2 (DX-289). Poke the scheduler that the agent roster for a
 * repo changed (typically: operator toggled an agent on/off via the
 * dashboard, or `<repo>/.danxbot/settings.json` was rewritten by
 * `make deploy`). Wires identically to `onReconcileResult` — fires the
 * registered picker once per macrotask burst so a roster change
 * surfaces newly-idle agents to the dispatch loop without waiting for
 * the next `_poll` tick.
 *
 * Skip conditions:
 *   - No picker registered for the repo (legacy `_poll` path still
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
    const latestRunPicker = pickersByRepo.get(repoName);
    if (!latestRunPicker) return;
    let pickerResult: Promise<unknown>;
    try {
      pickerResult = Promise.resolve(latestRunPicker({ now: new Date() }));
    } catch (err) {
      log.error(
        `[${repoName}] scheduler roster-change picker threw synchronously: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    pickerResult.catch((err) => {
      log.error(
        `[${repoName}] scheduler roster-change picker failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
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
 *     `_poll` path is still doing picks).
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
    // Re-read the picker map at fire time. A hot reload between
    // schedule and fire (rare but possible during worker boot) could
    // have rewired the callback; honor the latest registration.
    const latestRunPicker = pickersByRepo.get(repoName);
    if (!latestRunPicker) return;
    // Wrap the invocation so both sync throws AND async rejections
    // land on the same catch — `Promise.resolve(throwingFn())` does
    // NOT capture a sync throw because the throw escapes BEFORE
    // `Promise.resolve` runs.
    let pickerResult: Promise<unknown>;
    try {
      pickerResult = Promise.resolve(latestRunPicker({ now: new Date() }));
    } catch (err) {
      log.error(
        `[${repoName}] scheduler picker run threw synchronously: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    pickerResult.catch((err) => {
      log.error(
        `[${repoName}] scheduler picker run failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
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
 * Extracted from `checkCardProgressedOrHalt` in `src/poller/index.ts`
 * and parameterized so the multi-agent picker can wire it into
 * `onComplete` without depending on `state.trackedCardId`. The
 * production safeguard the legacy `_poll` path had against
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
