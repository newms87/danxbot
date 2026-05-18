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
import { getDefaultListForType, readLists } from "../lists-file.js";
import {
  readTrelloListMap,
  reverseLookupDanxbotListId,
  type TrelloListMap,
} from "../trello-list-map.js";
import type { ListType } from "../lists-types.js";

// DX-621 / Phase 9d — inline list-type → mapped Trello list id resolver.
// Inlined here (vs imported from trello-list-map.ts) so the test's
// `vi.mock` boundaries on `lists-file.js` + `trello-list-map.js`
// intercept this function's calls cleanly — a sibling export inside
// `trello-list-map.ts` captures `readTrelloListMap` in its closure at
// import time, defeating `vi.importActual` based mocks.
function resolveTrelloListIdByTypeLocal(
  localPath: string,
  type: ListType,
): string {
  let lists;
  try {
    lists = readLists(localPath);
  } catch {
    return "";
  }
  const defaultList = lists.lists.find(
    (l) => l.type === type && l.is_default_for_type,
  );
  if (!defaultList) return "";
  const map = readTrelloListMap(localPath);
  return map.list_id_to_trello_list_id[defaultList.id] ?? "";
}
import { recordSystemError } from "../dashboard/system-errors.js";
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
    log.debug(
      `[${repo.name}] trello sync disabled via settings — skipping inbound hydration + comment pull`,
    );
    return result;
  }

  log.debug(`[${repo.name}] Checking mapped Trello lists...`);

  // DX-621 / Phase 9d — read both files ONCE per tick so the loop +
  // checkNeedsHelp share the same snapshot. Mapped Trello list ids are
  // the universe the cron polls; no implicit ordering, no hard-coded
  // status→list resolution.
  const trelloMap = readTrelloListMap(repo.localPath);
  const mappedTrelloListIds = Object.values(
    trelloMap.list_id_to_trello_list_id,
  );

  // Check Needs Help first — user-responded cards get moved to ToDo top.
  result.movedFromNeedsHelp = await checkNeedsHelp(repo, tracker, trelloMap);
  if (result.movedFromNeedsHelp > 0) {
    log.info(
      `[${repo.name}] Moved ${result.movedFromNeedsHelp} card${result.movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`,
    );
  }

  // DX-621 — caller always invokes fetchOpenCards (even with an empty
  // list) so downstream test mocks + cron pacing stay consistent; the
  // tracker short-circuits to [] when the list array is empty.
  try {
    result.openCards = await tracker.fetchOpenCards(mappedTrelloListIds);
  } catch (error) {
    log.error(`[${repo.name}] Error fetching cards`, error);
    return result;
  }

  // ISS-86: `tracker.fetchOpenCards` is the inbound channel ONLY (new
  // cards + bulk-sync). It does NOT decide what gets dispatched —
  // local YAML is the source of truth and the multi-agent dispatch
  // path reads dispatchable cards from the DB-backed listing in
  // `local-issues.ts`.
  //
  // DX-621 / Phase 9d — every card on a mapped Trello list is a hydrate
  // candidate. The prior status-bucketed `concat` collapsed to "all
  // mapped lists" once the legacy status→list resolution was retired;
  // routing by danxbot list type happens via reverse-map lookup inside
  // `bulkSyncMissingYamls`.
  const hydrated = await bulkSyncMissingYamls(repo, tracker, result.openCards);
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
  trelloMap: TrelloListMap,
): Promise<number> {
  // DX-658 / Phase 2 of "Blocked becomes a dispatch gate, not a status"
  // retired the `"blocked"` ListType, so this helper no longer has a
  // Trello source list to poll. The pre-DX-658 Needs-Help flow watched
  // Trello's Blocked column for user replies; today the self-block
  // gate (`Issue.blocked != null`) is the canonical signal, cleared
  // via the dashboard's Clear-Block button. Kept as a no-op so the
  // caller's per-tick sweep wiring stays intact while the future
  // gate-cleared inbound shape is decided.
  void repo;
  void tracker;
  void trelloMap;
  return 0;
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
  // DX-619 — read both files ONCE per bulk-sync tick. `readLists` +
  // `readTrelloListMap` are filesystem hits; hoisting them above the
  // loop keeps the per-card hydration loop O(card-count) IO instead of
  // O(card-count * 2) IO.
  const listsFile = readLists(repo.localPath);
  const trelloMap = readTrelloListMap(repo.localPath);
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
      // DX-619 — assign `list_name` via reverse-map lookup from the
      // operator-configured `trello-list-map.yaml`. `hydrateFromRemote`
      // returns `list_name: null` (tracker layer is list-name-agnostic)
      // so this is the SOLE writer on the inbound-hydration path. The
      // resolution is best-effort: an unmapped Trello list / a missing
      // `external_list_id` / a stale danxbot list id in the map all
      // degrade to the Review default. Decoupling invariant — this is
      // inside `inbound-fetch.ts`, one of the three allowed Trello
      // surfaces per CLAUDE.md.
      issue.list_name = resolveInboundListName(
        repo,
        card.external_list_id,
        listsFile,
        trelloMap,
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

/**
 * Resolve the danxbot list name a freshly-hydrated tracker card should
 * land in. Reverse-walks `trello-list-map.yaml`; on ambiguity (operator
 * mapped multiple danxbot lists to the same Trello list) picks the
 * first match in `lists.yaml` order and records a `warn`-severity
 * system error so the operator sees the configuration drift in the
 * dashboard. Any miss falls back to the `review`-type default list.
 *
 * `listsFile` + `trelloMap` are passed in by the caller so a bulk-sync
 * loop hits the filesystem ONCE per tick (not once per card). The
 * Review fallback is the only branch that re-reads — `getDefaultListForType`
 * walks `lists.yaml` itself; that's an N+1 read tolerable only on the
 * rare fallback branch.
 */
function resolveInboundListName(
  repo: RepoContext,
  externalListId: string | undefined,
  listsFile: ReturnType<typeof readLists>,
  trelloMap: ReturnType<typeof readTrelloListMap>,
): string {
  if (!externalListId) {
    return getDefaultListForType(repo.localPath, "review").name;
  }
  const matchedIds = reverseLookupDanxbotListId(trelloMap, externalListId);
  if (matchedIds.length === 0) {
    return getDefaultListForType(repo.localPath, "review").name;
  }
  const matchedSet = new Set(matchedIds);
  const picked = listsFile.lists.find((l) => matchedSet.has(l.id));
  if (!picked) {
    // Map references danxbot list ids that no longer exist in lists.yaml
    // (operator deleted the list after configuring the map). Degrade
    // to the Review default — the orphan surfaces on the Settings tab
    // via classifyTrelloListMapping.
    return getDefaultListForType(repo.localPath, "review").name;
  }
  if (matchedIds.length > 1) {
    recordSystemError({
      source: "trello-list-mapping",
      severity: "warn",
      repo: repo.name,
      message: `Trello list ${externalListId} reverse-maps to multiple danxbot lists ${JSON.stringify(matchedIds)} — picked "${picked.name}" (first in lists.yaml order). Operator should resolve the duplicate mapping in the Settings tab.`,
      details: { external_list_id: externalListId, candidates: matchedIds, picked: picked.id },
    });
  }
  return picked.name;
}
