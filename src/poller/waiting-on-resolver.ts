/**
 * Blocked-card resolver. Pure-local helper extracted from
 * `src/poller/index.ts` (DX-147). Keeps the auto-clear path testable
 * without paying the env-validation tax of pulling `index.ts` into a
 * test (per `.claude/rules/danx-repo-workflow.md` "Isolate Pure Helpers").
 *
 * Responsibility: filter a list of `IssueRef`s by blocked-state. For
 * each card whose local YAML carries a non-null `blocked` record:
 *
 *  - Resolve every id in `blocked.by[]` against the local YAML store.
 *  - If ANY blocker is missing locally OR has a non-terminal status
 *    (anything other than Done / Cancelled), the card stays blocked
 *    and is dropped from the dispatch list.
 *  - If EVERY blocker is terminal:
 *      1. Append one `unblocked` entry to the card's `history[]`
 *         attributed to `worker:auto-derive` with the rule that fired
 *         as the `note` (DX-147 AC #2).
 *      2. Clear `blocked` to null and persist.
 *      3. Keep the card in the dispatch list — the poller dispatches
 *         it on this same tick.
 *
 * Cards with no local YAML (e.g. ToDo cards the poller hasn't yet
 * hydrated this tick) pass through unchanged. The dispatch path
 * downstream `findByExternalId` / `hydrateFromRemote`s them.
 */

import { findByExternalId, loadLocal, writeIssue } from "./yaml-lifecycle.js";
import { appendHistory } from "../issue-tracker/yaml.js";
import type { Issue, IssueRef } from "../issue-tracker/interface.js";
import { createLogger } from "../logger.js";

const log = createLogger("blocked-resolver");

/**
 * Minimal context shape consumed by `resolveBlockedCards`. Subset of
 * `RepoContext` so callers can pass either the full context or a
 * lightweight test stub.
 */
export interface BlockedResolverContext {
  /** Repo name, used only for log-line attribution. */
  name: string;
  /** Absolute path to the connected repo's worktree. */
  localPath: string;
  /** Per-repo issue-id prefix (e.g. `"DX"` or `"ISS"`). */
  issuePrefix: string;
}

export function resolveBlockedCards(
  repo: BlockedResolverContext,
  cards: IssueRef[],
): IssueRef[] {
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
    // DX-147: stamp the audit-log entry BEFORE the file write so the
    // on-disk YAML carries the unblocked event. `note` lists every id
    // that resolved so dashboard readers can correlate the unblock back
    // to the chain that gated this card.
    const updatedHistory = appendHistory(local.history, {
      timestamp: new Date().toISOString(),
      actor: "worker:auto-derive",
      event: "unblocked",
      note: `All blockers terminal: ${blockers.join(", ")}`,
    });
    const cleared: Issue = {
      ...local,
      blocked: null,
      history: updatedHistory,
    };
    writeIssue(repo.localPath, cleared);
    out.push(card);
  }
  return out;
}
