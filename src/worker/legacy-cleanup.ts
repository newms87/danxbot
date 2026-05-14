/**
 * Worker-boot one-shot cleanup of legacy `Needs Approval` Trello artifacts
 * (DX-265, Phase 2 of the DX-263 card-edit gaps epic).
 *
 * DX-231 retired the `Needs Approval` parking status in favor of the
 * orthogonal {@link import("../issue-tracker/interface.js").RequiresHuman}
 * field. DX-234 punted the legacy Trello list + label cleanup ("operator
 * removes by hand"); this module is the follow-through that automates
 * the removal so connected boards no longer carry the stale artifacts as
 * visual noise.
 *
 * Runs ONCE per worker boot from `startWorkerMode` (`src/index.ts`),
 * after `bootScheduler` registers the tracker and before the poller
 * starts ticking. The orchestrator is idempotent — every step short-
 * circuits when the underlying artifact is already absent, so a re-run
 * after a successful pass is a no-op. Per-step failures surface as
 * `severity: "warn"` system errors and don't propagate; the next boot
 * retries naturally.
 *
 * NOT in the agent's critical path — the worker drives this from its
 * own boot, never from a dispatched agent. Trello unreachability here
 * is a warn-level event surfaced on the dashboard banner, never a
 * dispatch blocker.
 */

import {
  recordSystemError,
  recordSystemEvent,
} from "../dashboard/system-errors.js";
import { createLogger } from "../logger.js";
import {
  hydrateFromRemote,
  writeIssue,
} from "../poller/yaml-lifecycle.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import { TrelloTracker } from "../issue-tracker/trello.js";
import type { RepoContext } from "../types.js";

const log = createLogger("legacy-cleanup");

/** Name of the retired Trello list AND the retired Trello label. */
const LEGACY_NAME = "Needs Approval";

/** `requires_human.reason` stamped on every migrated card. */
const MIGRATION_REASON =
  "Auto-migrated from legacy Needs Approval Trello list (DX-265)";

/** `requires_human.steps` stamped on every migrated card. */
const MIGRATION_STEPS: string[] = [
  "Triage the card — confirm the auto-generated reason still applies",
  "Either populate a real reason + steps OR clear `requires_human` once resolved",
];

export interface CleanupLegacyNeedsApprovalArgs {
  repo: RepoContext;
  tracker: IssueTracker;
}

export interface CleanupLegacyNeedsApprovalResult {
  /** External ids of every card the migration step hydrated to local YAML. */
  migrated: string[];
  /** External ids of cards whose migration threw — list archival is deferred. */
  failedMigrations: string[];
  /** True when the legacy list was found AND successfully archived this run. */
  listArchived: boolean;
  /** True when the legacy label was found AND successfully deleted this run. */
  labelDeleted: boolean;
  /**
   * True when the active tracker is not a {@link TrelloTracker} (e.g.
   * a non-Trello backend used by tests). Cleanup is Trello-specific —
   * non-Trello backends have no equivalent artifacts to remove.
   */
  skipped: boolean;
}

/**
 * One-shot orchestrator. Idempotent: re-running after a successful pass
 * returns a result with everything false / empty. Per-step failures are
 * recorded as warn-level system errors and do NOT propagate. If a card
 * migration fails, list archival is deferred (we never archive a list
 * that still has cards on it — that would orphan them on an archived
 * list and require operator intervention via the Trello UI).
 */
export async function cleanupLegacyNeedsApproval(
  args: CleanupLegacyNeedsApprovalArgs,
): Promise<CleanupLegacyNeedsApprovalResult> {
  const { repo, tracker } = args;
  const result: CleanupLegacyNeedsApprovalResult = {
    migrated: [],
    failedMigrations: [],
    listArchived: false,
    labelDeleted: false,
    skipped: false,
  };

  if (!(tracker instanceof TrelloTracker)) {
    // Non-Trello backends (test stubs / YAML-only mode) have no
    // Trello board to clean. Returning early here — rather than at
    // the orchestrator entry — keeps the skip path observable in
    // tests via `result.skipped`.
    result.skipped = true;
    return result;
  }

  // Step 1: look up legacy artifacts in parallel. A lookup failure
  // aborts the entire pass — without knowing whether the list/label
  // exists we cannot safely take any action.
  let list: { id: string; name: string } | null;
  let label: { id: string; name: string } | null;
  try {
    [list, label] = await Promise.all([
      tracker.findListByName(LEGACY_NAME),
      tracker.findLabelByName(LEGACY_NAME),
    ]);
  } catch (err) {
    recordSystemError({
      source: "legacy-cleanup",
      severity: "warn",
      repo: repo.name,
      message: `Legacy cleanup lookup failed for repo ${repo.name} — next boot will retry`,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return result;
  }

  if (!list && !label) {
    // Idempotent re-run path: artifacts already absent.
    return result;
  }

  // Step 2: migrate any stray cards off the legacy list. List archival
  // is deferred until every card moves successfully — Trello rejects an
  // archive that would orphan visible cards on a closed list anyway,
  // but the explicit gate makes the dashboard audit trail unambiguous.
  if (list) {
    let cards: Array<{ id: string; name: string }>;
    try {
      cards = await tracker.listCards(list.id);
    } catch (err) {
      recordSystemError({
        source: "legacy-cleanup",
        severity: "warn",
        repo: repo.name,
        message: `Legacy cleanup: failed to enumerate cards on '${LEGACY_NAME}' list — archival deferred`,
        details: {
          listId: list.id,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      // Continue to label cleanup — the label step is independent of
      // the list step and a list-listing failure shouldn't strand the
      // label fossil.
      cards = [];
      list = null;
    }

    for (const card of cards) {
      try {
        await migrateLegacyCard(repo, tracker, card.id);
        result.migrated.push(card.id);
        recordSystemEvent({
          source: "legacy-cleanup",
          repo: repo.name,
          message: `Migrated card ${card.id} ('${card.name}') from legacy '${LEGACY_NAME}' list → Review with requires_human stamped`,
          details: { externalId: card.id, name: card.name },
        });
      } catch (err) {
        result.failedMigrations.push(card.id);
        recordSystemError({
          source: "legacy-cleanup",
          severity: "warn",
          repo: repo.name,
          message: `Legacy cleanup: failed to migrate card ${card.id} ('${card.name}') — list archival deferred`,
          details: {
            externalId: card.id,
            name: card.name,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // Archive the list only if every card on it migrated cleanly.
    if (list && result.failedMigrations.length === 0) {
      try {
        await tracker.archiveList(list.id);
        result.listArchived = true;
        recordSystemEvent({
          source: "legacy-cleanup",
          repo: repo.name,
          message: `Archived legacy '${LEGACY_NAME}' list (reversible via Trello UI: More → Archive list → Send to Archive)`,
          details: { listId: list.id },
        });
      } catch (err) {
        recordSystemError({
          source: "legacy-cleanup",
          severity: "warn",
          repo: repo.name,
          message: `Legacy cleanup: failed to archive '${LEGACY_NAME}' list — next boot will retry`,
          details: {
            listId: list.id,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  // Step 3: delete the legacy label. Independent of list cleanup —
  // even if migration failed, the label is safe to delete (any card
  // still carrying it stays visible on the board with one fewer label,
  // and the label slot frees up for re-use).
  if (label) {
    try {
      await tracker.deleteLabel(label.id);
      result.labelDeleted = true;
      recordSystemEvent({
        source: "legacy-cleanup",
        repo: repo.name,
        message: `Deleted legacy '${LEGACY_NAME}' label (permanent — not reversible via Trello UI)`,
        details: { labelId: label.id },
      });
    } catch (err) {
      recordSystemError({
        source: "legacy-cleanup",
        severity: "warn",
        repo: repo.name,
        message: `Legacy cleanup: failed to delete '${LEGACY_NAME}' label — next boot will retry`,
        details: {
          labelId: label.id,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  log.info(
    `[${repo.name}] Legacy cleanup: migrated=${result.migrated.length} failed=${result.failedMigrations.length} listArchived=${result.listArchived} labelDeleted=${result.labelDeleted}`,
  );

  return result;
}

/**
 * Move a single legacy card onto the Review list, hydrate it into a
 * local YAML, and stamp `requires_human` + the `## Migration` comment.
 *
 * Why move-then-hydrate rather than hydrate-then-move? `hydrateFromRemote`
 * routes through `tracker.getCard()` which calls `listIdToStatus(idList)`
 * — and the legacy list ID isn't in that map (DX-231 retired it), so a
 * direct hydrate while the card still sits on the legacy list would
 * throw "Trello list id … is not mapped to a status". Moving first puts
 * the card on a list the active sync layer understands.
 *
 * **Partial-failure window:** if `moveToStatus` succeeds but
 * `hydrateFromRemote` / `writeIssue` throws, the card lands on Review
 * without a local YAML AND without the `requires_human` stamp. This is
 * tolerated by design — the poller's per-tick `bulkSyncMissingYamls`
 * pass picks the card up on the next tick (it lives on Review now,
 * fully in the active list map) and hydrates it as a normal Review
 * card. The card is NOT orphaned. The only loss is the
 * `requires_human` stamp + `## Migration` comment, which an operator
 * can add by hand if needed. A rollback-on-failure scheme (re-move
 * the card back to the legacy list) is worse: it re-introduces the
 * card to a list slated for archival, and the next boot would loop on
 * the same failing migration. Accepting the partial-failure shape
 * lets the system converge on the next tick instead.
 */
async function migrateLegacyCard(
  repo: RepoContext,
  tracker: TrelloTracker,
  externalId: string,
): Promise<void> {
  await tracker.moveToStatus(externalId, "Review");

  const hydrated = await hydrateFromRemote(
    tracker,
    externalId,
    null,
    repo.localPath,
    repo.issuePrefix,
  );

  const now = new Date().toISOString();
  const augmented: Issue = {
    ...hydrated,
    requires_human: {
      reason: MIGRATION_REASON,
      steps: MIGRATION_STEPS,
      set_by: "agent",
      set_at: now,
    },
    comments: [
      ...hydrated.comments,
      {
        author: "danxbot",
        timestamp: now,
        text: [
          `## Migration`,
          ``,
          `Auto-migrated from the retired \`${LEGACY_NAME}\` Trello list (DX-231) to`,
          `status \`Review\` with \`requires_human\` populated. Operator should triage and`,
          `either populate a real reason or clear the field.`,
        ].join("\n"),
      },
    ],
  };

  await writeIssue(repo.localPath, augmented);
}
