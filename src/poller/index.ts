import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  statSync,
  readlinkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { repoContexts } from "../repo-context.js";
import { DANXBOT_COMMENT_MARKER } from "../issue-tracker/markers.js";
import {
  clearDispatchAndWrite,
  ensureGitignoreEntry,
  ensureIssuesDirs,
  findByExternalId,
  hydrateFromRemote,
  loadLocal,
  writeIssue,
} from "./yaml-lifecycle.js";
import { createIssueTracker } from "../issue-tracker/index.js";
import type {
  Issue,
  IssueRef,
  IssueTracker,
} from "../issue-tracker/interface.js";
// DX-290 (Event-Driven Worker Phase 4b.3) retired every legacy
// dispatch-decision path from `_poll`. The lock acquisition lives
// inside `src/poller/multi-agent-pick.ts` (scheduled via the scheduler's
// `runPicker` callback registered at `src/index.ts` boot). The triage
// timer + TTL timer (DX-289) replaced the per-tick triage walk +
// `evictDeadDispatches` walk. `tryResumeOrphan`, `tryTriageDispatch`,
// `checkAndSpawnIdeator`, `recoverStuckCards`, and the entire legacy
// `spawnClaude` path are gone. The `_poll` body is now sync + audit
// only — Phase 5 (DX-220) trims further and renames the module.
import { parseSimpleYaml } from "./parse-yaml.js";
import { renderRepoConfigMarkdown } from "./repo-config-rule.js";
import { writeIfChanged } from "../workspace/write-if-changed.js";
import { createLogger } from "../logger.js";
import { scrubLegacyTrelloWorkerSymlink } from "./legacy-trello-worker-scrub.js";
import { injectDanxIssueMcp } from "./inject/inject-root-mcp.js";
// DX-218 (Event-Driven Worker Phase 3): the per-tick orphan push was
// retired — empty-`external_id` YAMLs hit the tracker via reconcile
// step 7 (`src/issue/reconcile/trello.ts`'s `external_id === ""`
// branch) on the chokidar event for the YAML write itself, no per-tick
// scan needed. The retry queue keeps any push that hits a transient
// Trello error, scheduled via `setTimeout` rather than a per-tick drain.
//
// DX-217 (Event-Driven Worker Phase 2): the per-tick parent-derive,
// healer, and waiting-on auto-clear passes were absorbed into
// `reconcileIssue` step 3 (`src/issue/reconcile.ts`). Chokidar fires
// reconcile on every YAML mutation; reconcile's recursion (steps 9 +
// 10) propagates the same effects (parent recompute, dependent
// unblock) the same trigger instead of waiting for the next tick. The
// poller's _poll body no longer calls these three helpers directly —
// Phase 5 reintroduces them as a 1-min cron audit pass calling
// `reconcileIssue` on every open YAML.
import { healExternalIds } from "./heal-external-id.js";
import { runInvariantHeal } from "./heal.js";
import { isLinkOrFile, isSymlink } from "./fs-probe.js";
import type { RepoContext } from "../types.js";
import { isFeatureEnabled } from "../settings-file.js";
import { readFlag } from "../critical-failure.js";
import { isPidAlive } from "../agent/host-pid.js";
import { reapOrphans } from "../worker/process-scan.js";
import { hostname as osHostname } from "node:os";
import { buildReattachPlan } from "./dispatch-reattach.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const log = createLogger("poller");

/**
 * Per-repo poller state.
 *
 * DX-290 slimmed this from the legacy seven-field shape to a re-entrancy
 * guard plus the timer handle. The legacy fields — `teamRunning`,
 * `consecutiveFailures`, `backoffUntil`, `priorTodoCardIds`,
 * `trackedCardId`, `triageTracked` — all served the single-fork
 * `spawnClaude` dispatch path that DX-290 retired. The multi-agent
 * dispatch path (`src/poller/multi-agent-pick.ts`, scheduled via
 * `src/dispatch/scheduler.ts`) tracks per-dispatch state inside
 * `dispatch()` itself; the post-dispatch "card didn't move" check lives
 * in `runPostDispatchProgressCheck`; per-card / per-dispatch backoff is
 * an out-of-scope follow-up.
 */
interface RepoPollerState {
  polling: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
}

const repoState = new Map<string, RepoPollerState>();

/**
 * Boot reattach pass (ISS-92 Phase 2; DX-290 slimming).
 *
 * Runs once per worker startup before the polling interval registers.
 * Walks every open YAML's `dispatch{}` block and clears the ones whose
 * PID/host is dead so a worker that crashed mid-dispatch doesn't leave
 * the on-disk record pointing at a process that no longer exists. Alive
 * dispatches are logged and otherwise left alone — the per-dispatch TTL
 * timer (`src/dispatch/ttl-timer.ts`) takes over once `dispatch()`
 * stamps them; pre-existing alive PIDs from before this worker booted
 * are observed via the multi-agent path's `guardLiveDispatchForCard`
 * pre-claim check.
 *
 * Cross-host verdicts on a local-only deploy are treated as cleared.
 * Tolerates malformed YAMLs (logs + skips) so a single corrupt file
 * cannot halt the boot phase.
 *
 * DX-290 retired the in-memory `activeDispatches` mirror this function
 * used to populate — every consumer (per-tick `evictDeadDispatches`,
 * `_poll`'s YAML-based pre-claim guard, `tryResumeOrphan`) went away
 * with the legacy dispatch decision block.
 */
export async function runStartupReattach(repo: RepoContext): Promise<void> {
  const dir = resolve(repo.localPath, ".danxbot", "issues", "open");
  if (!existsSync(dir)) return;
  const issues: Issue[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    try {
      const issue = await loadLocal(repo.localPath, stem, repo.issuePrefix);
      if (issue && issue.dispatch !== null) {
        issues.push(issue);
      }
    } catch (err) {
      log.warn(
        `[${repo.name}] reattach: skipping ${entry}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (issues.length === 0) return;

  const plan = buildReattachPlan(issues, {
    currentHost: osHostname(),
    now: Date.now(),
    isPidAlive,
  });

  for (const action of plan.alive) {
    log.info(
      `[${repo.name}] reattach: ${action.issue.id} alive (pid=${action.issue.dispatch!.pid}, dispatch=${action.issue.dispatch!.id}) — left in place`,
    );
  }

  for (const action of plan.cleared) {
    log.warn(
      `[${repo.name}] reattach: clearing ${action.issue.id} (verdict=${action.verdict.kind}, dispatch=${action.issue.dispatch!.id})`,
    );
    try {
      void clearDispatchAndWrite(repo.localPath, action.issue).catch((err) =>
        log.warn(
          `[${repo.name}] reattach: clearDispatch mirror ack failed for ${action.issue.id}`,
          err,
        ),
      );
    } catch (err) {
      log.error(
        `[${repo.name}] reattach: clearDispatch failed for ${action.issue.id}`,
        err,
      );
    }
  }
}

function getState(repoName: string): RepoPollerState {
  let state = repoState.get(repoName);
  if (!state) {
    state = {
      polling: false,
      intervalId: null,
    };
    repoState.set(repoName, state);
  }
  return state;
}

/**
 * Cache of one IssueTracker per repo, populated lazily by `getRepoTracker`.
 *
 * The cache is essential for `MemoryTracker` (`DANXBOT_TRACKER=memory`):
 * a fresh tracker per tick would lose every card it ever stored, breaking
 * any Layer 3 scenario that drives a full ToDo → In Progress → Done
 * lifecycle through repeated `poll()` calls. With caching, the in-memory
 * card sequence survives the entire run. `TrelloTracker` also benefits —
 * `checklistIdCache` and `triagedLabelIdCache` survive across ticks
 * instead of cold-starting every minute.
 *
 * **Lifecycle invariant:** the cache lives until process restart. The
 * worker never rotates `RepoContext` at runtime — credential changes
 * require a redeploy, which recreates the worker container, which
 * tears down this Map naturally. Adding a future tracker with
 * refreshable / short-lived auth (OAuth, rotating tokens) would need
 * to invalidate selectively here; until then, no production code path
 * reads or writes the cache outside `getRepoTracker`.
 *
 * Cleared by `_resetForTesting` so per-test isolation works.
 */
const trackerByRepo = new Map<string, IssueTracker>();

function getRepoTracker(repo: RepoContext): IssueTracker {
  let tracker = trackerByRepo.get(repo.name);
  if (!tracker) {
    tracker = createIssueTracker(repo);
    trackerByRepo.set(repo.name, tracker);
  }
  return tracker;
}

/**
 * Check Needs Help cards for user responses. Cards where a user has replied
 * (latest comment lacks the danxbot marker) are moved to the top of ToDo
 * so they get higher priority than existing ToDo cards.
 *
 * `tracker.getComments` returns comments sorted ascending by timestamp,
 * so the LAST element is the most recent — opposite of the retired
 * Trello-direct comment fetch (which used `limit=1` against an endpoint
 * that returned newest-first). Both produce the same answer: is the
 * most recent comment from the user (no danxbot marker)?
 */
async function checkNeedsHelp(
  repo: RepoContext,
  tracker: IssueTracker,
): Promise<number> {
  let refs: IssueRef[];
  try {
    const all = await tracker.fetchOpenCards();
    refs = all.filter((c) => c.status === "Blocked");
  } catch (error) {
    log.error(`[${repo.name}] Error fetching Needs Help cards`, error);
    return 0;
  }

  if (refs.length === 0) return 0;

  let movedCount = 0;
  for (const ref of refs) {
    try {
      const comments = await tracker.getComments(ref.external_id);
      const latest = comments.length > 0 ? comments[comments.length - 1] : null;
      if (latest && !latest.text.includes(DANXBOT_COMMENT_MARKER)) {
        log.info(
          `[${repo.name}] User responded on "${ref.title}" — moving to ToDo`,
        );
        await tracker.moveToStatus(ref.external_id, "ToDo");
        movedCount++;
      }
    } catch (error) {
      log.error(
        `[${repo.name}] Error checking comments for card "${ref.title}"`,
        error,
      );
    }
  }

  return movedCount;
}

export async function poll(repo: RepoContext): Promise<void> {
  const state = getState(repo.name);
  if (state.polling) {
    return;
  }

  // Runtime toggle — when the Trello poller is disabled for this repo
  // via the settings file, skip the tick entirely. Checked per-tick so
  // operators can toggle without a worker restart. See
  // `.claude/rules/settings-file.md`.
  if (!isFeatureEnabled(repo, "issuePoller")) {
    log.info(`[${repo.name}] poller disabled via settings — skipping`);
    return;
  }

  // Critical-failure halt gate. When the agent signaled
  // `critical_failure` or the post-dispatch check caught a dispatch
  // that didn't move its card out of ToDo, a flag file is written at
  // `<repo>/.danxbot/CRITICAL_FAILURE`. The poller refuses to run
  // while the flag is present — a human must clear it (via `rm` or the
  // dashboard DELETE endpoint) after fixing the underlying env issue.
  // Slack listener and /api/launch are unaffected by design — the
  // halt is poller-only. See `.claude/rules/agent-dispatch.md`
  // "Critical failure flag".
  const flag = readFlag(repo.localPath);
  if (flag) {
    log.warn(
      `[${repo.name}] poller halted — critical-failure flag present (source=${flag.source}, dispatch=${flag.dispatchId}): ${flag.reason}`,
    );
    return;
  }

  state.polling = true;
  try {
    await _poll(repo);
  } finally {
    state.polling = false;
  }
}

async function _poll(repo: RepoContext): Promise<void> {
  // DX-149: top-level crash isolation.
  //
  // Any tracker call inside `_poll` (other than `tracker.fetchOpenCards`,
  // which has its own inner try/catch below) historically threw
  // straight past `_poll` and out through `poll()`'s `finally`,
  // killing the whole worker process. Production hit this when a
  // local YAML carried a stale `external_id` (e.g. `mem-2` from an
  // earlier `MemoryTracker` run) and the repo later switched to
  // Trello — `tryAcquireLock` → `tracker.getComments` returned
  // 400 and the entire worker died: Slack listener, dispatch API,
  // dashboard SSE, all gone.
  //
  // The wrap is intentionally one block, not per-call. Per-call
  // try/catches multiply boilerplate and don't cover future tracker
  // calls. The next tick re-runs the whole `_poll` body
  // idempotently, so partial completion inside this function is
  // already a non-issue. Keep `state.polling` reset in `poll()`'s
  // finally — this catch must not touch it (would mask state bugs)
  // and must not increment `state.consecutiveFailures` /
  // `state.backoffUntil` (those bookkeep dispatch failures, not
  // poller crashes — DX-130 follow-on phases own that surface).
  //
  // Tests: see `describe("poll — _poll crash isolation (DX-149)")`
  // in `index.test.ts`.
  try {
  // Re-run the inject pipeline every tick (not just at worker boot) so
  // changes inside `.danxbot/config/` propagate to dispatched agents
  // without a restart. `syncRepoFiles` is idempotent — see its
  // docstring + the per-workspace render loop inside.
  syncRepoFiles(repo);

  // DX-217 (Event-Driven Worker Phase 2): the per-tick `healLocalYamls`
  // pass (ISS-133 Phase 3) was absorbed into `reconcileIssue` step 3c.
  // Every YAML mutation fires the chokidar watcher → reconcile, which
  // moves the file to the correct bucket on the same trigger. Phase 5
  // reintroduces a 1-min audit pass that calls `reconcileIssue` on
  // every open YAML to catch any drift from event-loss; until then,
  // chokidar coverage + the boot scan are the safety nets.

  // ONE tracker per repo, reused across every tick (see `getRepoTracker`).
  // Resolved early so the external-id format heal below has a tracker to
  // ask `isValidExternalId` against — every later helper reuses this
  // instance, so `MemoryTracker` state survives the tick and tests can
  // assert on a single mock.
  const tracker = getRepoTracker(repo);

  // DX-150: per-tick `external_id` format heal pass. Walks open/ AND
  // closed/, blanks any external_id whose format the active tracker
  // doesn't recognize (e.g. `mem-N` minted by a `MemoryTracker` window
  // before a Trello-config landed). The blanked YAML re-enters the
  // reconcile-driven push path (DX-218 step 7) on its next chokidar
  // event and gets a fresh tracker-native id. Pairs with DX-149 —
  // DX-149 stopped the 400 from crashing the worker; this stops the
  // 400 from happening at all by removing the foreign id from disk.
  // Runs BEFORE every tracker call (no `tracker.getCard` /
  // `getComments` against the bad id ever fires).
  const externalIdHeal = healExternalIds(
    repo.localPath,
    tracker,
    repo.issuePrefix,
  );
  for (const h of externalIdHeal.healed) {
    log.info(
      `[${repo.name}] Healed external_id mismatch on ${h.id}: ${h.oldExternalId} → "" (tracker.isValidExternalId rejected)`,
    );
  }
  for (const e of externalIdHeal.errors) {
    log.warn(
      `[${repo.name}] external_id heal skipped malformed YAML at ${e.path}: ${e.message}`,
    );
  }

  // DX-218 (Event-Driven Worker Phase 3): the per-tick `drainRetries`
  // call is gone. Retry-queue entries arm a `setTimeout` for their
  // backoff window inside `enqueueRetry`; the timer callback fires
  // within ms of the window expiring instead of waiting up to one
  // poller tick (~30-90s saved on average). Boot-rescheduling is wired
  // in `src/index.ts` so retries persisted across a worker restart
  // resume on schedule. The `recordSystemError` hook for max-attempts
  // exhaustion is registered per-repo via
  // `setRetryQueueSystemErrorHookForRepo` in `src/index.ts`.

  // DX-290 (Event-Driven Worker Phase 4b.3): the per-tick
  // `evictDeadDispatches` walk is gone. Per-dispatch TTL timers in
  // `src/dispatch/ttl-timer.ts` (DX-289) handle dead-dispatch eviction
  // event-driven — when the TTL expires the timer probes liveness and
  // (on dead PID) clears the YAML's `dispatch{}` block via reconcile.

  // Phase 3 (DX-142) — process-table orphan scan. The DB-driven
  // reattach pass at boot + the YAML-driven `evictDeadDispatches`
  // above both look at KNOWN records and ask "is the recorded PID
  // alive?" Neither asks "is there a live dispatch process I have
  // no record of?" — which is exactly the failure shape the May-7
  // incident hit. `reapOrphans` enumerates every dispatched claude
  // process via `pgrep -af '<!-- danxbot-dispatch:'` and SIGTERMs
  // the ones whose DB row went terminal (or never existed) while
  // the OS process kept running. See `src/worker/process-scan.ts`
  // for the per-process decision matrix; failures swallowed so a
  // bad scan tick can't take down the poller.
  try {
    const reaped = await reapOrphans({
      repoName: repo.name,
      repoLocalPath: repo.localPath,
    });
    if (
      reaped.reaped.length > 0 ||
      reaped.mismatched.length > 0
    ) {
      log.info(
        `[${repo.name}] Orphan reaper (tick): scanned=${reaped.scanned} reaped=${reaped.reaped.length} mismatched=${reaped.mismatched.length} healthy=${reaped.healthy}`,
      );
    }
  } catch (err) {
    log.error(`[${repo.name}] Orphan reaper (tick) failed`, err);
  }

  // ISS-98 / DX-210 follow-up: derive parent (Epic + non-epic) statuses
  // DX-217 (Event-Driven Worker Phase 2): the per-tick parent-status
  // derive pass (ISS-98) was absorbed into `reconcileIssue` step 3a.
  // Every child save fires chokidar → reconcile, whose step 9 recurses
  // on the parent and re-derives its status from the new union of
  // children. Phase 5 reintroduces a 1-min audit pass for drift
  // recovery.

  // DX-302 — `trelloSync` is a per-repo override that halts every Trello
  // inbound + outbound call without halting the WHOLE poll tick (the
  // existing `issuePoller` toggle does that — it gates `poll()` itself
  // up front and never reaches `_poll`). When `trelloSync` is `false`
  // the operator wants local-YAML dispatch to keep running but every
  // Trello call must short-circuit: inbound hydration, comment pull,
  // outbound mirror, retry queue, auto-sync. This block guards the
  // inbound half (checkNeedsHelp + fetchOpenCards + bulkSyncMissingYamls);
  // the outbound auto-sync + retry-queue gates live in their own modules.
  const trelloSyncEnabled = isFeatureEnabled(repo, "trelloSync");
  if (!trelloSyncEnabled) {
    log.info(
      `[${repo.name}] trello sync disabled via settings — skipping inbound hydration + comment pull`,
    );
  } else {
    log.info(`[${repo.name}] Checking Needs Help + ToDo lists...`);

    // Check Needs Help first — user-responded cards get moved to ToDo top
    const movedFromNeedsHelp = await checkNeedsHelp(repo, tracker);
    if (movedFromNeedsHelp > 0) {
      log.info(
        `[${repo.name}] Moved ${movedFromNeedsHelp} card${movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`,
      );
    }
  }

  let openCards: IssueRef[] = [];
  if (trelloSyncEnabled) {
    try {
      openCards = await tracker.fetchOpenCards();
    } catch (error) {
      log.error(`[${repo.name}] Error fetching cards`, error);
      return;
    }
  }
  // ISS-86: tracker.fetchOpenCards() is the inbound channel ONLY (new
  // cards + bulk-sync). It does NOT decide what gets dispatched —
  // local YAML is the source of truth. The tracker-derived partitions
  // below exist solely to drive the inbound mirror
  // (`bulkSyncMissingYamls`). DX-218 retired the per-tick orphan-push
  // pass; outbound (YAML → tracker) pushes are now reconcile step 7's
  // job. DX-290 retired the dispatch + stuck-card scan from this body
  // entirely; the scheduler's `runPicker` callback (registered in
  // `src/index.ts`) reads `listDispatchableYamls` /
  // `listInProgressYamls` itself on each event-driven pick.
  //
  // Cards on the Trello Action Items list surface with
  // `status: "Review"` (see `trello.ts#listIdToStatus`) so they are
  // bulk-synced through the Review branch alongside other Review
  // cards.
  const trackerToDoRefs = openCards.filter((c) => c.status === "ToDo");
  const trackerInProgressRefs = openCards.filter(
    (c) => c.status === "In Progress",
  );
  const trackerReviewRefs = openCards.filter((c) => c.status === "Review");
  const trackerNeedsHelpRefs = openCards.filter(
    (c) => c.status === "Blocked",
  );

  // Bulk-sync every tracker-listed card that lacks a local YAML so the
  // multi-agent dispatch path (`src/poller/multi-agent-pick.ts`,
  // scheduled via the scheduler's `runPicker` callback) and the per-
  // card triage agent each have a YAML to read. Coverage:
  //   - Every ToDo card (DX-290: previously the primary was sliced off
  //     because the legacy single-card path had its own dedicated
  //     hydrate-or-stamp pipeline that took the primary directly; that
  //     pipeline is gone, so we hydrate the whole bucket here).
  //   - Every In Progress card (closes the gap where a worker died
  //     before writing the YAML).
  //   - Every Review card (so the per-card triage agent can read it
  //     locally) — Phase 4 of ISS-90 added this branch when the
  //     Action Items list collapsed into `status: "Review"`.
  //   - Every Needs Help card (same reason as Review — the triage
  //     agent's Hard Gate audit needs the local YAML).
  // Bulk-sync writes carry `dispatch: null`; the dispatch primary's
  // record is stamped by `stampDispatchAndWrite` inside the multi-agent
  // picker. An In Progress orphan keeps its existing `dispatch` because
  // `findByExternalId` short-circuits hydration when the YAML already
  // exists.
  await bulkSyncMissingYamls(repo, tracker, [
    ...trackerToDoRefs,
    ...trackerInProgressRefs,
    ...trackerReviewRefs,
    ...trackerNeedsHelpRefs,
  ]);

  // DX-218 (Event-Driven Worker Phase 3): the per-tick orphan push was
  // removed — empty-`external_id` YAMLs hit the tracker via reconcile
  // step 7 (`pushTrelloDiff`'s `external_id === ""` branch) on the
  // chokidar event for the YAML write itself. Hand-written and
  // `danx_issue_create` YAMLs reach Trello in <1s of the file event
  // instead of waiting up to one poller tick (~30-60s). Persistent
  // tracker errors enqueue into the event-driven retry queue.

  // DX-217 (Event-Driven Worker Phase 2): the post-hydrate parent
  // recompute pass (the second `recomputeParentStatuses` call) was
  // absorbed into `reconcileIssue`. The chokidar watcher fires reconcile
  // for every freshly-hydrated YAML the bulk-sync block above just
  // wrote, so step 9's parent recursion picks up new children inside
  // the same tick. Phase 5 reintroduces a 1-min audit pass for drift
  // recovery.

  // DX-286 — per-tick orphan invariant scan. Walks every open YAML and
  // clears any card violating
  // `(dispatch !== null) === (assigned_agent !== null)` when the
  // underlying dispatch (if any) is verifiably dead. Catches both XOR
  // directions in one pass; the liveness gate inside the scan protects
  // in-flight paired-writes. Cleared orphans surface back to the
  // scheduler's `runPicker` callback in `src/index.ts` via the chokidar
  // → reconcile → `onReconcileResult` event chain on the same tick.
  // Same scan runs once at boot (`src/index.ts`) for pre-fix-bug residue.
  await runInvariantHeal(repo, "per-tick");

  // DX-290 (Event-Driven Worker Phase 4b.3): every dispatch decision is
  // gone from `_poll`. The scheduler's `runPicker` callback (registered
  // by `bootScheduler` in `src/index.ts`, fired via reconcile's
  // `onReconcileResult` and settings-watch's `onAgentRosterChange`)
  // owns multi-agent picks; per-card `setTimeout`s in
  // `src/dispatch/triage-timer.ts` + `src/dispatch/ttl-timer.ts`
  // (DX-289) own triage + dead-dispatch eviction. The legacy
  // `tryResumeOrphan`, `tryTriageDispatch`, `checkAndSpawnIdeator`,
  // `recoverStuckCards`, `evictDeadDispatches`, the dispatchable /
  // in-progress partitioning, the pickup-name-prefix filter, and the
  // DX-242 legacy single-card dispatch block all moved out in DX-290.
  // The auto-clear pass (DX-147 / `resolveWaitingOnCards`) is read-time
  // via `effectiveWaitingOn` (`src/issue/effective-waiting-on.ts`). The
  // remaining `_poll` body is sync + audit only — Phase 5 (DX-220)
  // trims further and renames the module.
  } catch (error) {
    // DX-149: any throw from inside `_poll` (tracker calls, lock
    // acquisition, hydrate-or-load, dispatch shell prep) lands here
    // so the worker process survives. The inner try/catch around
    // `tracker.fetchOpenCards` already returns early on its own
    // failure mode — that path never reaches here.
    //
    // No `recordError` / dashboard surface yet — DX-134 owns that
    // SSE channel + UI banner. Until then, `log.error` is the
    // contract: a single, attributable line per dropped tick.
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      `[${repo.name}] _poll crashed — tick aborted, next tick will retry: ${message}`,
      error,
    );
  }
}

/**
 * Hydrate every card in `targets` that has no local YAML. Tolerates
 * per-card failures (warns + skips) — bulk-sync is a best-effort
 * convergence step. The dispatch primary's hydration runs separately
 * with throw-on-failure semantics.
 *
 * `dispatch` is null for every bulk-synced YAML — these are
 * advisory writes that capture remote state, not dispatch claims. A
 * subsequent tick that picks the card as a primary (ToDo) or as a
 * resume target (In Progress with a stamped id from a prior dispatch)
 * stamps the real UUID via `stampDispatchAndWrite`.
 */
async function bulkSyncMissingYamls(
  repo: RepoContext,
  tracker: IssueTracker,
  targets: IssueRef[],
): Promise<void> {
  for (const card of targets) {
    if (await findByExternalId(repo.localPath, card.external_id)) continue;
    try {
      const hydrated = await hydrateFromRemote(
        tracker,
        card.external_id,
        null,
        repo.localPath,
        repo.issuePrefix,
      );
      await writeIssue(repo.localPath, hydrated);
      log.info(
        `[${repo.name}] bulk-sync: hydrated ${card.external_id} → ${hydrated.id}`,
      );
    } catch (err) {
      log.warn(
        `[${repo.name}] bulk-sync: failed to hydrate ${card.external_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// DX-217 (Phase 2): the per-tick `waiting_on` auto-clear pass
// (DX-147 / `resolveWaitingOnCards`) was retired in favor of read-time
// derivation via `effectiveWaitingOn` (`src/issue/effective-waiting-on.ts`).
// `waiting_on` is now a durable record; the dispatch gate at read time
// checks whether every id in `by[]` resolves to a terminal status.
//
// DX-290 (Phase 4b.3): the `tryResumeOrphan` helper that called
// `spawnClaude` to resume orphan In Progress dispatches was retired
// along with `spawnClaude` itself. The TTL timer
// (`src/dispatch/ttl-timer.ts`) clears dead dispatch records via
// audit-reconcile; the multi-agent path's `guardLiveDispatchForCard`
// (`src/dispatch/scheduler.ts`) protects against double-dispatch when
// a host-mode claude is reparented to PID 1 across worker restart.


/** Directory containing files to inject into target repos. */
const injectDir = resolve(dirname(fileURLToPath(import.meta.url)), "inject");

/**
 * Validate that .danxbot/config/ in the connected repo and env vars are fully configured.
 * Throws if anything is missing or empty — the poller must not run without valid config.
 */
export function validateRepoConfig(repo: RepoContext): void {
  const errors: string[] = [];
  const danxbotConfigDir = resolve(repo.localPath, ".danxbot/config");

  // 1. .danxbot/config/ directory must exist in the connected repo
  if (!existsSync(danxbotConfigDir)) {
    throw new Error(
      `[${repo.name}] .danxbot/config/ not found in connected repo. Run ./install.sh to set up danxbot.`,
    );
  }

  // 2. Required files must exist and not be empty
  const requiredFiles = [
    { path: "config.yml", label: "Repo configuration" },
    { path: "overview.md", label: "Repo overview" },
    { path: "workflow.md", label: "Repo workflow" },
    { path: "trello.yml", label: "Trello board/list/label IDs" },
  ];

  for (const { path, label } of requiredFiles) {
    const fullPath = resolve(danxbotConfigDir, path);
    if (!existsSync(fullPath)) {
      errors.push(`Missing .danxbot/config/${path} (${label})`);
    } else {
      const content = readFileSync(fullPath, "utf-8").trim();
      if (!content) {
        errors.push(`Empty .danxbot/config/${path} (${label})`);
      }
    }
  }

  // 3. config.yml must have required fields with non-empty values
  const repoConfigYml = resolve(danxbotConfigDir, "config.yml");
  if (existsSync(repoConfigYml)) {
    const raw = readFileSync(repoConfigYml, "utf-8");
    const cfg = parseSimpleYaml(raw);

    const requiredFields = [
      { key: "name", label: "Repo name" },
      { key: "url", label: "Repo URL" },
      { key: "runtime", label: "Runtime (docker or local)" },
      { key: "language", label: "Language" },
    ];

    for (const { key, label } of requiredFields) {
      if (!cfg[key] || !cfg[key].trim()) {
        errors.push(
          `Missing '${key}' in .danxbot/config/config.yml (${label})`,
        );
      }
    }

    // If runtime is docker, compose config is required
    if (cfg.runtime === "docker") {
      const dockerFields = [
        { key: "docker.compose_file", label: "Docker compose file" },
        { key: "docker.service_name", label: "Docker service name" },
        { key: "docker.project_name", label: "Docker project name" },
      ];
      for (const { key, label } of dockerFields) {
        if (!cfg[key] || !cfg[key].trim()) {
          errors.push(
            `Missing '${key}' in .danxbot/config/config.yml (${label} — required when runtime is docker)`,
          );
        }
      }

      // Compose file must actually exist
      const composeFile = resolve(danxbotConfigDir, "compose.yml");
      if (!existsSync(composeFile)) {
        errors.push(
          `Missing .danxbot/config/compose.yml (required when runtime is docker)`,
        );
      }
    }
  }

  // 4. Required environment variables (secrets)
  const requiredEnvVars = [
    { name: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
  ];

  for (const { name, label } of requiredEnvVars) {
    const value = process.env[name];
    if (!value || !value.trim()) {
      errors.push(`Missing env var ${name} (${label})`);
    }
  }

  // 5. Per-repo secrets must be set (loaded via RepoContext)
  if (!repo.trello.apiKey)
    errors.push(`Missing DANX_TRELLO_API_KEY in ${repo.name}/.danxbot/.env`);
  if (!repo.trello.apiToken)
    errors.push(`Missing DANX_TRELLO_API_TOKEN in ${repo.name}/.danxbot/.env`);
  if (!repo.githubToken)
    errors.push(`Missing DANX_GITHUB_TOKEN in ${repo.name}/.danxbot/.env`);

  // 6. Claude auth files must exist
  const claudeAuthDir = resolve(projectRoot, "claude-auth");
  const claudeJson = resolve(claudeAuthDir, ".claude.json");
  if (!existsSync(claudeJson)) {
    errors.push(
      `Missing claude-auth/.claude.json (Claude Code credentials — run ./install.sh Step 6)`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `[${repo.name}] Repo config validation failed:\n  - ${errors.join("\n  - ")}\n\nRun ./install.sh to complete setup.`,
    );
  }

  log.info(`[${repo.name}] Repo config validated successfully`);
}

/**
 * The `.claude/` subtree the inject pipeline writes per-repo files
 * into. Every dispatched agent cwds into one of the plural workspaces
 * at `<repo>/.danxbot/workspaces/<name>/` (agent-isolation +
 * workspace-dispatch epics, Trello `7ha2CSpc`/`jAdeJgi5`), so that's
 * where per-repo rendered rules + tools must land — duplicated into
 * each workspace dir so cwd-relative skill references like
 * `.claude/rules/danx-repo-config.md` resolve LOCALLY without claude
 * having to walk ancestor `.claude/` dirs (which would land on the
 * developer's repo-root `.claude/`, an isolation contract violation
 * that produced the Phase 6 stale-board-IDs incident).
 *
 * The repo-root `.claude/` is strictly developer-owned. Danxbot neither
 * reads nor writes there; `scrubRepoRootDanxArtifacts` actively removes
 * any leftover `danx-*` files at repo-root on every tick.
 */
interface InjectTarget {
  rulesDir: string;
  skillsDir: string;
  toolsDir: string;
}

function buildInjectTarget(workspaceRoot: string): InjectTarget {
  return {
    rulesDir: resolve(workspaceRoot, ".claude/rules"),
    skillsDir: resolve(workspaceRoot, ".claude/skills"),
    toolsDir: resolve(workspaceRoot, ".claude/tools"),
  };
}

function chmodExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch (e) {
    log.warn(`Failed to chmod ${path}:`, e);
  }
}

/**
 * Names of every `danx-*` rule that `renderPerRepoFilesIntoWorkspaces`
 * writes into a workspace's `.claude/rules/` every tick. Lives here
 * alongside the writers so adding a new per-repo rendered rule is a
 * single-edit change — both the writer below and the
 * `pruneStaleDanxArtifactsInWorkspace` allowlist consume this set, so
 * the prune cannot drift out of sync with the render. Adding a new
 * rendered rule without updating this set would cause the prune to
 * silently delete it on the next tick.
 *
 * Skills directory has no per-repo renders today; if that changes, add
 * a sibling set + thread it through the prune.
 */
export const PER_REPO_RENDER_RULE_NAMES: ReadonlySet<string> = new Set([
  "danx-repo-config.md",
  "danx-repo-overview.md",
  "danx-repo-workflow.md",
  "danx-tools.md",
  "danx-issue-prefix.md",
]);

/** Step 1: render danx-repo-config.md from config.yml to the workspace. */
function writeRepoConfigRule(
  cfg: Record<string, string>,
  target: InjectTarget,
): void {
  writeFileSync(
    resolve(target.rulesDir, "danx-repo-config.md"),
    renderRepoConfigMarkdown(cfg),
  );
}

/** Step 2: overview.md + workflow.md -> danx-repo-{overview,workflow}.md. */
function copyRepoConfigDocs(
  danxbotConfigDir: string,
  target: InjectTarget,
): void {
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["overview.md", "danx-repo-overview.md"],
    ["workflow.md", "danx-repo-workflow.md"],
  ];
  for (const [src, dest] of mappings) {
    const srcPath = resolve(danxbotConfigDir, src);
    if (!existsSync(srcPath)) continue;
    const header = `<!-- AUTO-GENERATED by danxbot from .danxbot/config/${src} — do not edit -->\n\n`;
    writeFileSync(
      resolve(target.rulesDir, dest),
      header + readFileSync(srcPath, "utf-8"),
    );
  }
}

/**
 * Step 2b: render `danx-issue-prefix.md` from `RepoContext.issuePrefix`.
 *
 * Carries the live per-repo issue prefix (e.g. `DX`, `SG`, `FD`) so
 * workspace skills can reference the actual literal when prose
 * convention `<PREFIX>-N` is insufficient (e.g. examples that need a
 * concrete id, scripts that templated the prefix). Phase 4 of DX-99 —
 * the source-of-truth lookup point for the live value at agent-dispatch
 * time. The prose layer (skills + rules) generally uses `<PREFIX>-N`
 * as a placeholder; this file is the escape hatch for the rare case
 * the literal is needed.
 */
function writeIssuePrefixRule(
  issuePrefix: string,
  target: InjectTarget,
): void {
  const body =
    `<!-- AUTO-GENERATED by danxbot — do not edit. Source: <repo>/.danxbot/config/config.yml#issue_prefix -->\n` +
    `\n` +
    `# Issue ID Prefix\n` +
    `\n` +
    `This repo's issue id prefix is **\`${issuePrefix}\`**.\n` +
    `\n` +
    `Every issue id in this repo has the shape \`${issuePrefix}-<N>\` (e.g. \`${issuePrefix}-1\`, \`${issuePrefix}-42\`). When skill prose says \`<PREFIX>-N\`, substitute \`${issuePrefix}\`. When you need a literal example id in a comment or commit message, use a real \`${issuePrefix}-N\` from this repo.\n`;
  writeFileSync(resolve(target.rulesDir, "danx-issue-prefix.md"), body);
}

/** Step 3: repo-specific tools.md -> danx-tools.md. */
function copyRepoToolsDoc(
  danxbotConfigDir: string,
  target: InjectTarget,
): void {
  const src = resolve(danxbotConfigDir, "tools.md");
  if (!existsSync(src)) return;
  copyFileSync(src, resolve(target.rulesDir, "danx-tools.md"));
}

/** Step 4: repo-specific tool scripts -> .claude/tools/ (executable). */
function copyRepoToolScripts(
  danxbotConfigDir: string,
  target: InjectTarget,
): void {
  const src = resolve(danxbotConfigDir, "tools");
  if (!existsSync(src)) return;
  for (const file of readdirSync(src)) {
    const dest = resolve(target.toolsDir, file);
    copyFileSync(resolve(src, file), dest);
    chmodExecutable(dest);
  }
}

/**
 * Step 5: danxbot-shipped scripts -> `<repo>/.danxbot/scripts/` (executable).
 *
 * Currently mirrors `agent-finalize.sh` (DX-162 / multi-worker dispatch
 * epic DX-158) — the agent's per-dispatch completion helper. Lives in
 * `src/poller/inject/scripts/` and lands in EVERY connected repo on
 * EVERY poll tick. Scope is intentionally repo-wide (not per-workspace):
 * the script is invoked from inside an agent's git worktree at
 * `<repo>/.danxbot/worktrees/<agent>/`, NOT from a workspace directory,
 * so the path agents reference (`.danxbot/scripts/agent-finalize.sh`)
 * resolves correctly relative to the worktree's repo root.
 *
 * Contract mirrors `injectDanxWorkspaces`:
 *   - **Idempotent.** `writeIfChanged` skips writes when content is
 *     byte-identical so inodes stay stable across ticks.
 *   - **Write-only.** Scripts retired from the inject source survive
 *     at target — there is no prune. The set is small and operator-
 *     visible enough that drift here is preferable to accidentally
 *     nuking an operator-authored script that lives alongside ours.
 *   - **Executable bit.** Every `.sh` file gets `chmod 0755` — the
 *     agent invokes them via `bash <path>` but operators / CI scripts
 *     may run them directly.
 *   - **Empty source dir is a no-op** — useful for tests that scaffold
 *     a poller against a stripped-down danxbot tree.
 */
function injectDanxbotScripts(repoLocalPath: string): void {
  const sourceDir = resolve(injectDir, "scripts");
  if (!existsSync(sourceDir)) return;
  const targetDir = resolve(repoLocalPath, ".danxbot", "scripts");
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const srcPath = resolve(sourceDir, entry);
    if (!statSync(srcPath).isFile()) continue;
    const destPath = resolve(targetDir, entry);
    writeIfChanged(destPath, readFileSync(srcPath, "utf-8"));
    if (entry.endsWith(".sh")) chmodExecutable(destPath);
  }
}

/**
 * Step 6b: inject/workspaces/<name>/ -> <repo>/.danxbot/workspaces/<name>/.
 *
 * Part of the workspace-dispatch epic (Trello `jAdeJgi5`, Phase 2). Every
 * named workspace under `src/poller/inject/workspaces/` is mirrored in
 * full into the connected repo so every triggered agent can cwd into an
 * isolated `<repo>/.danxbot/workspaces/<name>/` directory containing its
 * own `workspace.yml`, `.mcp.json`, `.claude/` subtree, and `CLAUDE.md`.
 *
 * Contract:
 *   - **Idempotent.** Uses `writeIfChanged` so unchanged files don't bump
 *     inode timestamps. Repeated calls converge on identical disk state.
 *   - **Recursive.** Workspaces have nested structure (`.claude/skills/
 *     <skill>/SKILL.md`, `.claude/agents/*.md`, `tools/*.sh`). The walk
 *     descends to arbitrary depth.
 *   - **Write-only — NEVER deletes.** Files / dirs / workspaces removed
 *     from `inject/workspaces/` survive at target on the next tick. The
 *     poller has no business deleting anything in a connected repo; that
 *     authority belongs to git (for tracked files) or the operator (for
 *     gitignored stragglers via `git clean -fdX`). Earlier revisions
 *     wholesale-rmSync'd workspace dirs absent from source — that nuked
 *     a gpt-manager-authored `schema-builder/` workspace tracked in
 *     gpt-manager's git, blast-radius incident the contract now forbids.
 *   - **Executable bit.** `.sh` files nested under a `tools/` ancestor
 *     (at any depth inside the workspace) get `chmod 0755`. Anything
 *     else keeps default perms. The check is intentionally narrow — a
 *     `.sh` file at the workspace root is NOT made executable; only
 *     shell helpers the agent will invoke as commands via the injected
 *     `tools/` PATH contract.
 *   - **Empty source is a no-op.** In Phase 2 no fixtures ship — the
 *     helper exists so Phases 3/4/5 can drop workspace subtrees in
 *     place without touching the inject wiring. The function still
 *     ensures the target root directory is created so the on-disk shape
 *     `<repo>/.danxbot/workspaces/` is present after the first tick.
 *
 * See `.claude/rules/agent-dispatch.md` "Workspace isolation" and the
 * Phase 1 resolver contract in `src/workspace/resolve.ts` for how the
 * mirrored trees are consumed at dispatch time.
 */
function injectDanxWorkspaces(workspacesTargetDir: string): void {
  const injectWorkspacesDir = resolve(injectDir, "workspaces");
  mkdirSync(workspacesTargetDir, { recursive: true });
  if (!existsSync(injectWorkspacesDir)) return;

  // Filter to directories only — the workspaces root may contain
  // tombstone files (e.g. `.gitkeep`) that keep the dir tracked when no
  // fixtures ship. Treating those as workspace names crashes the
  // recursive walk (ENOTDIR on `readdirSync(<file>)`) and was the bug
  // surfaced by `make test-system-poller` after P3.
  const sourceNames = readdirSync(injectWorkspacesDir).filter((entry) =>
    statSync(resolve(injectWorkspacesDir, entry)).isDirectory(),
  );

  for (const name of sourceNames) {
    const workspaceSourceDir = resolve(injectWorkspacesDir, name);
    const workspaceDir = resolve(workspacesTargetDir, name);
    mirrorWorkspaceTree(workspaceSourceDir, workspaceDir, []);
  }

  // Phase 5 cleanup (Trello 69f76e8d069eb71dd315d363): the migration
  // window for the legacy `trello-worker` symlink has closed. Remove
  // any leftover symlink so the workspace listing reflects only the
  // canonical name. Real directories at that path are preserved
  // (operator-authored workspaces, e.g. gpt-manager's schema-builder
  // sibling pattern). See `legacy-trello-worker-scrub.ts`.
  scrubLegacyTrelloWorkerSymlink(workspacesTargetDir);

  // Per-workspace post-mirror steps over EVERY workspace present at
  // target — both inject-sourced AND operator-authored (e.g.
  // gpt-manager's schema-builder, trello-worker). Operator-authored
  // workspaces have no inject source dir, but still receive per-repo
  // rendered rules from `renderPerRepoFilesIntoWorkspaces` and so are
  // equally subject to stale `danx-*` rule accumulation. Passing a
  // non-existent inject source path is handled by the prune fn via
  // its `existsSync` checks.
  for (const entry of readdirSync(workspacesTargetDir)) {
    const workspaceDir = resolve(workspacesTargetDir, entry);
    if (!statSync(workspaceDir).isDirectory()) continue;
    injectMcpServers(workspaceDir);
    stripHostUnreachableMcpServers(workspaceDir);
    injectSharedWorktreeGuardHook(workspaceDir);
    pruneStaleDanxArtifactsInWorkspace(
      resolve(injectWorkspacesDir, entry),
      workspaceDir,
    );
    pruneRetiredWorkspaceFiles(entry, workspaceDir);
  }
}

/**
 * DX-309: copy the shared `worktree-guard.mjs` PreToolUse hook into
 * `<workspace>/.claude/hooks/`. Single source of truth at
 * `src/poller/inject/_shared/hooks/worktree-guard.mjs`; the workspace's
 * own `.claude/settings.json` references the hook by relative path.
 * Cross-workspace sharing avoided the drift that copying-by-hand into
 * every workspace fixture would have caused.
 *
 * Idempotent via `writeIfChanged`. Exec bit stamped because some host
 * file systems lose it across copies; the hook is invoked as `node
 * <path>` so the bit is belt-and-suspenders rather than load-bearing.
 */
function injectSharedWorktreeGuardHook(workspaceDir: string): void {
  const source = resolve(
    injectDir,
    "_shared",
    "hooks",
    "worktree-guard.mjs",
  );
  if (!existsSync(source)) return;
  const targetDir = resolve(workspaceDir, ".claude", "hooks");
  mkdirSync(targetDir, { recursive: true });
  const targetPath = resolve(targetDir, "worktree-guard.mjs");
  writeIfChanged(targetPath, readFileSync(source, "utf-8"));
  chmodExecutable(targetPath);
}

/**
 * Host-mode dispatches run claude on the operator's machine; the inject
 * `.mcp.json` is authored for docker dispatches and references MCP
 * servers via danxbot-net DNS (e.g. `http://playwright:3000`). Those
 * hostnames don't resolve from the host, so the server appears as
 * "1 MCP server failed" in the agent's TUI and any tool call against it
 * times out. Strip such entries from the workspace `.mcp.json` post-
 * mirror when `config.isHost` so the host-mode agent sees only servers
 * it can actually reach.
 *
 * The list of host-unreachable entries is intentionally hard-coded:
 * every server we ship under `mcp-servers/` targets the danxbot-net
 * playwright container. A future dashboard toggle (filed separately)
 * will let operators opt in via host port mapping or remote URL.
 */
function stripHostUnreachableMcpServers(workspaceDir: string): void {
  if (!config.isHost) return;
  const mcpJsonPath = resolve(workspaceDir, ".mcp.json");
  if (!existsSync(mcpJsonPath)) return;
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  } catch {
    return;
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") return;
  const HOST_UNREACHABLE = new Set(["playwright"]);
  let removed = false;
  for (const name of Object.keys(parsed.mcpServers)) {
    if (HOST_UNREACHABLE.has(name)) {
      delete parsed.mcpServers[name];
      removed = true;
    }
  }
  if (!removed) return;
  writeIfChanged(mcpJsonPath, JSON.stringify(parsed, null, 2) + "\n");
}

/**
 * Step 6c: symlink danxbot's `mcp-servers/` directory into each workspace
 * as `<workspace>/mcp-servers`. The dispatched agent's cwd is the workspace
 * dir, so workspace `.mcp.json` files reference MCP server scripts via the
 * relative path `mcp-servers/<name>/src/index.ts`. The symlink keeps a
 * single source of truth (the danxbot install's `mcp-servers/`); edits
 * propagate to every workspace immediately and there is no copy to keep
 * in sync.
 *
 * Symlink target is the absolute path to `${projectRoot}/mcp-servers`.
 * `projectRoot` is the danxbot install root for THIS process (host →
 * `/home/.../danxbot`; container → `/danxbot/app`). The poller and the
 * dispatched agent share that install, so the symlink resolves correctly
 * for the runtime that wrote it.
 *
 * Idempotent: existing correct symlink is left alone; existing wrong
 * symlink (or stray directory left behind by an older copy-based
 * implementation) is replaced.
 */
function injectMcpServers(workspaceDir: string): void {
  const srcRoot = resolve(projectRoot, "mcp-servers");
  if (!existsSync(srcRoot)) return;
  const linkPath = resolve(workspaceDir, "mcp-servers");

  if (existsSync(linkPath) || isLinkOrFile(linkPath)) {
    if (isSymlink(linkPath) && readlinkSync(linkPath) === srcRoot) return;
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(srcRoot, linkPath, "dir");
}

/**
 * Recursive helper for `injectDanxWorkspaces`. Mirrors `srcDir` into
 * `destDir` and stamps executable bits. Write-only — never deletes
 * (see `injectDanxWorkspaces` contract). `relSegments` tracks the path
 * segments inside the workspace (NOT including the workspace name itself)
 * so `chmod` decisions can inspect ancestors — `.sh` files nested under a
 * `tools/` segment get `+x`.
 */
function mirrorWorkspaceTree(
  srcDir: string,
  destDir: string,
  relSegments: string[],
): void {
  mkdirSync(destDir, { recursive: true });
  const sourceEntries = readdirSync(srcDir);

  for (const entry of sourceEntries) {
    const srcPath = resolve(srcDir, entry);
    const destPath = resolve(destDir, entry);
    const childSegments = [...relSegments, entry];
    if (statSync(srcPath).isDirectory()) {
      mirrorWorkspaceTree(srcPath, destPath, childSegments);
    } else {
      writeIfChanged(destPath, readFileSync(srcPath, "utf-8"));
      // Executable bit for .sh scripts nested under a tools/ ancestor.
      // Checking ancestors (not just immediate parent) lets a workspace
      // organize tools into subdirs like `tools/mcp/*.sh` without
      // losing +x. Matching the literal `tools` segment keeps the
      // check narrow — a `.sh` at the workspace root is intentionally
      // not made executable.
      if (entry.endsWith(".sh") && relSegments.includes("tools")) {
        chmodExecutable(destPath);
      }
    }
  }
}

/**
 * Shared `danx-*`-artifact scrubber for a `.claude/` root. Used by
 * both the workspace prune (`pruneStaleDanxArtifactsInWorkspace`,
 * scoped to a workspace's target `.claude/`) and the repo-root scrub
 * (`scrubRepoRootDanxArtifacts`, scoped to the developer-owned
 * `<repo>/.claude/`). Centralizing the logic prevents the two from
 * drifting apart on prefix conventions, subdir scope, or failure
 * semantics.
 *
 * For each subdir in `opts.subdirs`:
 *   - Walks `<claudeRootDir>/<sub>/`
 *   - For every direct child whose name starts with `danx-`:
 *     - Keeps it if `opts.keepIfShippedFrom?.(sub)` returns a Set
 *       containing the entry (caller-supplied source-of-truth for
 *       "this name still ships from the inject tree").
 *     - Keeps it if `opts.keepNames?.(sub)` returns a Set containing
 *       the entry (caller-supplied per-name allowlist, e.g. the
 *       per-repo render outputs that this scrubber runs BEFORE the
 *       renderer writes them).
 *     - Otherwise rm-r's it.
 *
 * Fail-loud per CLAUDE.md "Fail loudly" rule: an `rm` failure on a
 * stale `danx-*` artifact means the dispatched agent will load dead
 * config on the next dispatch — exactly the bug this scrubber exists
 * to prevent. Do not swallow the error. The older
 * `scrubRepoRootDanxArtifacts` historically used `try/catch
 * log.warn`; that pattern is retired here in favor of the new
 * standing rule.
 */
interface ScrubDanxArtifactsOptions {
  readonly subdirs: readonly string[];
  readonly keepIfShippedFrom?: (sub: string) => ReadonlySet<string>;
  readonly keepNames?: (sub: string) => ReadonlySet<string>;
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

function scrubDanxArtifacts(
  claudeRootDir: string,
  opts: ScrubDanxArtifactsOptions,
): void {
  for (const sub of opts.subdirs) {
    const dir = resolve(claudeRootDir, sub);
    if (!existsSync(dir)) continue;

    const keepShipped = opts.keepIfShippedFrom?.(sub) ?? EMPTY_NAME_SET;
    const keepWhitelist = opts.keepNames?.(sub) ?? EMPTY_NAME_SET;

    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith("danx-")) continue;
      if (keepShipped.has(entry)) continue;
      if (keepWhitelist.has(entry)) continue;
      rmSync(resolve(dir, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Prune stale `danx-*` artifacts left behind in a workspace's
 * `.claude/{rules,skills}/` after `mirrorWorkspaceTree`. The mirror is
 * write-only — when a `danx-*` rule or skill is RETIRED from the inject
 * source, the previous tick's copy in the target persists forever and
 * the dispatched agent keeps loading dead config (Phase 5's
 * `danx-trello-config.md` lingered in `repos/gpt-manager/.danxbot/workspaces/`
 * for weeks past its retirement, costing ~200 tokens per dispatch).
 *
 * Keep rules:
 *   1. The matching name exists in `<source>/.claude/<sub>/` (still
 *      shipped from the static inject tree), OR
 *   2. The name is in `PER_REPO_RENDER_RULE_NAMES` — rules that
 *      `renderPerRepoFilesIntoWorkspaces` writes per-tick from
 *      `RepoContext` AFTER this prune runs. The set is co-located
 *      with the writers so the prune cannot drift out of sync.
 *
 * Scope is intentionally narrow — only `rules/` and `skills/`, only
 * `danx-*` prefix. `tools/` is excluded because `copyRepoToolScripts`
 * legitimately writes per-repo, NON-`danx-*`-prefixed scripts there
 * (operator-authored tooling). The repo-root scrub
 * (`scrubRepoRootDanxArtifacts`) DOES include `tools/` because the
 * repo-root contract forbids any `danx-*` artifact anywhere, while
 * the workspace contract is "danx-* in rules/skills ships from
 * danxbot; tools/ is per-repo". Non-prefixed entries are
 * operator-authored or per-repo scripts and survive untouched.
 */
function pruneStaleDanxArtifactsInWorkspace(
  workspaceSourceDir: string,
  workspaceTargetDir: string,
): void {
  scrubDanxArtifacts(resolve(workspaceTargetDir, ".claude"), {
    subdirs: ["rules", "skills"],
    keepIfShippedFrom: (sub) => {
      const sourceSubDir = resolve(workspaceSourceDir, ".claude", sub);
      return existsSync(sourceSubDir)
        ? new Set(readdirSync(sourceSubDir))
        : EMPTY_NAME_SET;
    },
    keepNames: (sub) =>
      sub === "rules" ? PER_REPO_RENDER_RULE_NAMES : EMPTY_NAME_SET,
  });
}

/**
 * DX-272 (Phase 3 of the plugin-consolidation epic DX-269): non-prefixed
 * retiree tombstone allowlist.
 *
 * `pruneStaleDanxArtifactsInWorkspace` only deletes entries whose name
 * starts with `danx-` AND no longer ship from the inject source. Most
 * retirees match both filters and are auto-cleaned. ONE outlier under
 * `issue-worker/.claude/skills/issue-blocker/` lacks the `danx-` prefix,
 * so the prefix-scoped scrubber walks past it and the stale plugin-
 * duplicate sits in every connected repo's workspace dir forever.
 *
 * This helper carries an explicit per-workspace, per-subdir allowlist
 * of retired names that the prefix scrubber CANNOT reach. Names are
 * permanent tombstones — once retired, never unretired. If a plugin
 * skill is ever re-introduced under one of these names, the entry is
 * deleted from the map in the same commit that re-adds the file (or
 * the prune fights the inject mirror on every tick).
 *
 * `danx-*`-prefixed retirees are NOT listed here on purpose — the
 * sibling scrubber catches them via prefix the moment inject stops
 * shipping them. Listing them would be dead code that drifts.
 *
 * Empty `rules`/`skills` sets are permitted extension points so a
 * future retiree under a workspace that does not yet have any
 * non-prefixed tombstones can be added with one line.
 */
type RetiredWorkspaceNames = Readonly<{
  rules: ReadonlySet<string>;
  skills: ReadonlySet<string>;
}>;

const RETIRED_WORKSPACE_ARTIFACT_NAMES: ReadonlyMap<
  string,
  RetiredWorkspaceNames
> = new Map<string, RetiredWorkspaceNames>([
  [
    "issue-worker",
    {
      rules: new Set<string>(),
      skills: new Set<string>(["issue-blocker"]),
    },
  ],
]);

/**
 * Per-tick companion to `pruneStaleDanxArtifactsInWorkspace`. Walks the
 * tombstone map and force-deletes any retired non-`danx-*` artifact
 * sitting in the workspace's `.claude/{rules,skills}/`. Fail-loud per
 * DX-149: an `rm` failure here means the dispatched agent will load
 * dead plugin-duplicate config on the next dispatch — exactly the bug
 * this helper exists to prevent. The `_poll` top-level catch
 * logs+swallows process-wide, same convergence model as the sibling
 * scrubber.
 *
 * Idempotent: a missing target subdir or a missing entry within it is
 * a silent no-op (the second poll after a successful prune is a no-op
 * because every `existsSync` short-circuits).
 */
function pruneRetiredWorkspaceFiles(
  workspaceName: string,
  workspaceTargetDir: string,
): void {
  const retired = RETIRED_WORKSPACE_ARTIFACT_NAMES.get(workspaceName);
  if (!retired) return;
  const claudeDir = resolve(workspaceTargetDir, ".claude");
  const subdirs: ReadonlyArray<["rules" | "skills", ReadonlySet<string>]> = [
    ["rules", retired.rules],
    ["skills", retired.skills],
  ];
  for (const [sub, names] of subdirs) {
    if (names.size === 0) continue;
    const dir = resolve(claudeDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of names) {
      const path = resolve(dir, name);
      if (!existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
    }
  }
}

/** Step 7: optional compose override -> repo-overrides/<name>-compose.yml. */
function copyComposeOverride(
  danxbotConfigDir: string,
  overridesDir: string,
  cfgName: string,
): void {
  const src = resolve(danxbotConfigDir, "compose.yml");
  if (!existsSync(src)) return;
  mkdirSync(overridesDir, { recursive: true });
  copyFileSync(src, resolve(overridesDir, `${cfgName}-compose.yml`));
}

/** Step 8: repo-side docs/{domains,schema}/* -> danxbot docs dir. */
function copyRepoDocs(danxbotConfigDir: string): void {
  const repoDocsDir = resolve(danxbotConfigDir, "docs");
  if (!existsSync(repoDocsDir)) return;
  const docsDir = resolve(projectRoot, "docs");
  for (const subdir of ["domains", "schema"]) {
    const srcDir = resolve(repoDocsDir, subdir);
    if (!existsSync(srcDir)) continue;
    const destDir = resolve(docsDir, subdir);
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(srcDir)) {
      copyFileSync(resolve(srcDir, file), resolve(destDir, file));
    }
  }
}

/** Step 9: features.md is copied ONCE and left alone so ideator edits persist. */
function copyFeaturesOnce(danxbotConfigDir: string): void {
  const danxbotDir = resolve(danxbotConfigDir, "..");
  const src = resolve(danxbotDir, "features.md");
  const dest = resolve(projectRoot, "docs", "features.md");
  if (!existsSync(src) || existsSync(dest)) return;
  mkdirSync(resolve(projectRoot, "docs"), { recursive: true });
  copyFileSync(src, dest);
}

/**
 * Sync danxbot config into every plural workspace's `.claude/` subtree.
 * All injected files use the `danx-` prefix so they're clearly
 * identifiable and gitignore-able.
 *
 * Two-stage pipeline:
 *
 *   1. **Static mirror** (`injectDanxWorkspaces`). Copies
 *      `src/poller/inject/workspaces/<name>/` → `<repo>/.danxbot/workspaces/<name>/`
 *      verbatim. Each workspace ships its own static skills, rules,
 *      `.mcp.json`, `CLAUDE.md`, etc. — all generic, identical for
 *      every connected repo.
 *
 *   2. **Per-repo render** (`renderPerRepoFilesIntoWorkspaces`). For
 *      each workspace, writes the per-repo rendered files into its
 *      `.claude/`: `danx-repo-config.md`, `danx-repo-overview.md`,
 *      `danx-repo-workflow.md`, `danx-tools.md`, and repo-specific tool
 *      scripts. These differ per repo
 *      (repo name, runtime, etc.) so they cannot live in the static
 *      inject tree — they are rendered fresh every tick from the
 *      `RepoContext`. Duplicated across every workspace dir so
 *      cwd-relative skill references resolve locally.
 *
 *   3. **Scrubs** enforce the agent-isolation contract: stale `danx-*`
 *      files at `<repo>/.claude/{rules,skills,tools}/` and the legacy
 *      singular `<repo>/.danxbot/workspace/` directory are removed.
 *      Without these scrubs claude's ancestor walk for `.claude/` dirs
 *      finds the repo-root copies and loads stale config (the Phase 6
 *      "agent reads Flytebot Chat board IDs after we switched to
 *      Platform V3" incident).
 *
 * Called on every poll tick to keep workspaces up to date. Each
 * numbered step is its own helper — the function body is the table
 * of contents.
 */
export function syncRepoFiles(repo: RepoContext): void {
  const danxbotConfigDir = resolve(repo.localPath, ".danxbot/config");
  if (!existsSync(danxbotConfigDir)) return;

  const cfg = parseSimpleYaml(
    readFileSync(resolve(danxbotConfigDir, "config.yml"), "utf-8"),
  );

  // Validate the config upfront — `renderRepoConfigMarkdown` throws
  // fail-loud on a missing required field. Doing this BEFORE any disk
  // writes so a broken config aborts the sync without leaving the
  // workspace half-populated. The rendered markdown is discarded; the
  // actual write happens per-workspace in stage 2.
  renderRepoConfigMarkdown(cfg);

  // Stage 1: static workspace mirror.
  const workspacesDir = resolve(repo.localPath, ".danxbot/workspaces");
  injectDanxWorkspaces(workspacesDir);

  // Stage 1b: danxbot-shipped scripts -> <repo>/.danxbot/scripts/.
  // Scope is repo-wide (not per-workspace) because the agent invokes
  // these from inside a worktree at <repo>/.danxbot/worktrees/<agent>/,
  // not from a workspace dir — see `injectDanxbotScripts`.
  injectDanxbotScripts(repo.localPath);

  // Stage 2: per-repo render into every plural workspace.
  renderPerRepoFilesIntoWorkspaces(repo, danxbotConfigDir, cfg, workspacesDir);

  // Stage 2b (DX-309): mirror the fully-populated workspaces tree into
  // each agent worktree's `<worktree>/.danxbot/workspaces/`. Real-dir
  // copy, NOT symlink — a symlinked workspaces dir would make the
  // spawned agent's cwd resolve (via the kernel's physical-path swap)
  // back to the main checkout, defeating the per-agent git-context
  // isolation. `mirrorWorkspaceTree` + `writeIfChanged` keep the I/O
  // cost proportional to actual content changes between ticks.
  mirrorWorkspacesIntoWorktrees(repo, danxbotConfigDir, cfg);

  // Stage 3: scrubs. Remove the legacy singular `<repo>/.danxbot/workspace/`
  // (workspace-dispatch epic retired it) and any `danx-*` artifacts at
  // repo-root `.claude/` (dev-territory contract).
  scrubLegacySingularWorkspace(repo.localPath);
  scrubRepoRootDanxArtifacts(repo.localPath);

  // Stage 4: per-issue YAML on-disk skeleton (Phase 2 of
  // tracker-agnostic-agents, Trello ZDb7FOGO). Idempotent — both helpers
  // converge on identical disk state across repeated ticks. The setup
  // skill writes the gitignore once at install, but pre-existing connected
  // repos that don't have the `issues/` line need it appended without a
  // re-install.
  ensureIssuesDirs(repo.localPath);
  ensureGitignoreEntry(repo.localPath, "issues/");
  // DX-132 Phase 2: the on-disk Trello retry queue under
  // `<repo>/.danxbot/.trello-retry/` is local-only and must never be
  // committed (entries contain raw upstream tracker error strings).
  ensureGitignoreEntry(repo.localPath, ".trello-retry/");

  // DX-201: ensure the connected repo's root `.mcp.json` advertises the
  // `danx-issue` MCP server so a host-session `claude` at the repo root
  // can atomically allocate `ISS-N` ids via `danx_issue_create`. Merge-
  // only — never clobbers other `mcpServers` entries or top-level keys.
  const mcpResult = injectDanxIssueMcp({ repoRoot: repo.localPath });
  if (mcpResult.changed) {
    log.info(`[${repo.name}] root .mcp.json updated with danx-issue server`);
  }

  copyComposeOverride(
    danxbotConfigDir,
    resolve(projectRoot, "repo-overrides"),
    cfg.name,
  );
  copyRepoDocs(danxbotConfigDir);
  copyFeaturesOnce(danxbotConfigDir);
}

/**
 * For each plural workspace under `<repo>/.danxbot/workspaces/`, render
 * the per-repo files into its `.claude/`. The static mirror created
 * the workspace dirs in stage 1; this stage just adds the per-repo
 * data layer on top. Workspaces from the static inject tree that have
 * never received a tick yet still get the per-repo files written —
 * `injectDanxWorkspaces` ran first, so the dirs exist.
 *
 * Workspaces are discovered from the on-disk `<repo>/.danxbot/workspaces/`
 * directory, not from `inject/workspaces/`. This way an operator-authored
 * workspace tracked in the connected repo's git (the
 * `gpt-manager-authored schema-builder/` precedent that produced the
 * never-prune contract) also gets the per-repo files — the inject
 * pipeline doesn't gate on whether danxbot ships the workspace itself.
 */
function renderPerRepoFilesIntoWorkspaces(
  repo: RepoContext,
  danxbotConfigDir: string,
  cfg: Record<string, string>,
  workspacesDir: string,
): void {
  if (!existsSync(workspacesDir)) return;
  const names = readdirSync(workspacesDir).filter((entry) => {
    try {
      return statSync(resolve(workspacesDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const name of names) {
    const workspaceRoot = resolve(workspacesDir, name);
    const target = buildInjectTarget(workspaceRoot);
    mkdirSync(target.rulesDir, { recursive: true });
    mkdirSync(target.toolsDir, { recursive: true });

    writeRepoConfigRule(cfg, target);
    copyRepoConfigDocs(danxbotConfigDir, target);
    writeIssuePrefixRule(repo.issuePrefix, target);
    copyRepoToolsDoc(danxbotConfigDir, target);
    copyRepoToolScripts(danxbotConfigDir, target);
  }
}

/**
 * DX-309: for each agent worktree under `<repo>/.danxbot/worktrees/`,
 * ensure `<worktree>/.danxbot/workspaces/` mirrors `<repo>/.danxbot/
 * workspaces/`. The dispatch layer cwd-swaps agent-bound dispatches to
 * a worktree-rooted workspace dir; the dir MUST exist on disk before
 * `resolveWorkspace` runs or it throws `WorkspaceNotFoundError`.
 *
 * Cost: poll-tick I/O proportional to actual content change, not
 * worktree count — `writeIfChanged` short-circuits on byte-identical
 * writes and the inject sources are tiny. Three worktrees × five
 * workspaces × ~20 files each = ~300 stat+hash ops per tick, all
 * cached by the OS page cache. Acceptable.
 *
 * The per-repo render layer (`renderPerRepoFilesIntoWorkspaces`) is
 * re-run against each worktree's workspaces tree so worktree-scoped
 * skills + per-repo rules + tools docs resolve cwd-relatively when the
 * agent is sitting inside the worktree. Without this, the agent would
 * still resolve `.claude/rules/danx-repo-config.md` upward through the
 * worktree's own `.claude/` (developer territory) and miss the per-
 * repo render entirely.
 */
function mirrorWorkspacesIntoWorktrees(
  repo: RepoContext,
  danxbotConfigDir: string,
  cfg: Record<string, string>,
): void {
  const worktreesRoot = resolve(repo.localPath, ".danxbot", "worktrees");
  if (!existsSync(worktreesRoot)) return;
  const mainWorkspaces = resolve(repo.localPath, ".danxbot", "workspaces");
  if (!existsSync(mainWorkspaces)) return;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(worktreesRoot);
  } catch {
    return;
  }

  for (const agentName of agentDirs) {
    const worktree = resolve(worktreesRoot, agentName);
    try {
      if (!statSync(worktree).isDirectory()) continue;
    } catch {
      continue;
    }
    const workspacesTarget = resolve(worktree, ".danxbot", "workspaces");
    mkdirSync(workspacesTarget, { recursive: true });
    for (const entry of readdirSync(mainWorkspaces)) {
      const src = resolve(mainWorkspaces, entry);
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      mirrorWorkspaceTree(src, resolve(workspacesTarget, entry), []);
    }
    renderPerRepoFilesIntoWorkspaces(
      repo,
      danxbotConfigDir,
      cfg,
      workspacesTarget,
    );
  }
}

/**
 * Remove the legacy singular `<repo>/.danxbot/workspace/` dir created
 * by the retired `generateWorkspace` helper. Pre-refactor this dir was
 * the dispatched-agent cwd; post-refactor every dispatch resolves a
 * plural workspace under `<repo>/.danxbot/workspaces/<name>/` and the
 * singular dir is dead weight that shadows nothing but still confuses
 * humans grepping the tree. Idempotent — absent dir is a no-op.
 */
function scrubLegacySingularWorkspace(repoLocalPath: string): void {
  const dir = resolve(repoLocalPath, ".danxbot/workspace");
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Remove any `danx-*` files at `<repo>/.claude/{rules,skills,tools}/`.
 * The repo-root `.claude/` is strictly developer-owned per the
 * agent-isolation contract; any `danx-*` file there is either (a) a
 * leftover from a pre-isolation poller version, or (b) someone's
 * misguided attempt to override workspace config. Both cause the
 * exact bug this scrub exists to prevent: claude's ancestor walk
 * finds the repo-root copy, loads stale data, and the agent dispatches
 * with wrong board IDs / repo config.
 *
 * Scope is intentionally narrow — only the `danx-*` prefix, only the
 * three subdirs (`rules/`, `skills/`, `tools/`). Nothing else under
 * `<repo>/.claude/` is touched.
 *
 * Fail-loud per CLAUDE.md "Fail loudly" rule: a swallowed `rm` error
 * here would leave stale `danx-*` config in repo-root, which is the
 * exact bug this scrubber exists to prevent. The pre-Phase-5 sibling
 * used `try/catch log.warn`; that pattern is retired in favor of
 * loud abort so the operator surfaces the underlying perm/lock issue
 * before the next dispatch loads stale rules.
 */
function scrubRepoRootDanxArtifacts(repoLocalPath: string): void {
  scrubDanxArtifacts(resolve(repoLocalPath, ".claude"), {
    subdirs: ["rules", "skills", "tools"],
  });
}


export function shutdown(): void {
  log.info("Shutting down...");

  for (const [, state] of repoState) {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  process.exit(0);
}

export async function start(): Promise<void> {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (repoContexts.length === 0) {
    log.error("No repos configured — nothing to poll");
    return;
  }

  // Every repo gets a polling interval scheduled regardless of the env
  // default — the per-tick `isFeatureEnabled(repo, "issuePoller")` check
  // in `poll()` honors runtime overrides from `.danxbot/settings.json`, so
  // boot-time skipping would defeat the toggle. Boot-time validation only
  // runs when the env default says Trello is supposed to be on; a repo
  // that opts in at runtime takes responsibility for ensuring its config
  // is complete (the first enabled tick surfaces config gaps naturally).
  for (const repo of repoContexts) {
    if (repo.trelloEnabled) {
      validateRepoConfig(repo);
    } else {
      log.info(
        `[${repo.name}] Trello env-default disabled — skipping boot validation. Runtime override in settings.json can still enable the poller.`,
      );
    }

    const state = getState(repo.name);
    const intervalSeconds = config.pollerIntervalMs / 1000;
    log.info(`[${repo.name}] Started — polling every ${intervalSeconds}s`);

    // Boot reattach (ISS-92 Phase 2; DX-290 slimmed). Walks every open
    // YAML and clears the ones whose recorded dispatch PID/host is
    // dead/expired/cross-host; alive PIDs are left in place for the
    // per-dispatch TTL timer (`src/dispatch/ttl-timer.ts`) to track.
    // MUST run before the first `poll(repo)` call so the next reconcile
    // → scheduler poke sees the cleaned baseline.
    await runStartupReattach(repo);

    poll(repo);
    state.intervalId = setInterval(() => poll(repo), config.pollerIntervalMs);
  }
}

/** Reset module state for testing. Do not use in production. */
export function _resetForTesting(): void {
  for (const state of repoState.values()) {
    state.polling = false;
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }
  repoState.clear();
  trackerByRepo.clear();
}

// Auto-start when run as the direct entrypoint.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/poller/index.ts");

if (isDirectEntrypoint) {
  start();
}
