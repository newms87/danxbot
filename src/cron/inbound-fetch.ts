/**
 * Trello inbound fetch — Phase 5 of Event-Driven Worker (DX-220).
 *
 * Wraps the three tracker-inbound concerns the cron sweep retains:
 *
 *   1. **Needs Help comment scan** — cards in the Trello `Blocked`
 *      list (a.k.a. `Needs Help`) whose latest comment lacks the
 *      `<!-- danxbot -->` marker get moved to `ToDo` so the user
 *      response receives priority dispatch attention.
 *   2. **Open-card fetch** — pull every open card on the board so we
 *      know what bulk-sync must produce locally.
 *   3. **Bulk hydration** — for every fetched card that lacks a local
 *      YAML, hydrate from remote and write to `<repo>/.danxbot/issues/
 *      open/<id>.yml`. The chokidar watcher fires
 *      `reconcileIssue(id, "hydrate")` per write.
 *
 * The trio is gated on the `trelloSync` per-repo settings toggle
 * (DX-302). When `trelloSync` is `false`, every call short-circuits —
 * the cron sweep proceeds without touching the tracker.
 *
 * Lives outside `sync-and-audit.ts` so the inbound path can grow
 * independently — adding a comment scan or a new inbound mirror to a
 * different status list doesn't bloat the cron orchestrator.
 */

import { DANXBOT_COMMENT_MARKER } from "../issue-tracker/markers.js";
import {
  findByExternalId,
  hydrateFromRemote,
  writeIssue,
} from "../poller/yaml-lifecycle.js";
import type {
  IssueRef,
  IssueTracker,
} from "../issue-tracker/interface.js";
import { isFeatureEnabled } from "../settings-file.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";

const log = createLogger("cron-inbound");

export interface InboundFetchResult {
  /** Cards bulk-synced this tick (new YAMLs written). */
  hydrated: string[];
  /** Needs Help → ToDo moves this tick. */
  movedFromNeedsHelp: number;
  /** Cards fetched from the tracker (for downstream stats). */
  openCards: IssueRef[];
  /** Whether the trelloSync toggle was enabled. */
  trelloSyncEnabled: boolean;
}

/**
 * Run the full inbound pass for one repo. Tolerates tracker fetch
 * failures (logs + returns an empty `openCards` list); per-card
 * hydration failures are isolated inside `bulkSyncMissingYamls`.
 *
 * Designed to be called from the cron sweep — synchronous per-step
 * orchestration so the chokidar events fire in deterministic order
 * relative to the audit pass that follows.
 */
export async function runInboundFetch(
  repo: RepoContext,
  tracker: IssueTracker,
): Promise<InboundFetchResult> {
  const result: InboundFetchResult = {
    hydrated: [],
    movedFromNeedsHelp: 0,
    openCards: [],
    trelloSyncEnabled: false,
  };

  // DX-302 — `trelloSync` per-repo override halts every Trello inbound
  // + outbound call without halting the WHOLE cron tick. The
  // `issuePoller` toggle (checked one level up in `poll()`) gates the
  // entire sweep; this one is finer-grained — local-YAML dispatch keeps
  // running but Trello calls short-circuit.
  result.trelloSyncEnabled = isFeatureEnabled(repo, "trelloSync");
  if (!result.trelloSyncEnabled) {
    log.info(
      `[${repo.name}] trello sync disabled via settings — skipping inbound hydration + comment pull`,
    );
    return result;
  }

  log.info(`[${repo.name}] Checking Needs Help + ToDo lists...`);

  // Check Needs Help first — user-responded cards get moved to ToDo top.
  result.movedFromNeedsHelp = await checkNeedsHelp(repo, tracker);
  if (result.movedFromNeedsHelp > 0) {
    log.info(
      `[${repo.name}] Moved ${result.movedFromNeedsHelp} card${result.movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`,
    );
  }

  try {
    result.openCards = await tracker.fetchOpenCards();
  } catch (error) {
    log.error(`[${repo.name}] Error fetching cards`, error);
    return result;
  }

  // ISS-86: `tracker.fetchOpenCards` is the inbound channel ONLY (new
  // cards + bulk-sync). It does NOT decide what gets dispatched —
  // local YAML is the source of truth and the multi-agent dispatch
  // path (`src/poller/multi-agent-pick.ts`, scheduled via the
  // scheduler's `runPicker` callback) reads dispatchable cards from
  // the DB-backed listing in `local-issues.ts`. DX-218 retired the
  // per-tick orphan-push pass; outbound (YAML → tracker) pushes are
  // now reconcile step 7's job. DX-290 retired the legacy dispatch
  // decision pass from `runSync` entirely.
  //
  // Cards on the Trello Action Items list surface with
  // `status: "Review"` (see `trello.ts#listIdToStatus`) so they are
  // bulk-synced through the Review branch alongside other Review
  // cards.
  const trackerToDoRefs = result.openCards.filter((c) => c.status === "ToDo");
  const trackerInProgressRefs = result.openCards.filter(
    (c) => c.status === "In Progress",
  );
  const trackerReviewRefs = result.openCards.filter(
    (c) => c.status === "Review",
  );
  const trackerNeedsHelpRefs = result.openCards.filter(
    (c) => c.status === "Blocked",
  );

  // Bulk-sync every tracker-listed card that lacks a local YAML so the
  // multi-agent dispatch path and per-card triage agent each have a
  // YAML to read. Coverage:
  //   - Every ToDo card (DX-290: the prior single-card dispatch primary path
  //     had its own dedicated hydrate pipeline that took the primary
  //     directly; that pipeline is gone, so we hydrate the whole bucket).
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
  const hydrated = await bulkSyncMissingYamls(repo, tracker, [
    ...trackerToDoRefs,
    ...trackerInProgressRefs,
    ...trackerReviewRefs,
    ...trackerNeedsHelpRefs,
  ]);
  result.hydrated = hydrated;

  return result;
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

/**
 * Hydrate every card in `targets` that has no local YAML. Tolerates
 * per-card failures (warns + skips) — bulk-sync is a best-effort
 * convergence step. The dispatch primary's hydration runs separately
 * with throw-on-failure semantics.
 *
 * `dispatch` is null for every bulk-synced YAML — these are advisory
 * writes that capture remote state, not dispatch claims. A subsequent
 * tick that picks the card as a primary (ToDo) or as a resume target
 * (In Progress with a stamped id from a prior dispatch) stamps the
 * real UUID via `stampDispatchAndWrite`.
 *
 * Returns the list of `<PREFIX>-N` ids that successfully hydrated this
 * call — the cron sweep can log a per-tick total.
 */
async function bulkSyncMissingYamls(
  repo: RepoContext,
  tracker: IssueTracker,
  targets: IssueRef[],
): Promise<string[]> {
  const hydrated: string[] = [];
  for (const card of targets) {
    if (await findByExternalId(repo.localPath, card.external_id)) continue;
    try {
      const issue = await hydrateFromRemote(
        tracker,
        card.external_id,
        null,
        repo.localPath,
        repo.issuePrefix,
      );
      await writeIssue(repo.localPath, issue);
      log.info(
        `[${repo.name}] bulk-sync: hydrated ${card.external_id} → ${issue.id}`,
      );
      hydrated.push(issue.id);
    } catch (err) {
      log.warn(
        `[${repo.name}] bulk-sync: failed to hydrate ${card.external_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return hydrated;
}
