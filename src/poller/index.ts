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
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config, targetName } from "../config.js";
import { repoContexts } from "../repo-context.js";
import {
  REVIEW_MIN_CARDS,
  TEAM_PROMPT,
  TEAM_PROMPT_RESUME,
  IDEATOR_PROMPT,
  TRIAGE_CARD_PROMPT,
} from "./constants.js";
import { DANXBOT_COMMENT_MARKER } from "../issue-tracker/markers.js";
import {
  clearDispatchAndWrite,
  ensureGitignoreEntry,
  ensureIssuesDirs,
  findByExternalId,
  hydrateFromRemote,
  issuePath,
  loadLocal,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import { serializeIssue } from "../issue-tracker/yaml.js";
import { createIssueTracker, TrelloTracker } from "../issue-tracker/index.js";
import type {
  Issue,
  IssueRef,
  IssueTracker,
} from "../issue-tracker/interface.js";
import { tryAcquireLock, buildLockHolderInfo } from "../issue-tracker/lock.js";
import { parseSimpleYaml } from "./parse-yaml.js";
import { renderRepoConfigMarkdown } from "./repo-config-rule.js";
import { writeIfChanged } from "../workspace/write-if-changed.js";
import { createLogger } from "../logger.js";
import { dispatch, getActiveJob } from "../dispatch/core.js";
import { resolveParentSessionId } from "../agent/resolve-parent-session.js";
import { scrubLegacyTrelloWorkerSymlink } from "./legacy-trello-worker-scrub.js";
import { pushOrphans } from "./orphan-push.js";
import { recomputeParentStatuses } from "./epic-status.js";
import { healLocalYamls } from "./heal.js";
import {
  listBlockedTodoYamls,
  listDispatchableYamls,
  listInProgressYamls,
  listTriageDueYamls,
} from "./local-issues.js";
import { isLinkOrFile, isSymlink } from "./fs-probe.js";
import type { AgentJob } from "../agent/launcher.js";
import type { RepoContext } from "../types.js";
import {
  getIssuePollerPickupPrefix,
  isFeatureEnabled,
} from "../settings-file.js";
import { readFlag, writeFlag } from "../critical-failure.js";
import type {
  DispatchTriggerMetadata,
  TrelloTriggerMetadata,
} from "../dashboard/dispatches.js";
import { findNonTerminalDispatches } from "../dashboard/dispatches-db.js";
import { isPidAlive } from "../agent/host-pid.js";
import { hasLiveDispatchForCard as hasLiveDispatchForCardImpl } from "./live-dispatch-guard.js";
import { hostname as osHostname } from "node:os";
import type { IssueDispatch } from "../issue-tracker/interface.js";
import { buildStartStamp } from "./dispatch-liveness-yaml.js";
import { buildReattachPlan } from "./dispatch-reattach.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const log = createLogger("poller");

/**
 * Project a local-YAML `Issue` into the `IssueRef` shape the dispatch
 * pipeline downstream consumes.
 */
function localIssueToRef(issue: Issue): IssueRef {
  return {
    id: issue.id,
    external_id: issue.external_id,
    title: issue.title,
    status: issue.status,
  };
}

/** Per-repo poller state */
interface RepoPollerState {
  teamRunning: boolean;
  polling: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  consecutiveFailures: number;
  backoffUntil: number;
  priorTodoCardIds: string[];
  /**
   * The Trello card the current dispatch targets. Set in `spawnClaude`
   * when the trigger is "trello" (null for ideator/api dispatches); read
   * by the post-dispatch "did the card move?" check in
   * `handleAgentCompletion`. Cleared by `cleanupAfterAgent` so stale
   * state from a prior run can't trip the check on the next dispatch.
   * Card URL is reconstructed from cardId when the flag is written —
   * don't duplicate it in state.
   */
  trackedCardId: string | null;
  /**
   * The triage card the current dispatch targets, paired with the
   * dispatch's `started_at` for the "did triage advance?" check in
   * `handleAgentCompletion`. Set in `tryTriageDispatch` BEFORE
   * `spawnClaude` so the onComplete handler sees it; cleared by
   * `cleanupAfterAgent`. Distinct from `trackedCardId` because triage
   * dispatches use `trigger: "api"` and the card never moves out of its
   * source list — the progress signal is the local YAML's
   * `triage.expires_at` advancing past `started_at`. Without this
   * guard, a triage agent that signals `completed` without saving the
   * YAML produces a token-burn loop (the same broken agent gets
   * dispatched against the same card every interval). See ISS-104.
   */
  triageTracked: { id: string; startedAt: string } | null;
}

const repoState = new Map<string, RepoPollerState>();

/**
 * Per-repo in-memory mirror of every YAML's non-null `dispatch{}` block
 * — keyed by issue id (`ISS-N`). Populated by the boot reattach pass
 * (`runStartupReattach`) and refreshed per-tick by `evictDeadDispatches`.
 *
 * The single source of truth is the on-disk YAML — this map is a fast
 * lookup for "is this card occupied". Every entry's `dispatch` value
 * must mirror the YAML's `dispatch` block at the time of write; any
 * mutation to either side updates the other in the same code path.
 *
 * ISS-92 (Phase 2 of the poller-triage rework). The companion DB-side
 * guard `hasLiveDispatchForCard` (ISS-69) keys off the dispatches table
 * and remains for the pre-claim path; this map keys off the YAML and
 * drives the reattach + per-tick scan.
 */
const activeDispatches = new Map<string, Map<string, IssueDispatch>>();

function getActiveDispatches(
  repoName: string,
): Map<string, IssueDispatch> {
  let map = activeDispatches.get(repoName);
  if (!map) {
    map = new Map();
    activeDispatches.set(repoName, map);
  }
  return map;
}

/**
 * Test-only accessor — returns the per-repo `activeDispatches` map so
 * tests can assert on the in-memory mirror without exporting the
 * top-level Map (which would let production code mutate it).
 */
export function _getActiveDispatchesForTesting(
  repoName: string,
): ReadonlyMap<string, IssueDispatch> {
  return getActiveDispatches(repoName);
}

/**
 * Walk every open YAML in `<repo>/.danxbot/issues/open/` and collect
 * the ones with a non-null `dispatch{}` block. Used by the boot
 * reattach pass; tolerates malformed files (logs + skips) so a single
 * corrupt YAML doesn't halt the boot phase.
 */
function readOpenIssuesWithDispatch(
  repo: RepoContext,
): Issue[] {
  const dir = resolve(repo.localPath, ".danxbot", "issues", "open");
  if (!existsSync(dir)) return [];
  const out: Issue[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    const path = resolve(dir, entry);
    try {
      // `loadLocal` validates strictly. The reattach pass deliberately
      // doesn't use `walkOpenIssues` from local-issues.ts (which has
      // its own ID-regex filter) because we want the same fail-loud
      // semantics as `loadLocal` here — a YAML that survived the disk
      // write but parses as garbage indicates corruption that
      // observability should surface.
      const issue = loadLocal(repo.localPath, stem, repo.issuePrefix);
      if (issue && issue.dispatch !== null) {
        out.push(issue);
      }
    } catch (err) {
      log.warn(
        `[${repo.name}] reattach: skipping ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

/**
 * Boot reattach pass (ISS-92, Phase 2). Runs once per worker startup,
 * BEFORE the polling interval registers. Walks every open YAML, asks
 * `buildReattachPlan` to partition by liveness, then:
 *
 *   - alive → register in `activeDispatches`. Skips redispatch on the
 *     first tick (the per-tick `evictDeadDispatches` will re-verify).
 *   - cleared → write `dispatch: null` on the YAML and skip the in-
 *     memory entry entirely. The card stays where it is on disk
 *     (status unchanged) — the regular dispatch / orphan-resume paths
 *     pick it back up on the first poll.
 *
 * Cross-host verdicts on a local-only deploy are treated as cleared
 * (operator intervention via the dashboard's Agents tab); the
 * verdict.kind is logged so a future multi-host extension knows
 * exactly which entries it would need to probe.
 */
export function runStartupReattach(repo: RepoContext): void {
  const issues = readOpenIssuesWithDispatch(repo);
  if (issues.length === 0) return;

  const plan = buildReattachPlan(issues, {
    currentHost: osHostname(),
    now: Date.now(),
    isPidAlive,
  });

  const map = getActiveDispatches(repo.name);

  for (const action of plan.alive) {
    map.set(action.issue.id, action.issue.dispatch!);
    log.info(
      `[${repo.name}] reattach: ${action.issue.id} alive (pid=${action.issue.dispatch!.pid}, dispatch=${action.issue.dispatch!.id}) — registered`,
    );
  }

  for (const action of plan.cleared) {
    log.warn(
      `[${repo.name}] reattach: clearing ${action.issue.id} (verdict=${action.verdict.kind}, dispatch=${action.issue.dispatch!.id})`,
    );
    try {
      clearDispatchAndWrite(repo.localPath, action.issue);
    } catch (err) {
      log.error(
        `[${repo.name}] reattach: clearDispatch failed for ${action.issue.id}`,
        err,
      );
    }
    map.delete(action.issue.id);
  }
}

/**
 * Per-tick liveness scan (ISS-92, Phase 2). Re-runs the same liveness
 * verdict against every in-memory `activeDispatches` entry and evicts
 * any whose verdict !== alive. Eviction clears `dispatch: null` on the
 * YAML in addition to dropping the in-memory entry.
 *
 * Reads the YAML at eviction time (not the in-memory copy) so that
 * any field the agent updated mid-session (status flips, AC ticks)
 * survives the clear. Concurrent dispatches that wrote a fresh
 * `dispatch{}` block on the same YAML between reattach and now would
 * normally be safe — `clearDispatchAndWrite` reads-then-writes, so a
 * stamp written after this read but before this write would be
 * overwritten. In practice the poller never has two dispatches on the
 * same card simultaneously (single-dispatch-per-tick invariant), so
 * the read-modify-write race window is empty.
 */
export function evictDeadDispatches(repo: RepoContext): void {
  const map = getActiveDispatches(repo.name);
  if (map.size === 0) return;

  const currentHost = osHostname();
  const now = Date.now();

  for (const [issueId, dispatchBlock] of map) {
    const plan = buildReattachPlan(
      [
        // Synthetic single-issue input — buildReattachPlan only reads
        // `issue.dispatch`. Keeps the verdict logic in one place
        // without forcing the per-tick scan to re-load every YAML.
        {
          schema_version: 3,
          tracker: "memory",
          id: issueId,
          external_id: "",
          parent_id: null,
          children: [],
          dispatch: dispatchBlock,
          status: "In Progress",
          type: "Feature",
          title: issueId,
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
          history: [],
        } as Issue,
      ],
      { currentHost, now, isPidAlive },
    );

    for (const action of plan.cleared) {
      log.warn(
        `[${repo.name}] liveness: evicting ${issueId} (verdict=${action.verdict.kind}, dispatch=${dispatchBlock.id})`,
      );
      const issue = loadLocal(repo.localPath, issueId, repo.issuePrefix);
      if (issue) {
        try {
          clearDispatchAndWrite(repo.localPath, issue);
        } catch (err) {
          log.error(
            `[${repo.name}] liveness: clearDispatch failed for ${issueId}`,
            err,
          );
        }
      }
      map.delete(issueId);
    }
  }
}

function getState(repoName: string): RepoPollerState {
  let state = repoState.get(repoName);
  if (!state) {
    state = {
      teamRunning: false,
      polling: false,
      intervalId: null,
      consecutiveFailures: 0,
      backoffUntil: 0,
      priorTodoCardIds: [],
      trackedCardId: null,
      triageTracked: null,
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
    refs = all.filter((c) => c.status === "Needs Help");
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
  if (state.teamRunning || state.polling) {
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
    // Halt is a stronger signal than backoff. If we're halted because
    // of a run that also tripped backoff, clear that state so when the
    // operator clears the flag the poller resumes on the very next
    // tick — no leftover "In backoff" log from a dispatch whose real
    // failure mode is now being tracked by the flag file.
    state.consecutiveFailures = 0;
    state.backoffUntil = 0;
    return;
  }

  if (Date.now() < state.backoffUntil) {
    const remainingSeconds = Math.round(
      (state.backoffUntil - Date.now()) / 1000,
    );
    log.info(
      `[${repo.name}] In backoff — ${remainingSeconds}s remaining (${state.consecutiveFailures} consecutive failures)`,
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

  // ISS-133 Phase 3: per-tick self-heal pass for the local YAML dir.
  // Runs BEFORE every tracker fetch and BEFORE every dispatch decision
  // so a YAML stuck in `open/` with terminal status (e.g. ISS-95-class
  // saves where the worker's runSync threw before persistAfterSync
  // moved the file) auto-recovers without a human `mv`. Tracker-
  // independent — no Trello call, runs even when creds are dead.
  // Together with the ISS-98 epic-status auto-derive pass below, the
  // healer closes the ISS-95/ISS-90 loop: heal moves ISS-95 to
  // closed/ on this tick; the next tick's auto-derive flips ISS-90's
  // status from the union of children; the tick after heals ISS-90
  // too.
  const healResult = healLocalYamls(repo.localPath, repo.issuePrefix);
  for (const h of healResult.healed) {
    log.info(`[${repo.name}] Healed ${h.id}: open/ → closed/ (status: ${h.status})`);
  }
  for (const e of healResult.errors) {
    log.warn(`[${repo.name}] Heal pass skipped malformed YAML at ${e.path}: ${e.message}`);
  }

  // YAML-driven liveness scan (ISS-92, Phase 2). Walks the in-memory
  // `activeDispatches` mirror, re-checks every entry, and evicts any
  // whose verdict turned dead/expired/cross-host. The YAML's
  // `dispatch{}` is also cleared on disk so the next tick (or a
  // restart) doesn't have to re-discover the same dead entry. Cheap:
  // the map is per-repo and tracks only currently-dispatched cards
  // (typically 0–1 entries). Runs BEFORE the tracker fetch so the
  // ToDo dispatch path can immediately re-claim a card whose previous
  // dispatch just died.
  evictDeadDispatches(repo);

  log.info(`[${repo.name}] Checking Needs Help + ToDo lists...`);

  // ONE tracker per repo, reused across every tick (see `getRepoTracker`).
  // Threaded through every helper that needs to talk to the issue
  // tracker so `MemoryTracker` state survives the lifecycle and so
  // tests can assert on a single mock.
  const tracker = getRepoTracker(repo);

  // Check Needs Help first — user-responded cards get moved to ToDo top
  const movedFromNeedsHelp = await checkNeedsHelp(repo, tracker);
  if (movedFromNeedsHelp > 0) {
    log.info(
      `[${repo.name}] Moved ${movedFromNeedsHelp} card${movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`,
    );
  }

  let openCards: IssueRef[];
  try {
    openCards = await tracker.fetchOpenCards();
  } catch (error) {
    log.error(`[${repo.name}] Error fetching cards`, error);
    return;
  }
  // ISS-86: tracker.fetchOpenCards() is the inbound channel ONLY (new
  // cards + bulk-sync). It does NOT decide what gets dispatched —
  // local YAML is the source of truth. The tracker-derived
  // partitions below exist solely to drive the inbound mirror
  // (bulkSyncMissingYamls, pushOrphans). The dispatch + stuck-card
  // scan switch to listDispatchableYamls / listInProgressYamls /
  // listTriageDueYamls AFTER the inbound mirror runs, so hand-written
  // YAMLs land in dispatch on the same tick orphan-push stamps their
  // external_id.
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
    (c) => c.status === "Needs Help",
  );

  // Bulk-sync every triage-eligible card that lacks a local YAML so
  // the per-card triage agent has a YAML to load via
  // `mcp__danx-issue__danx_issue_get`. Coverage:
  //   - Every dispatchable ToDo sibling (`slice(1)` — the primary has
  //     its own dedicated hydrate-or-stamp path that THROWS on hydrate
  //     failure).
  //   - Every In Progress card (closes the gap where a worker died
  //     before writing the YAML; the orphan-resume scan below depends
  //     on a local YAML existing).
  //   - Every Review card (so the per-card triage agent can read it
  //     locally) — Phase 4 of ISS-90 added this branch when the
  //     Action Items list collapsed into `status: "Review"`.
  //   - Every Needs Help card (same reason as Review — the triage
  //     agent's Hard Gate audit needs the local YAML).
  // Bulk-sync writes carry `dispatch: null`; the dispatch primary's
  // record is stamped via `stampDispatchAndWrite` later, and an
  // In Progress orphan keeps its existing `dispatch` because
  // `findByExternalId` short-circuits hydration when the YAML already
  // exists.
  await bulkSyncMissingYamls(repo, tracker, [
    ...trackerToDoRefs.slice(1),
    ...trackerInProgressRefs,
    ...trackerReviewRefs,
    ...trackerNeedsHelpRefs,
  ]);

  // Orphan-push: scan local YAMLs for empty `external_id` and push each
  // to the tracker via `createCard`. Closes the gap for cards written
  // by hand (or by the `danx-epic-link` flow that splits an epic into
  // phase children) without going through `danx_issue_create` — those
  // YAMLs would otherwise stay invisible on the tracker forever.
  // Failures per card are non-fatal: logged + tick continues.
  const orphanPush = await pushOrphans(repo.localPath, tracker, repo.issuePrefix);
  if (orphanPush.pushed > 0) {
    log.info(
      `[${repo.name}] Pushed ${orphanPush.pushed} local orphan${orphanPush.pushed > 1 ? "s" : ""} to tracker`,
    );
  }
  for (const err of orphanPush.errors) {
    log.error(
      `[${repo.name}] orphan-push failed for ${err.id}: ${err.message}`,
    );
  }

  // ISS-98: derive parent (Epic + non-epic) statuses from the union of
  // children. Runs AFTER `bulkSyncMissingYamls` so freshly hydrated
  // children participate in the same tick's derivation, and BEFORE
  // dispatch decisions so an Epic that just turned `Needs Help`
  // (because a child did) is non-dispatchable on this tick. Pure-local
  // — outbound mirror to the tracker happens via `syncIssue` on the
  // parent's next reconcile.
  const parentChanges = recomputeParentStatuses(repo.localPath, repo.issuePrefix);
  for (const change of parentChanges) {
    log.info(
      `[${repo.name}] Derived ${change.id}: ${change.before} → ${change.after}`,
    );
  }

  // ISS-86: dispatch source is local YAML, not the tracker fetch above.
  // Phase 4 of ISS-90 dropped the `excludeExternalIds` filter — Action
  // Items list cards now hydrate as `status: "Review"` (see
  // `trello.ts#listIdToStatus`), so the existing `status === "ToDo"`
  // filter inside `listDispatchableYamls` naturally excludes them.
  let cards: IssueRef[] = listDispatchableYamls(
    repo.localPath,
    repo.issuePrefix,
  ).map(localIssueToRef);
  const inProgressCards: IssueRef[] = listInProgressYamls(
    repo.localPath,
    repo.issuePrefix,
  ).map(localIssueToRef);

  // Orphan-resume check. Runs BEFORE the ToDo dispatch path so a
  // worker that died mid-dispatch can resume its prior session
  // instead of leaving the card parked in In Progress forever. If a
  // resume fires, the tick exits early — single-dispatch invariant.
  // If an orphan's session file is gone, the scan resets the card to
  // ToDo on both the YAML and the tracker; the returned
  // `resetToToDo` refs are folded back into `cards` so this tick
  // dispatches them rather than waiting a full poll interval.
  const orphanScan = await tryResumeOrphan(repo, tracker, inProgressCards);
  if (orphanScan.resumed) {
    return;
  }
  if (orphanScan.resetToToDo.length > 0) {
    cards = [...cards, ...orphanScan.resetToToDo];
  }

  // Optional pickup-name-prefix filter from per-repo settings. When set,
  // ONLY cards whose name starts with the prefix are eligible for
  // dispatch — pre-existing real ToDo cards are left untouched on this
  // tick. Used by the system-test harness for race-free isolation
  // (Trello `IleofrBj`); operators can also use it to temporarily limit
  // the poller to one card class without disabling it entirely.
  // Important: filter BEFORE the empty-cards branch so a board with
  // only non-matching cards falls through to the ideator check rather
  // than dispatching, AND before `priorTodoCardIds` is captured so
  // stuck-card recovery only considers cards in this dispatch's scope.
  // Match against `IssueRef.title` — TrelloTracker strips the `#ISS-N: `
  // id prefix from card names, so `[System Test] foo` still matches the
  // operator-configured prefix `[System Test]` regardless of whether the
  // card has been reconciled with a local YAML.
  const pickupPrefix = getIssuePollerPickupPrefix(repo.localPath);
  if (pickupPrefix) {
    const before = cards.length;
    cards = cards.filter((c) => c.title.startsWith(pickupPrefix));
    log.info(
      `[${repo.name}] pickupNamePrefix="${pickupPrefix}" filter: ${cards.length}/${before} cards match`,
    );
  }

  // Blocked-card gate. `listDispatchableYamls` already filtered out
  // every YAML with non-null `blocked`, so the input set is exclusively
  // not-blocked. The unblock-on-terminal path runs over a separate
  // sweep of the blocked ToDo YAMLs: `resolveBlockedCards` clears the
  // record + saves, and the freshly-cleared cards join the dispatchable
  // pool for this tick. See `resolveBlockedCard` for the contract.
  const blockedRefs: IssueRef[] = listBlockedTodoYamls(
    repo.localPath,
    repo.issuePrefix,
  ).map(localIssueToRef);
  if (blockedRefs.length > 0) {
    const cleared = await resolveBlockedCards(repo, blockedRefs);
    if (cleared.length > 0) cards = [...cards, ...cleared];
  }

  if (cards.length === 0) {
    // Phase 4 of ISS-90 — single-dispatch-per-tick decision tree.
    // Order: work-ready (covered above and short-circuits the tick) →
    // triage-due → idle/ideator. The triage-due path dispatches the
    // `danx-triage-card` skill against ONE card per tick when an
    // operator has opted in via `overrides.autoTriage`. Falls through
    // to the ideator only when no triage is due.
    if (await tryTriageDispatch(repo)) {
      return;
    }
    log.info(`[${repo.name}] No cards in ToDo — checking if ideator needed`);
    await checkAndSpawnIdeator(repo, tracker);
    return;
  }

  log.info(
    `[${repo.name}] Found ${cards.length} card${cards.length > 1 ? "s" : ""} — starting team`,
  );
  cards.forEach((card, i) => log.info(`  ${i + 1}. ${card.title}`));

  // Save tracker-native ids for stuck-card recovery on failure
  const state = getState(repo.name);
  state.priorTodoCardIds = cards.map((c) => c.external_id);

  // Record the first card as the dispatch trigger. One agent session processes
  // the whole ToDo queue; tagging it with the primary card lets the dashboard
  // show what kicked off the run. The UI can expand to show all processed cards
  // by scanning the JSONL for tracker MCP calls.
  const primary = cards[0];
  const trelloMeta: TrelloTriggerMetadata = {
    cardId: primary.external_id,
    cardName: primary.title,
    cardUrl: `https://trello.com/c/${primary.external_id}`,
    listId: repo.trello.todoListId,
    listName: "ToDo",
  };

  // Hydrate-or-load by tracker-native external_id, then dispatch using
  // the resolved INTERNAL id. The agent never sees external_id — the
  // dispatch prompt and YAML filename both use `id`.
  //   1. Pre-generate the dispatch UUID so the same value lands in BOTH
  //      the dispatch row AND the YAML's `dispatch.id` field.
  //   2. `findByExternalId` scans existing YAMLs — if one carries this
  //      external_id, it's authoritative; only `dispatch` overwrites.
  //   3. No match → `hydrateFromRemote` pulls metadata, allocates an
  //      ISS-N (or parses one from the title prefix), patches the
  //      tracker title, and writes a fresh local YAML. Reuses the same
  //      cached tracker instance so MemoryTracker state survives.
  //   4. Dispatch task references the local id — agent calls
  //      `danx_issue_save({id})` and never knows external trackers exist.
  const dispatchId = randomUUID();

  // ISS-92 Phase 2: YAML-based liveness guard (defense in depth with
  // the DB-backed check below). A primary in `listDispatchableYamls`
  // already has `status: ToDo` + `blocked: null`, so an active
  // `dispatch{}` block on it is exceptional — but the boot reattach
  // pass populates `activeDispatches` for every alive PID it finds,
  // and we honor that mirror here in case the stale state ever leaks
  // through. We resolve the local id via `findByExternalId` because
  // the in-memory map is keyed by issue id, not external_id.
  const existingForGuard = findByExternalId(
    repo.localPath,
    primary.external_id,
  );
  if (
    existingForGuard &&
    getActiveDispatches(repo.name).has(existingForGuard.id)
  ) {
    log.info(
      `[${repo.name}] ${primary.title} already has live YAML dispatch (${existingForGuard.id}) — skipping`,
    );
    return;
  }

  // Pre-claim DB guard (ISS-69). Host-mode dispatches outlive the worker
  // — a worker restart leaves the prior dispatch's claude process running
  // under PID 1 with the dispatch row still `running`. Before acquiring
  // the tracker lock (which is wall-clock based and will eventually
  // reclaim a stale-looking-but-actually-live dispatch) check whether
  // any non-terminal row references this card and whose `host_pid` is
  // alive — if so, skip this tick. The pre-existing claude is still
  // working and will finalize via ISS-68's stop-handler DB fallback.
  if (await hasLiveDispatchForCard(repo.name, primary.external_id)) {
    log.info(
      `[${repo.name}] ${primary.title} already has live dispatch (host_pid alive) — skipping`,
    );
    return;
  }

  // Multi-environment dispatch lock. Same Trello card can be polled
  // independently from local dev + production EC2 worker; without a
  // tracker-side lock both write competing local YAMLs and silently
  // overwrite each other on sync. See `src/issue-tracker/lock.ts`.
  const lockInfo = buildLockHolderInfo({
    targetName,
    repoPath: repo.localPath,
    workspace: "issue-worker",
    dispatchId,
  });
  const lockResult = await tryAcquireLock(
    tracker,
    primary.external_id,
    lockInfo,
  );
  if (!lockResult.acquired) {
    const held = lockResult.existing!;
    const ageM = Math.round(
      (Date.now() - new Date(held.startedAt).getTime()) / 60000,
    );
    log.info(
      `[${repo.name}] ${primary.title} held by ${held.holder}@${held.host} (dispatch ${held.dispatchId}, ${ageM}m old) — skipping this tick`,
    );
    return;
  }
  if (lockResult.reclaimed) {
    log.info(
      `[${repo.name}] ${primary.title} lock reclaimed (previous holder went stale)`,
    );
  }

  // Pre-stamp the YAML with the dispatch shell BEFORE spawn so a
  // crash between `dispatch()` resolving and the post-spawn pid stamp
  // still leaves a partial record on disk that the next reattach pass
  // can recover from. The `buildStartStamp` helper enforces the
  // pid:0 + host + ISO + per-kind-TTL invariant in one place. Phase 2
  // of poller-triage rework (ISS-92), refactored to a helper in
  // Phase 4 (ISS-94).
  const startStamp = buildStartStamp(dispatchId, "work", osHostname());

  // Reuse the lookup the YAML-based guard above already performed when
  // present — `findByExternalId` is O(N) over the open dir, so paying
  // it twice would burn CPU on every dispatch tick.
  const existing =
    existingForGuard ??
    findByExternalId(repo.localPath, primary.external_id);
  let resolvedIssue: Issue;
  if (existing) {
    resolvedIssue = stampDispatchAndWrite(repo.localPath, existing, startStamp);
  } else {
    resolvedIssue = await hydrateFromRemote(
      tracker,
      primary.external_id,
      dispatchId,
      repo.localPath,
      repo.issuePrefix,
    );
    // hydrateFromRemote stamps the placeholder dispatch shape (pid:0,
    // host:"", started_at:"", ttl_seconds:0). Overwrite with the
    // enriched start record so the YAML carries the real
    // host/started_at/ttl_seconds even before the spawn returns.
    resolvedIssue = stampDispatchAndWrite(
      repo.localPath,
      resolvedIssue,
      startStamp,
    );
  }

  const yamlPath = issuePath(repo.localPath, resolvedIssue.id, "open");
  const task =
    `${TEAM_PROMPT}\n\nEdit ${yamlPath}. ` +
    `Call danx_issue_save({id: "${resolvedIssue.id}"}) when done.`;

  await spawnClaude(
    repo,
    task,
    { trigger: "trello", metadata: trelloMeta },
    dispatchId,
    undefined,
    { issueId: resolvedIssue.id, startStamp },
  );
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
/**
 * Pre-claim DB guard (ISS-69). Thin wrapper that wires the impl in
 * `live-dispatch-guard.ts` to the production `findNonTerminalDispatches`
 * + `isPidAlive` + `log`. Lives inline so the call site in `_poll`
 * stays a single readable line; the underlying logic is unit-tested in
 * `live-dispatch-guard.test.ts`.
 */
async function hasLiveDispatchForCard(
  repoName: string,
  cardId: string,
): Promise<boolean> {
  return hasLiveDispatchForCardImpl(repoName, cardId, {
    findNonTerminalDispatches,
    isPidAlive,
    log,
  });
}

async function bulkSyncMissingYamls(
  repo: RepoContext,
  tracker: IssueTracker,
  targets: IssueRef[],
): Promise<void> {
  for (const card of targets) {
    if (
      findByExternalId(repo.localPath, card.external_id)
    )
      continue;
    try {
      const hydrated = await hydrateFromRemote(
        tracker,
        card.external_id,
        null,
        repo.localPath,
        repo.issuePrefix,
      );
      writeIssue(repo.localPath, hydrated);
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

/**
 * Filter `cards` by blocked-state. For each card whose local YAML carries
 * a non-null `blocked` record:
 *
 *   - Resolve every id in `blocked.by[]` against the local YAML store.
 *   - If ANY blocker is missing locally OR has a non-terminal status
 *     (anything other than Done / Cancelled), the card stays blocked and
 *     is dropped from the dispatch list.
 *   - If EVERY blocker is terminal, clear `blocked` on the card's YAML,
 *     save, and keep it in the dispatch list.
 *
 * Cards with no local YAML (e.g. ToDo cards the poller hasn't yet
 * hydrated this tick — though bulk-sync should already have covered
 * them) are passed through unchanged. The dispatch path will
 * `findByExternalId` / `hydrateFromRemote` afterward.
 *
 * Read-only on the tracker: every check is a local-YAML lookup. The only
 * side effect is the `writeIssue` when blockers fully clear, which is
 * exactly the state transition the gate exists to record.
 */
async function resolveBlockedCards(
  repo: RepoContext,
  cards: IssueRef[],
): Promise<IssueRef[]> {
  const out: IssueRef[] = [];
  for (const card of cards) {
    const local = findByExternalId(repo.localPath, card.external_id);
    if (!local) {
      out.push(card);
      continue;
    }
    if (!local.blocked) {
      out.push(card);
      continue;
    }
    const blockers = local.blocked.by;
    const stillBlocking: string[] = [];
    for (const blockerId of blockers) {
      const blocker = loadLocal(repo.localPath, blockerId, repo.issuePrefix);
      if (!blocker) {
        stillBlocking.push(`${blockerId}(missing)`);
        continue;
      }
      if (blocker.status !== "Done" && blocker.status !== "Cancelled") {
        stillBlocking.push(`${blockerId}(${blocker.status})`);
      }
    }
    if (stillBlocking.length > 0) {
      log.info(
        `[${repo.name}] ${local.id} still blocked: ${stillBlocking.join(", ")}`,
      );
      continue;
    }
    // All blockers terminal — clear the record and save. The agent
    // re-picks the card next tick (or this tick if it's first in `out`).
    log.info(
      `[${repo.name}] ${local.id} all blockers terminal — clearing blocked`,
    );
    const cleared: Issue = { ...local, blocked: null };
    const path = issuePath(repo.localPath, cleared.id, "open");
    writeFileSync(path, serializeIssue(cleared));
    out.push(card);
  }
  return out;
}

/**
 * Look at every In Progress card. For the first one whose local YAML
 * carries a `dispatch.id` that:
 *   - is NOT currently in `activeJobs` (still alive on this worker), AND
 *   - DOES correspond to a Claude session JSONL on disk
 *
 * spawn a fresh dispatch with `--resume <sessionId>` so the agent
 * picks up where it left off. Returns `{ resumed: true }` when a resume
 * fires (the caller must skip the ToDo dispatch path on this tick to
 * preserve the single-dispatch invariant).
 *
 * Side-effect for the "session file gone" case: card resets to ToDo
 * locally (YAML status + dispatch cleared) AND on the tracker. The
 * reset card's `IssueRef` (with `status: "ToDo"`) is returned in
 * `resetToToDo` so the caller can include it in this tick's dispatch
 * pool — the snapshot of `cards` taken before this scan ran is stale
 * by the time we mutate the card's status, and waiting a full poll
 * interval before picking it up wastes the tick.
 *
 * Skipped silently when the In Progress card has no local YAML (the
 * bulk-sync step that runs immediately before this should have
 * written one — if it didn't, hydration failed and a warning is
 * already in the log) or no `dispatch` record (the agent never
 * reached the YAML stamp before dying — same fresh-ToDo recovery
 * applies on the next tick once it bubbles up there).
 */
type OrphanScanResult =
  | { resumed: true }
  | { resumed: false; resetToToDo: IssueRef[] };

async function tryResumeOrphan(
  repo: RepoContext,
  tracker: IssueTracker,
  inProgressRefs: IssueRef[],
): Promise<OrphanScanResult> {
  const resetToToDo: IssueRef[] = [];
  for (const ref of inProgressRefs) {
    const issue = findByExternalId(repo.localPath, ref.external_id);
    // No local YAML — bulk-sync runs immediately before this so a
    // missing YAML means hydration failed; warning already logged
    // upstream. Skip and let the next sync attempt fix it.
    if (!issue) continue;

    // No `dispatch` record on a card sitting in In Progress. The prior
    // agent died before the YAML stamp (or the card was force-moved by
    // an operator). Nothing to resume against, and the card will sit
    // in In Progress forever unless we reset it. Reset to ToDo so the
    // poller's regular dispatch path picks it up on the next bubble.
    // Skip the reset only when the dispatches DB shows a live host_pid
    // for this card (host-mode `script -q -f` reparented claude to
    // PID 1 and is still running — see ISS-69).
    if (!issue.dispatch) {
      if (await hasLiveDispatchForCard(repo.name, ref.external_id)) {
        log.info(
          `[${repo.name}] Skipping orphan-reset for "${issue.title}" (${issue.id}) — no YAML dispatch stamp, but dispatches DB has live host_pid`,
        );
        continue;
      }
      log.warn(
        `[${repo.name}] In Progress card "${issue.title}" (${issue.id}) has no dispatch stamp — resetting to ToDo for fresh dispatch`,
      );
      writeIssue(repo.localPath, {
        ...issue,
        status: "ToDo",
      });
      try {
        await tracker.moveToStatus(ref.external_id, "ToDo");
      } catch (err) {
        log.error(
          `[${repo.name}] Failed to reset ${ref.external_id} to ToDo on tracker: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      resetToToDo.push({ ...ref, status: "ToDo" });
      continue;
    }
    const dispatchId = issue.dispatch.id;

    // Live job on this worker — the orphan check would race with the
    // running dispatch. Skip; the live dispatch will reach completion
    // (or stall) through its own monitoring path.
    if (getActiveJob(dispatchId)) continue;

    // ISS-92 Phase 2: YAML-based liveness guard. The boot reattach
    // pass populated `activeDispatches` with every alive PID it found
    // on disk. An entry here means "this card's dispatch{} block
    // points at a same-host PID that responded to signal 0 within the
    // TTL window" — the prior dispatch is still alive across the
    // worker restart. Skip orphan-resume; the YAML's evictDeadDispatches
    // path will clear it on the tick after the PID dies.
    if (getActiveDispatches(repo.name).has(issue.id)) {
      log.info(
        `[${repo.name}] Skipping orphan-resume for "${issue.title}" (${issue.id}) — YAML reattach has it registered as alive (dispatch ${dispatchId})`,
      );
      continue;
    }

    // ISS-69 mirror: in-memory `activeJobs` is wiped on every worker
    // restart, but host-mode dispatches outlive the worker — `script
    // -q -f` reparents claude to PID 1, so the prior agent is still
    // running. Without this DB-backed liveness probe the orphan-resume
    // path stamps a NEW dispatch.id and spawns a duplicate claude
    // (observed in the ISS-66 dispatch that produced this fix). The
    // ToDo dispatch path already guards via `hasLiveDispatchForCard`
    // (see line ~429); orphan-resume runs BEFORE that path and must
    // apply the same check or the duplicate happens before the ToDo
    // guard ever gets a chance to fire.
    //
    // Kept alongside the YAML-based check as defense-in-depth: the DB
    // guard catches dispatches whose YAML block was lost (file deleted
    // by an operator, schema corruption) but whose dispatches table
    // row still records the live host_pid.
    if (await hasLiveDispatchForCard(repo.name, ref.external_id)) {
      log.info(
        `[${repo.name}] Skipping orphan-resume for "${issue.title}" (${issue.id}) — dispatches DB has live host_pid for card ${ref.external_id}`,
      );
      continue;
    }

    const resolved = await resolveParentSessionId(repo.name, dispatchId);
    if (resolved.kind === "no-session-dir") {
      // No claude projects dir for this repo — infrastructure issue
      // that affects every dispatch, not just this one. Stop the
      // resume scan so we don't keep paying the lookup cost on every
      // remaining In Progress card.
      log.error(
        `[${repo.name}] No claude session dir for repo — skipping orphan-resume scan`,
      );
      return { resumed: false, resetToToDo };
    }
    if (resolved.kind === "not-found") {
      log.warn(
        `[${repo.name}] In Progress card "${issue.title}" (${issue.id}) has dispatch.id ${dispatchId} but no matching JSONL on disk — resetting to ToDo`,
      );
      writeIssue(repo.localPath, {
        ...issue,
        status: "ToDo",
        dispatch: null,
      });
      try {
        await tracker.moveToStatus(ref.external_id, "ToDo");
      } catch (err) {
        log.error(
          `[${repo.name}] Failed to reset ${ref.external_id} to ToDo on tracker: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Surface the reset to the caller so this tick can dispatch the
      // card immediately as a ToDo. `cards` was snapshotted before the
      // orphan scan ran, so the caller appends `resetToToDo` to it
      // before falling through to the dispatch path.
      resetToToDo.push({ ...ref, status: "ToDo" });
      continue;
    }

    log.info(
      `[${repo.name}] Resuming orphan In Progress card "${issue.title}" (${issue.id}) — parent dispatch ${dispatchId} session ${resolved.sessionId}`,
    );
    const newDispatchId = randomUUID();
    const startStamp = buildStartStamp(newDispatchId, "work", osHostname());
    const stamped = stampDispatchAndWrite(repo.localPath, issue, startStamp);
    const yamlPath = issuePath(repo.localPath, stamped.id, "open");
    // ISS-135 — explicit RESUMED-dispatch contract. The May-7 incident
    // showed an orphan-resumed agent re-running /danx-next from
    // scratch against a card whose prior session had already shipped
    // the work + commits, then re-dispatching `danxbot_complete` as
    // if it were starting fresh. The contract below tells the agent
    // to read the YAML FIRST, recognise terminal state (Done /
    // Cancelled + every AC checked + retro filled), and call
    // danxbot_complete WITHOUT redoing any work. Anything short of
    // terminal — find the smallest gap and resume from there.
    //
    // Keep in sync with the "Resume self-check" sections in
    // src/poller/inject/workspaces/issue-worker/.claude/skills/
    //   danx-next/SKILL.md (Step 1.1) and danx-start/SKILL.md.
    // Two-layer defense: this prompt is what the agent sees on its
    // first turn; the skill section is what it sees if it ever
    // consults the workflow. Both must agree on the "terminal + ACs
    // checked + retro filled = call danxbot_complete and stop" rule.
    const task =
      `${TEAM_PROMPT_RESUME}\n\n` +
      `RESUMED dispatch on ${stamped.id} (parent ${dispatchId}).\n\n` +
      `CONTRACT — read FIRST, act AFTER:\n` +
      `1. Read ${yamlPath} now. Note current status, AC checked-state, retro state, commits in retro.commits[].\n` +
      `2. If status ∈ {Done, Cancelled} AND every AC item checked AND retro filled — work is COMPLETE. ` +
      `Call danxbot_complete({status: "completed", summary: "..."}) immediately. ` +
      `Do NOT re-run /danx-next. Do NOT redo any work. Do NOT save the YAML again.\n` +
      `3. Else, identify the smallest gap (uncompleted AC, missing retro field, unverified AC item) and resume from that point. ` +
      `Save the YAML when each gap closes. Call danxbot_complete only when every gap is closed.\n\n` +
      `This is a RESUME, not a fresh dispatch. The prior session already did most or all of the work. Verify, don't repeat.`;
    await spawnClaude(
      repo,
      task,
      {
        trigger: "trello",
        metadata: {
          cardId: ref.external_id,
          cardName: ref.title,
          cardUrl: `https://trello.com/c/${ref.external_id}`,
          listId: repo.trello.inProgressListId,
          listName: "In Progress",
        },
      },
      newDispatchId,
      { resumeSessionId: resolved.sessionId, parentJobId: dispatchId },
      { issueId: stamped.id, startStamp },
    );
    return { resumed: true };
  }
  return { resumed: false, resetToToDo };
}

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
    pruneStaleDanxArtifactsInWorkspace(
      resolve(injectWorkspacesDir, entry),
      workspaceDir,
    );
  }
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

  // Stage 2: per-repo render into every plural workspace.
  renderPerRepoFilesIntoWorkspaces(repo, danxbotConfigDir, cfg, workspacesDir);

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
    copyRepoToolsDoc(danxbotConfigDir, target);
    copyRepoToolScripts(danxbotConfigDir, target);
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

async function spawnClaude(
  repo: RepoContext,
  prompt: string,
  apiDispatchMeta: DispatchTriggerMetadata,
  dispatchId?: string,
  resumeOpts?: { resumeSessionId: string; parentJobId: string },
  /**
   * When set, the dispatch is bound to a per-card YAML. The poller
   * builds a `YamlPairedWrite` callback pair from this and threads it
   * through `dispatch()` to the launcher; the launcher invokes
   * `pairedWriteHostPid` AFTER the runtime fork resolves the agent
   * PID, stamping the DB row's `host_pid` and the YAML's
   * `dispatch.pid` atomically. The `write` callback also registers
   * the card in `activeDispatches`; the completion callback later
   * clears `dispatch: null` and drops the in-memory entry. Ideator /
   * auto-triage paths omit this — there is no card-bound dispatch
   * slot for those (auto-triage runs across many cards as one
   * session).
   *
   * Originally ISS-92, Phase 2 of the poller-triage rework. DX-140
   * moved the post-spawn stamping inside the launcher under the
   * paired-write contract.
   */
  dispatchStamp?: { issueId: string; startStamp: IssueDispatch },
): Promise<void> {
  const state = getState(repo.name);

  state.teamRunning = true;

  // Track the Trello card this dispatch targets. The post-dispatch
  // "card didn't move out of ToDo" check in `handleAgentCompletion`
  // reads this field to detect env-level blockers. Ideator/api
  // dispatches are not card-specific — null tracks "no card to check".
  state.trackedCardId =
    apiDispatchMeta.trigger === "trello"
      ? apiDispatchMeta.metadata.cardId
      : null;

  // The poller's tracker calls (fetchOpenCards, moveToStatus, retro
  // comments) need a usable IssueTracker. Resolve the cached tracker
  // up front so the validation key is the RESOLVED tracker class, not
  // an env var the createIssueTracker factory reads internally — that
  // keeps "which tracker is active" with one source of truth and
  // eliminates the only `process.env` read that used to live on the
  // poller hot path.
  //
  // Only TrelloTracker requires populated credentials on RepoContext;
  // MemoryTracker (DANXBOT_TRACKER=memory) constructs without them.
  // Fail loud here so a missing value surfaces as a clear configuration
  // error before we spawn an agent that the poller can't follow up on.
  // The dispatch overlay itself no longer needs these (Phase 5 of
  // tracker-agnostic-agents retired the trello MCP server entry from
  // the issue-worker workspace).
  const tracker = getRepoTracker(repo);
  const trello = repo.trello;
  if (
    tracker instanceof TrelloTracker &&
    (!trello?.apiKey || !trello?.apiToken || !trello?.boardId)
  ) {
    throw new Error(
      `[${repo.name}] poller dispatchCard called without complete trello credentials on RepoContext`,
    );
  }

  // Workspace-shaped dispatch (Phase 3 of the workspace-dispatch epic,
  // Trello `q5aFuINM`). The poller's allowed-tools, MCP server set, and
  // skill surface live in `src/poller/inject/workspaces/issue-worker/`
  // and are mirrored to `<repo>/.danxbot/workspaces/issue-worker/` by
  // the inject pipeline on every poll tick. `dispatch` resolves that
  // fixture, merges the danxbot infrastructure server, and runs the
  // shared spawn loop — stall recovery, activeJobs registration,
  // completion signalling. The poller still supplies its own
  // `timeoutMs` (60x poll interval) and chains `handleAgentCompletion`
  // through `onComplete`. See `.claude/rules/agent-dispatch.md`.
  //
  // Awaited (not fire-and-forget): the post-spawn YAML PID stamp
  // (DX-140 paired write) runs INSIDE `spawnAgent` after the runtime
  // fork resolves the agent's PID. Awaiting `dispatch()` blocks the
  // poll tick for the spawn duration (~1–3s in practice). The runtime
  // agent execution is still async via `onComplete` — we only sequence
  // the spawn itself.
  //
  // Phase 1 of DB-as-dispatch-registry (DX-140) — when the dispatch is
  // bound to a per-card YAML, build a `YamlPairedWrite` pair and pass
  // it through `pairedWriteYaml`. The launcher invokes
  // `pairedWriteHostPid` AFTER the runtime fork resolves the agent
  // PID; both the DB row's `host_pid` and the YAML's `dispatch.pid`
  // are stamped in one logical operation with mutual rollback.
  // Replaces the old "stamp YAML pid post-dispatch in the poller"
  // path which left a window where DB + YAML carried divergent values.
  const pairedWriteYaml = dispatchStamp
    ? {
        write: (pid: number) => {
          const enrichedStamp: IssueDispatch = {
            ...dispatchStamp.startStamp,
            pid,
          };
          const issue = loadLocal(
            repo.localPath,
            dispatchStamp.issueId,
            repo.issuePrefix,
          );
          // Fail loud — if the YAML disappeared between dispatch start
          // and PID resolution (concurrent close/move, operator
          // intervention, broken inject pipeline) silently skipping the
          // YAML stamp would leave the DB row carrying `host_pid` while
          // the YAML carries nothing. That recreates the divergent
          // half-stamped state the paired write exists to prevent.
          // Throwing routes the helper into its YAML-fail rollback
          // branch (DB stamp UPDATE never runs because YAML write is
          // first; if it had run, the DB rollback fires).
          if (!issue) {
            throw new Error(
              `paired-write: YAML for ${dispatchStamp.issueId} disappeared during dispatch — cannot stamp pid ${pid}`,
            );
          }
          stampDispatchAndWrite(repo.localPath, issue, enrichedStamp);
          // Mirror into the in-memory active map for the per-tick liveness
          // probe — keeps the poller's existing reattach logic functional.
          getActiveDispatches(repo.name).set(
            dispatchStamp.issueId,
            enrichedStamp,
          );
        },
        clear: () => {
          // Rollback path — DB UPDATE failed after we wrote the YAML.
          // Clear the YAML's `dispatch{}` and drop the in-memory entry
          // so the next tick sees a clean slate.
          const issue = loadLocal(
            repo.localPath,
            dispatchStamp.issueId,
            repo.issuePrefix,
          );
          if (issue && issue.dispatch !== null) {
            clearDispatchAndWrite(repo.localPath, issue);
          }
          getActiveDispatches(repo.name).delete(dispatchStamp.issueId);
        },
      }
    : undefined;

  try {
    await dispatch({
      repo,
      task: prompt,
      workspace: "issue-worker",
      // `DANXBOT_WORKER_PORT` and the dispatchId-derived URLs are
      // auto-injected by `dispatch()` from `repo.workerPort`. Phase 5 of
      // tracker-agnostic-agents retired the trello MCP server entry from
      // the issue-worker workspace, so TRELLO_API_KEY / TRELLO_TOKEN /
      // TRELLO_BOARD_ID no longer need an overlay either — agents now
      // talk to the tracker through the danxbot MCP server's
      // `danx_issue_*` tools, which the worker proxies.
      overlay: {},
      timeoutMs: config.pollerIntervalMs * 60,
      apiDispatchMeta,
      // Phase 2 of tracker-agnostic-agents (Trello ZDb7FOGO): when the trello
      // trigger pre-stamped a UUID into the YAML, thread it through so the
      // dispatch row's id matches the YAML's `dispatch.id`. Ideator and other
      // non-trello dispatches omit this and inherit the auto-generated UUID
      // inside `dispatch()`.
      dispatchId,
      resumeSessionId: resumeOpts?.resumeSessionId,
      parentJobId: resumeOpts?.parentJobId,
      pairedWriteYaml,
      onComplete: (job) => {
        // ISS-92 Phase 2: dispatch end clears the YAML's `dispatch{}`
        // and drops the in-memory entry. Runs BEFORE the failure-
        // handling backoff so a rapid re-tick doesn't see stale state.
        // Skipped silently when no dispatchStamp was passed (ideator /
        // auto-triage paths).
        if (dispatchStamp) {
          clearActiveDispatch(repo, dispatchStamp.issueId);
        }
        handleAgentCompletion(repo, state, job).catch((err) =>
          log.error(`[${repo.name}] Error in post-completion handler`, err),
        );
      },
    });
  } catch (err) {
    // Pre-spawn failures (workspace resolution error, OS spawn error, MCP probe
    // failure) deliberately skip the exponential-backoff escalator:
    // these are configuration / infrastructure errors, not intermittent
    // agent failures. We reset `teamRunning` so the next tick retries
    // immediately and the problem shows up every minute until the
    // operator fixes it. Runtime agent failures take the separate
    // `handleAgentCompletion` path above, which DOES apply backoff.
    log.error(`[${repo.name}] dispatch() failed before agent spawned`, err);
    if (dispatchStamp) {
      // Pre-spawn failure leaves the pre-stamped dispatch{} block on
      // the YAML pointing at a dispatch that never started. Clear so
      // the next tick sees a clean slate; the regular ToDo dispatch
      // path will re-pick the card up with a fresh dispatchId.
      const issue = loadLocal(
        repo.localPath,
        dispatchStamp.issueId,
        repo.issuePrefix,
      );
      if (issue) {
        try {
          clearDispatchAndWrite(repo.localPath, issue);
        } catch (clearErr) {
          log.error(
            `[${repo.name}] pre-spawn cleanup: clearDispatch failed for ${dispatchStamp.issueId}`,
            clearErr,
          );
        }
      }
      getActiveDispatches(repo.name).delete(dispatchStamp.issueId);
    }
    cleanupAfterAgent(state);
  }
}

/**
 * Drop a card from the per-repo `activeDispatches` map AND clear its
 * YAML's `dispatch{}` block. Idempotent — missing in-memory entry +
 * already-null YAML are both no-ops.
 *
 * Called from the dispatch onComplete chain. Distinct from
 * `evictDeadDispatches` (per-tick liveness cleanup) — this fires on
 * agent termination, regardless of whether the agent saved a terminal
 * status or simply exited (timeout, stall, kill).
 */
function clearActiveDispatch(repo: RepoContext, issueId: string): void {
  const map = getActiveDispatches(repo.name);
  map.delete(issueId);
  const issue = loadLocal(repo.localPath, issueId, repo.issuePrefix);
  if (issue && issue.dispatch !== null) {
    try {
      clearDispatchAndWrite(repo.localPath, issue);
    } catch (err) {
      log.error(
        `[${repo.name}] clearActiveDispatch: write failed for ${issueId}`,
        err,
      );
    }
  }
}

/**
 * Handle agent completion: track failures, apply backoff, recover stuck cards.
 * On success, resets the failure counter. On failure, increments the counter,
 * recovers stuck cards, and applies exponential backoff.
 */
async function handleAgentCompletion(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): Promise<void> {
  const isFailure = job.status !== "completed";

  if (isFailure) {
    state.consecutiveFailures++;
    log.warn(
      `[${repo.name}] Agent ${job.status} (${state.consecutiveFailures} consecutive failure${state.consecutiveFailures > 1 ? "s" : ""})`,
    );

    // Recover stuck cards before backoff
    await recoverStuckCards(repo, state, job);

    const schedule = config.pollerBackoffScheduleMs;
    if (state.consecutiveFailures > schedule.length) {
      log.error(
        `[${repo.name}] Max consecutive failures (${state.consecutiveFailures}) exceeded schedule — halting poller`,
      );
      cleanupAfterAgent(state);
      return; // Don't resume polling
    }

    const backoffMs = schedule[state.consecutiveFailures - 1];
    state.backoffUntil = Date.now() + backoffMs;
    log.warn(
      `[${repo.name}] Backing off ${backoffMs / 1000}s before next attempt`,
    );
  } else {
    if (state.consecutiveFailures > 0) {
      log.info(`[${repo.name}] Agent succeeded — resetting failure counter`);
    }
    state.consecutiveFailures = 0;
    state.backoffUntil = 0;
  }

  // Post-dispatch card-progress check. Runs on both success and
  // failure — a "completed" agent that never moved the card is as much
  // of an env-level signal as a "failed" one. If the card still sits
  // in ToDo, this writes the critical-failure flag; the next tick's
  // halt gate will see it and refuse to dispatch.
  if (state.trackedCardId) {
    await checkCardProgressedOrHalt(repo, state, job);
  }

  // ISS-104: parallel guard for triage dispatches. A triage agent that
  // signals `completed` without advancing `triage.expires_at` would be
  // re-dispatched against the same card on every tick — a token-burn
  // loop the existing trello-trigger guard does not catch (triage
  // dispatches use `trigger: "api"` and never move the card across
  // lists). Same fail-loud halt mechanism via the critical-failure flag.
  if (state.triageTracked) {
    checkTriageProgressedOrHalt(repo, state, job);
  }

  cleanupAfterAgent(state);
  log.info(`[${repo.name}] Headless agent finished — resuming polling`);
  poll(repo).catch((err) =>
    log.error(`[${repo.name}] Re-poll after headless agent failed`, err),
  );
}

function cleanupAfterAgent(state: RepoPollerState): void {
  state.teamRunning = false;
  state.priorTodoCardIds = [];
  state.trackedCardId = null;
  state.triageTracked = null;
}

/**
 * After a trello-triggered dispatch exits, fetch the tracked card's
 * current list. If it's still in ToDo, the dispatch made zero
 * progress — an env-level blocker the poller cannot recover from on
 * its own. Write the critical-failure flag so the next tick halts.
 *
 * Complementary to `recoverStuckCards`, which handles the case where
 * the agent moved a card to In Progress but failed mid-work (the
 * recovery there moves it to Needs Help). This function handles the
 * distinct case where the agent never moved the card at all — the
 * classic signal that MCP or Bash failed to load.
 *
 * A fetch failure here does NOT trip the flag: we only halt when we
 * have positive evidence the card stayed in ToDo. Swallowing the
 * error and logging is intentional — the next tick will try again.
 */
async function checkCardProgressedOrHalt(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): Promise<void> {
  const cardId = state.trackedCardId;
  if (!cardId) return;

  const tracker = getRepoTracker(repo);
  let card: Issue;
  try {
    card = await tracker.getCard(cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] Failed to fetch tracked card ${cardId} after dispatch — skipping card-progress check`,
      err,
    );
    return;
  }

  if (card.status !== "ToDo") {
    // Card moved to In Progress / Needs Help / Done / Cancelled / Review.
    // The dispatch made SOME progress even if it ultimately failed — not
    // an env-level issue. Leave the flag untripped.
    return;
  }

  // Legitimately Blocked: the agent decided the card is waiting on
  // other in-flight work and stamped a `blocked` record on the local
  // YAML (worker contract `blocked != null` → `status: "ToDo"`). The
  // tracker reports ToDo, but this is intentional progress, not an
  // env-level failure. The poller's blocked-card gate handles
  // re-dispatching once the blocker terminates. Read the local YAML
  // (the only source of structured `blocked` data — Trello has no
  // native field) and skip the flag when it's set.
  //
  // Ordering invariant: the agent calls `danx_issue_save` (which
  // synchronously persists the YAML via writeFileSync in the worker's
  // issue-save handler) BEFORE calling `danxbot_complete`. By the time
  // the worker fires `onComplete` and we reach this check, the blocked
  // record is already on disk. No race.
  //
  // `findByExternalId` is the only structured reader we have for the
  // YAML's `blocked` field; tolerate read failures the same way we
  // tolerate `tracker.getCard` failures above — log and skip the flag
  // (false-negative, never false-positive).
  let local;
  try {
    local = findByExternalId(repo.localPath, cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] Failed to read local YAML for ${cardId} during post-dispatch check — skipping flag`,
      err,
    );
    return;
  }
  if (local?.blocked) {
    log.info(
      `[${repo.name}] Tracked card "${card.title}" (${cardId}) intentionally Blocked by ${local.blocked.by.join(", ")} — skipping critical-failure check`,
    );
    return;
  }

  log.error(
    `[${repo.name}] Tracked card "${card.title}" (${cardId}) still in ToDo after dispatch ${job.id} — writing critical-failure flag`,
  );
  writeFlag(repo.localPath, {
    source: "post-dispatch-check",
    dispatchId: job.id,
    cardId,
    cardUrl: `https://trello.com/c/${cardId}`,
    reason: `Tracked card "${card.title}" did not move out of ToDo after dispatch`,
    detail:
      `Card ${cardId} (${card.title}) stayed in the ToDo list across dispatch ${job.id} ` +
      `(status=${job.status}, summary=${job.summary || "none"}). ` +
      `Poller halts until this flag is cleared and the underlying environment blocker is fixed.`,
  });
}

/**
 * After a `kind: "triage"` dispatch exits, re-read the target YAML
 * locally and verify `triage.expires_at` advanced past the dispatch's
 * `started_at`. If not, the dispatch did zero application-level work —
 * either the agent forgot to call `mcp__danx-issue__danx_issue_save`
 * or the save did not update the triage block. Either way the next
 * tick's `listTriageDueYamls` returns the same card and the same broken
 * agent gets dispatched again. Write the critical-failure flag so the
 * halt gate stops the loop.
 *
 * Parallels `checkCardProgressedOrHalt` (work-dispatch guard). The
 * progress signal differs:
 *   - work dispatch: tracker reports the card moved out of ToDo.
 *   - triage dispatch: local YAML's `triage.expires_at` parses to a
 *     timestamp strictly after the dispatch's `started_at`.
 *
 * Read failures (loadLocal throws, YAML missing) do NOT trip the flag —
 * false-negative is safer than false-positive, mirroring the work-
 * dispatch guard's tolerance for `tracker.getCard` / `findByExternalId`
 * failures. The next tick reattempts; if the underlying env problem
 * also breaks the next dispatch, that next dispatch will surface the
 * signal through its own guard.
 *
 * Sync (not async) because everything it does is sync — `loadLocal`
 * reads the YAML synchronously and `writeFlag` is a synchronous
 * tmp+rename. Keeping the signature sync avoids gratuitous Promise
 * plumbing in the completion handler.
 *
 * Phase 1 of ISS-104.
 */
function checkTriageProgressedOrHalt(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): void {
  const tracked = state.triageTracked;
  if (!tracked) return;

  let issue: Issue | null;
  try {
    issue = loadLocal(repo.localPath, tracked.id, repo.issuePrefix);
  } catch (err) {
    log.error(
      `[${repo.name}] Failed to read local YAML for triage target ${tracked.id} after dispatch — skipping triage-progress check`,
      err,
    );
    return;
  }

  if (!issue) {
    // YAML disappeared (deleted, renamed to closed/, or never existed).
    // The poller cannot re-dispatch a missing id, so the loop self-
    // terminates without a flag.
    return;
  }

  const startedAtMs = Date.parse(tracked.startedAt);
  const expiresAt = issue.triage?.expires_at ?? "";
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const advanced =
    !!expiresAt && Number.isFinite(expiresAtMs) && expiresAtMs > startedAtMs;
  if (advanced) {
    return;
  }

  log.error(
    `[${repo.name}] Triage dispatch ${job.id} for ${tracked.id} did not advance triage.expires_at (started_at=${tracked.startedAt}, post=${expiresAt || "(empty)"}) — writing critical-failure flag`,
  );
  writeFlag(repo.localPath, {
    source: "post-dispatch-check",
    dispatchId: job.id,
    cardId: tracked.id,
    reason: `Triage dispatch for ${tracked.id} did not advance triage.expires_at`,
    detail:
      `Triage dispatch ${job.id} for ${tracked.id} ` +
      `(status=${job.status}, summary=${job.summary || "none"}) finished but the local YAML's ` +
      `triage.expires_at is still "${expiresAt || ""}" (started_at=${tracked.startedAt}). ` +
      `The next tick would re-dispatch the same broken triage agent — token-burn loop. ` +
      `Poller halts until the flag is cleared and the underlying issue (agent forgot ` +
      `to save, MCP danx-issue not loaded, etc.) is fixed.`,
  });
}

/**
 * After agent failure, check if any cards moved from ToDo to In Progress
 * during the agent's run. If so, move them to Needs Help with a comment.
 */
async function recoverStuckCards(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): Promise<void> {
  if (state.priorTodoCardIds.length === 0) return;

  const tracker = getRepoTracker(repo);
  try {
    // ISS-86: source of truth for "is this card stuck in progress?" is
    // the local YAML, not tracker.fetchOpenCards. Match by external_id
    // so the priorTodoCardIds set (recorded before dispatch from the
    // tracker view) keys correctly into the local-derived list.
    const stuckCards = listInProgressYamls(repo.localPath, repo.issuePrefix)
      .map(localIssueToRef)
      .filter((card) => state.priorTodoCardIds.includes(card.external_id));

    for (const card of stuckCards) {
      log.warn(
        `[${repo.name}] Recovering stuck card "${card.title}" → Needs Help`,
      );
      await tracker.moveToStatus(card.external_id, "Needs Help");

      const elapsed = formatElapsed(job);
      const comment = `## Agent Failure — Card Recovery

The agent working on this card ${job.status} after ${elapsed}.

**Error:** ${job.summary || "No details available"}

This card was automatically moved to Needs Help. Review the error and move back to ToDo to retry.

${DANXBOT_COMMENT_MARKER}`;

      await tracker.addComment(card.external_id, comment);
    }
  } catch (err) {
    log.error(`[${repo.name}] Failed to recover stuck cards`, err);
  }
}

function formatElapsed(job: AgentJob): string {
  const ms =
    (job.completedAt?.getTime() ?? Date.now()) - job.startedAt.getTime();
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}min`;
}

/**
 * Per-card triage dispatch gate (Phase 4 of ISS-90). Replaces the
 * legacy bulk `checkAndSpawnTriage` (one session over every Action
 * Items + Review card) with a single-card dispatch — one tick fires
 * one `danx-triage-card` agent against one specific YAML.
 *
 * Invoked from the empty-ToDo branch of `_poll` BEFORE
 * `checkAndSpawnIdeator`. Returns `true` when it spawned a triage
 * agent — the caller honors the per-tick single-dispatch invariant by
 * returning immediately. Returns `false` when:
 *   - `autoTriage` is disabled (env default or operator override), OR
 *   - no triage-due card exists.
 *
 * Triage-due eligibility (delegated to `listTriageDueYamls`):
 *   - `dispatch === null` (no in-flight dispatch on the card)
 *   - `triage.expires_at === ""` OR `Date.parse(expires_at) <= now`
 *   - `blocked != null` OR `status` ∈ {Review, Needs Help}
 * Sort: never-triaged first, then `expires_at` ASC.
 *
 * The dispatched agent runs with `kind: "triage"` and TTL 600s
 * (`TTL_SECONDS_BY_KIND.triage`). Same `dispatchStamp` lifecycle as a
 * work dispatch — pre-stamp on the YAML, register in
 * `activeDispatches`, post-spawn pid update, onComplete cleanup.
 */
async function tryTriageDispatch(repo: RepoContext): Promise<boolean> {
  // Per-repo runtime toggle. Env default is `false` — operators opt in
  // via the dashboard Agents tab. See `.claude/rules/settings-file.md`.
  if (!isFeatureEnabled(repo, "autoTriage")) {
    log.info(
      `[${repo.name}] Auto-triage disabled (settings.json override or env default) — skipping`,
    );
    return false;
  }

  const due = listTriageDueYamls(repo.localPath, Date.now(), repo.issuePrefix);
  if (due.length === 0) {
    return false;
  }

  const target = due[0];
  log.info(
    `[${repo.name}] Triage-due: dispatching ${target.id} (status=${target.status}, blocked=${target.blocked ? "yes" : "no"}, expires_at=${target.triage.expires_at || "(never)"})`,
  );

  const dispatchId = randomUUID();
  // Stamp the dispatch record on disk BEFORE spawn so a crash between
  // dispatch() resolving and the post-spawn pid stamp leaves a partial
  // record the next reattach pass can recover from. Same invariant as
  // the work-ready dispatch path; the helper centralizes the
  // pid:0/host/TTL contract across all three spawn sites.
  const startStamp = buildStartStamp(dispatchId, "triage", osHostname());
  const stamped = stampDispatchAndWrite(repo.localPath, target, startStamp);
  const prompt = TRIAGE_CARD_PROMPT(stamped.id);

  // ISS-104: record the triage target + dispatch start timestamp so the
  // post-dispatch guard in `handleAgentCompletion` can verify the
  // dispatch actually moved `triage.expires_at` forward. Set BEFORE
  // `await spawnClaude` so the field is in place by the time
  // `onComplete` fires. Pre-spawn failures route through spawnClaude's
  // catch branch which calls `cleanupAfterAgent` directly (without
  // `handleAgentCompletion`), so the field is cleared without tripping
  // the guard — correct because no agent ran on the pre-spawn-failure
  // path.
  const state = getState(repo.name);
  state.triageTracked = {
    id: stamped.id,
    startedAt: startStamp.started_at,
  };

  await spawnClaude(
    repo,
    prompt,
    {
      trigger: "api",
      metadata: {
        endpoint: "poller/triage-card",
        callerIp: null,
        statusUrl: null,
        initialPrompt: prompt.slice(0, 500),
      },
    },
    dispatchId,
    undefined,
    { issueId: stamped.id, startStamp },
  );
  return true;
}

/**
 * Shared spawn shape for poller-driven, non-card API dispatches
 * (ideator + any future periodic that does NOT bind to a specific
 * card YAML). Wraps the `spawnClaude` call with the metadata block
 * every poller-side `api` trigger needs: `endpoint` slug,
 * `initialPrompt` preview slice, and the null `callerIp` /
 * `statusUrl` fields the Trello-trigger path doesn't apply.
 */
function spawnPollerApiAgent(
  repo: RepoContext,
  prompt: string,
  endpoint: string,
): void {
  // Fire-and-forget: ideator has no per-card YAML stamp to write
  // post-spawn (no `dispatchStamp` arg), so the only reason to await
  // `spawnClaude` here would be sequencing — and the caller
  // (`_poll` empty-ToDo branch) is already at end-of-tick. Errors
  // surface via the dispatch.catch path inside `spawnClaude`.
  void spawnClaude(repo, prompt, {
    trigger: "api",
    metadata: {
      endpoint,
      callerIp: null,
      statusUrl: null,
      initialPrompt: prompt.slice(0, 500),
    },
  });
}

async function checkAndSpawnIdeator(
  repo: RepoContext,
  tracker: IssueTracker,
): Promise<void> {
  // Per-repo runtime toggle. Env default is `false` — operators opt in
  // via the dashboard Agents tab. Checked BEFORE the Review-list fetch
  // so a disabled repo doesn't pay the tracker round-trip on every
  // empty-ToDo tick. See `.claude/rules/settings-file.md`.
  if (!isFeatureEnabled(repo, "ideator")) {
    log.info(
      `[${repo.name}] Ideator disabled (settings.json override or env default) — skipping`,
    );
    return;
  }

  let reviewCards: IssueRef[];
  try {
    const all = await tracker.fetchOpenCards();
    reviewCards = all.filter((c) => c.status === "Review");
  } catch (error) {
    log.error(`[${repo.name}] Error fetching Review cards`, error);
    return;
  }

  if (reviewCards.length >= REVIEW_MIN_CARDS) {
    log.info(
      `[${repo.name}] Review has ${reviewCards.length} cards (min ${REVIEW_MIN_CARDS}) — no ideation needed`,
    );
    return;
  }

  log.info(
    `[${repo.name}] Review has ${reviewCards.length} cards (min ${REVIEW_MIN_CARDS}) — spawning ideator`,
  );
  // Ideator runs don't originate from a specific card — tag them as API
  // dispatches so the poller run is still visible in dispatch history.
  spawnPollerApiAgent(repo, IDEATOR_PROMPT, "poller/ideator");
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

export function start(): void {
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

    // Boot reattach (ISS-92, Phase 2). Walks every open YAML, registers
    // alive dispatches in `activeDispatches`, clears YAMLs whose
    // dispatch is dead/expired/cross-host. MUST run before the first
    // `poll(repo)` call so the dispatch path doesn't double-spawn a
    // card whose previous claude is still alive across worker restart.
    runStartupReattach(repo);

    poll(repo);
    state.intervalId = setInterval(() => poll(repo), config.pollerIntervalMs);
  }
}

/** Reset module state for testing. Do not use in production. */
export function _resetForTesting(): void {
  for (const state of repoState.values()) {
    state.teamRunning = false;
    state.polling = false;
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }
  repoState.clear();
  trackerByRepo.clear();
  activeDispatches.clear();
}

// Auto-start when run as the direct entrypoint.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/poller/index.ts");

if (isDirectEntrypoint) {
  start();
}
