/**
 * Reconcile step 7 — outbound tracker push (Phase 3 of the Event-Driven
 * Worker epic, DX-218).
 *
 * `pushTrelloDiff({issue, repoName, repoLocalPath, issuePrefix, tracker})`
 * is the single function reconcile.ts calls in step 7 to mirror a YAML to
 * the tracker. The body is a thin orchestrator over `syncIssue`
 * (`src/issue-tracker/sync.ts`), which already implements the full
 * field-level diff against the remote card and the create-on-empty-
 * external_id branch (orphan recovery — the YAML never had an
 * `external_id` because it was hand-written or split out of an epic).
 *
 * **Per-card serial queue.** Module-scoped
 * `Map<repoName-id, Promise<TrelloPushResult>>` keyed on the same
 * `(repoName, id)` pair as reconcile's mutex. Two reconciles for the
 * SAME card chain their pushes onto the previous tail; reconciles for
 * DIFFERENT cards run their pushes in parallel. The slot is separate
 * from the reconcile mutex so reconcile's body can release its mutex
 * before awaiting the network round-trip — otherwise other reconciles
 * for the same card would pile up behind a slow Trello call.
 *
 * Trade-off: reconcile body can return BEFORE the trailing tracker push
 * lands. Acceptable because (a) the DB mirror upsert already happened
 * (Phase 1 step 6) so dashboard reads are consistent, (b) callers don't
 * need read-your-writes against the tracker (we're the only writer). The
 * one consumer that DOES need to await — `auto-sync.ts` (lifecycle
 * trigger from `danxbot_complete`) — uses reconcile's lifecycle await
 * to block on the slot's resolve.
 *
 * **Persist after push.** When `syncIssue` returns an `updatedLocal` that
 * differs structurally from the input issue (orphan-recovered
 * external_id, AC check_item_id stamps, inbound human comments,
 * appended retro comment id), this module writes the new YAML back to
 * disk via `persistIfDifferent`. The next chokidar tick fires another
 * reconcile against the new file content — which finds the same
 * external_id, calls syncIssue, sees a no-op diff against the remote
 * card we just wrote, and returns 0 writes. The cycle terminates after
 * one additional reconcile.
 *
 * **On error: enqueue retry.** When `syncIssue` throws (transient Trello
 * error: 5xx, 429, network), this module calls `enqueueRetry` from
 * `src/issue-tracker/retry-queue.ts` so a later attempt picks up the
 * failed push without blocking reconcile. The error is recorded
 * non-fatally on the result; reconcile carries on.
 */

import { existsSync, readFileSync } from "node:fs";
import { loadActionItemTitles, syncIssue } from "../../issue-tracker/sync.js";
import { enqueueRetry } from "../../issue-tracker/retry-queue.js";
import { persistIfDifferent } from "./trello-persist.js";
import { issuePath } from "../../issue-tracker/paths.js";
import { IssueParseError, parseIssue } from "../../issue-tracker/yaml.js";
import { readLists } from "../../lists-file.js";
import { readTrelloListMap } from "../../trello-list-map.js";
import { recordSystemError } from "../../dashboard/system-errors.js";
import type { Issue, IssueTracker } from "../../issue-tracker/interface.js";
import { createLogger } from "../../logger.js";

const log = createLogger("reconcile-trello");

/**
 * Optional injection seam for the retry-queue scheduler. Passed through
 * to `enqueueRetry` so the timer-armed retry callback can surface
 * max-attempts exhaustion via the dashboard. The push side itself does
 * not surface push errors via this hook — callers see them through the
 * `TrelloPushResult.errors` array.
 */
export interface TrelloPushDeps {
  recordSystemError?: (message: string) => void | Promise<void>;
  /** Test seam — overrides `Date.now()` in retry-queue's enqueue path. */
  now?: () => number;
}

export interface TrelloPushArgs {
  issue: Issue;
  repoName: string;
  repoLocalPath: string;
  issuePrefix: string;
  tracker: IssueTracker;
  deps?: TrelloPushDeps;
}

export interface TrelloPushError {
  step: "syncIssue" | "persist" | "load-action-items";
  message: string;
}

export interface TrelloPushResult {
  /** `true` when at least one tracker mutation was issued. */
  pushed: boolean;
  /** Number of `tracker.<method>` mutating calls issued by `syncIssue`. */
  remoteWriteCount: number;
  /**
   * The tracker-side mutation surface returned by `syncIssue`:
   * orphan-recovered external_id, AC check_item_id stamps, inbound
   * human comments, appended retro comment. `null` when the push
   * errored or was an orphan-recovered no-op.
   */
  updatedLocal: Issue | null;
  /**
   * Non-fatal errors. Tracker-error rejections from `syncIssue` land
   * here AND enqueue a retry. Callers (reconcile step 7) treat these
   * as non-fatal and proceed.
   */
  errors: TrelloPushError[];
  /**
   * `true` when this push enqueued a retry (the network call failed).
   * Visible for tests + observability; reconcile does not branch on it.
   */
  retryEnqueued: boolean;
}

/**
 * Per-card serial queue. The map value is the `Promise` of the most-
 * recently-scheduled push for that card; new schedules chain onto it
 * via `prev.catch(() => undefined).then(...)` so a rejected push body
 * does not poison subsequent slots.
 *
 * Cleanup: when a push body settles AND it's still the tail for its
 * key, the entry is deleted. A schedule that races a deletion (next
 * push arrives during the cleanup microtask) sees the slot empty and
 * starts a fresh chain, which is safe — the prior push already
 * completed.
 */
const pushSlots = new Map<string, Promise<TrelloPushResult>>();

function slotKey(repoName: string, id: string): string {
  return `${repoName} ${id}`;
}

/** Visible for tests — observe whether a slot is currently active. */
export function _hasPushSlot(repoName: string, id: string): boolean {
  return pushSlots.has(slotKey(repoName, id));
}

/** Visible for tests — drain the slot map between cases. */
export function _resetPushSlots(): void {
  pushSlots.clear();
}

/**
 * Schedule a `pushTrelloDiff` body on the per-card serial queue. Returns
 * the promise of THIS schedule (not the prior tail). Concurrent calls
 * for the same `(repoName, id)` are FIFO-serialized.
 */
export function pushTrelloDiff(
  args: TrelloPushArgs,
): Promise<TrelloPushResult> {
  const key = slotKey(args.repoName, args.issue.id);
  const prev =
    pushSlots.get(key) ??
    Promise.resolve<TrelloPushResult>({
      pushed: false,
      remoteWriteCount: 0,
      updatedLocal: null,
      errors: [],
      retryEnqueued: false,
    });
  // Swallow the prior push's rejection / failure so it doesn't kill the
  // chain. Each push body has its own try/catch and reports its own
  // failure on the returned `errors` array.
  const next = prev.catch(() => undefined).then(() => doPush(args));
  // Cleanup tail — when this schedule settles AND it's still the tail,
  // delete the slot. `Promise.allSettled`-style swallow so the cleanup
  // never throws.
  const tail: Promise<unknown> = next.catch(() => undefined);
  pushSlots.set(key, next);
  void tail.then(() => {
    if (pushSlots.get(key) === next) pushSlots.delete(key);
  });
  return next;
}

/**
 * DX-610 — resolve the issue's `list_name` to a danxbot list id, look
 * it up in the per-repo Trello list-mapping file, and decide whether
 * to skip the outbound push. Returns `true` when the card is on a
 * danxbot list with no Trello mapping (unmapped) — in that case the
 * caller records a warning to the dashboard stream and stops.
 *
 * The function is read-only on disk and tolerant of missing /
 * unparseable files (treats them as "no mapping configured" — skip).
 * Pre-DX-575 cards (no `list_name`) are not gated by the caller, so
 * this only fires once cards carry the v10 denormalized field.
 */
function shouldSkipPushForUnmappedList(
  repoLocalPath: string,
  repoName: string,
  issue: Issue,
): boolean {
  if (issue.list_name === null) return false;
  let lists;
  try {
    lists = readLists(repoLocalPath).lists;
  } catch (err) {
    log.warn(
      `[${repoName}] ${issue.id} could not read lists.yaml for push gate; allowing push`,
      err,
    );
    return false;
  }
  const danxbotList = lists.find((l) => l.name === issue.list_name);
  if (!danxbotList) {
    // The card carries a `list_name` that no longer matches any
    // configured list. Skip + record so the operator notices their
    // stale projection rather than silently pushing the card based on
    // the legacy status→list mapping.
    recordSystemError({
      source: "trello-list-mapping",
      severity: "warn",
      repo: repoName,
      message: `Skipped Trello push for ${issue.id}: list_name "${issue.list_name}" no longer maps to a configured danxbot list.`,
      details: { issueId: issue.id, listName: issue.list_name },
    });
    return true;
  }
  let map;
  try {
    map = readTrelloListMap(repoLocalPath);
  } catch (err) {
    log.warn(
      `[${repoName}] ${issue.id} could not read trello-list-map.yaml for push gate; allowing push`,
      err,
    );
    return false;
  }
  const trelloListId = map.list_id_to_trello_list_id[danxbotList.id];
  if (typeof trelloListId !== "string" || trelloListId.length === 0) {
    recordSystemError({
      source: "trello-list-mapping",
      severity: "warn",
      repo: repoName,
      message: `Skipped Trello push for ${issue.id}: danxbot list "${danxbotList.name}" has no Trello mapping.`,
      details: {
        issueId: issue.id,
        listName: issue.list_name,
        danxbotListId: danxbotList.id,
      },
    });
    return true;
  }
  return false;
}

/**
 * Re-read the YAML from disk at dequeue time so a serialized push always
 * sees the freshest bytes. With chokidar churn, multiple reconciles can
 * chain pushes for the same card on the slot; without this re-read,
 * each push body would run `syncIssue` against the stale snapshot it
 * captured at schedule time. Returns the on-disk Issue when the file
 * exists + parses, or `null` when the file disappeared / parse failed
 * (caller falls back to the captured snapshot).
 */
function readFreshIssue(args: TrelloPushArgs): Issue | null {
  const openPath = issuePath(args.repoLocalPath, args.issue.id, "open");
  const closedPath = issuePath(args.repoLocalPath, args.issue.id, "closed");
  const path = existsSync(openPath)
    ? openPath
    : existsSync(closedPath)
      ? closedPath
      : null;
  if (path === null) return null;
  try {
    return parseIssue(readFileSync(path, "utf-8"), {
      expectedPrefix: args.issuePrefix,
    });
  } catch (err) {
    log.warn(
      `[${args.repoName}] ${args.issue.id} fresh-read parse failed (${
        err instanceof IssueParseError ? err.message : String(err)
      }); falling back to captured snapshot`,
    );
    return null;
  }
}

async function doPush(args: TrelloPushArgs): Promise<TrelloPushResult> {
  const errors: TrelloPushError[] = [];
  const result: TrelloPushResult = {
    pushed: false,
    remoteWriteCount: 0,
    updatedLocal: null,
    errors,
    retryEnqueued: false,
  };

  // DX-218: re-read the YAML at dequeue time so concurrent reconciles
  // chained on the slot push the LATEST bytes, not the captured snapshot
  // from schedule time. Fall back to the captured snapshot when the
  // file vanished / parse failed — the captured snapshot is still
  // useful for orphan-recovery (`external_id === ""`).
  const fresh = readFreshIssue(args);
  const issue = fresh ?? args.issue;

  // DX-610 outbound push gate. When the card carries a `list_name` that
  // resolves to a danxbot list id NOT mapped to a Trello list (via the
  // operator-configured `<repo>/.danxbot/trello-list-map.yaml` from
  // DX-609), skip the push so cards on operator-private lists never
  // mirror to Trello. `list_name === null` is the legacy fallback (no
  // tracker projection yet) — the existing status→list resolution in
  // `syncIssue.moveToStatus` continues to drive the move there. Errors
  // surface on the dashboard system-errors stream; the agent never sees
  // them.
  if (issue.list_name !== null) {
    const skip = shouldSkipPushForUnmappedList(
      args.repoLocalPath,
      args.repoName,
      issue,
    );
    if (skip) return result;
  }

  let actionItemTitles;
  try {
    actionItemTitles = loadActionItemTitles(
      args.repoLocalPath,
      issue.retro.action_item_ids,
      args.issuePrefix,
      log,
    );
  } catch (err) {
    errors.push({
      step: "load-action-items",
      message: err instanceof Error ? err.message : String(err),
    });
    actionItemTitles = undefined;
  }

  let updatedLocal: Issue;
  let remoteWriteCount: number;
  try {
    const out = await syncIssue(args.tracker, issue, {
      actionItemTitles,
    });
    updatedLocal = out.updatedLocal;
    remoteWriteCount = out.remoteWriteCount;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ step: "syncIssue", message: msg });
    log.warn(
      `[${args.repoName}] ${issue.id} push failed (${msg}); enqueuing retry`,
    );
    try {
      enqueueRetry({
        issueId: issue.id,
        repoLocalPath: args.repoLocalPath,
        repoName: args.repoName,
        issuePrefix: args.issuePrefix,
        tracker: args.tracker,
        errMessage: msg,
        ...(args.deps?.recordSystemError && {
          recordSystemError: args.deps.recordSystemError,
        }),
        ...(args.deps?.now && { now: args.deps.now }),
      });
      result.retryEnqueued = true;
    } catch (enqueueErr) {
      const eMsg =
        enqueueErr instanceof Error
          ? enqueueErr.message
          : String(enqueueErr);
      log.warn(
        `[${args.repoName}] retry enqueue failed for ${issue.id}: ${eMsg}`,
      );
    }
    return result;
  }

  result.remoteWriteCount = remoteWriteCount;
  result.pushed = remoteWriteCount > 0;
  result.updatedLocal = updatedLocal;

  try {
    persistIfDifferent(args.repoLocalPath, issue.id, updatedLocal, log);
  } catch (err) {
    errors.push({
      step: "persist",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
