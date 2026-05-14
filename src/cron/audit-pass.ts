/**
 * Audit pass — Phase 5 of Event-Driven Worker (DX-220).
 *
 * Per-tick walk over every open YAML calling
 * `reconcileIssue(card, "audit")`. The chokidar mirror + per-event
 * reconcile are the primary path for state convergence (Phase 2 / DX-217
 * absorbed the per-tick parent-derive, healer, and waiting-on auto-clear
 * passes into reconcile step 3; Phase 3 / DX-218 absorbed the orphan
 * push into reconcile step 7); this audit pass is the safety net for
 * any chokidar event the watcher dropped or any drift that crept in
 * between ticks.
 *
 * **Drift detection.** When the audit reconcile reports `changed: true`
 * we record an `audit-drift` system error so the dashboard banner
 * surfaces the divergence. `changed` means the canonical content hash
 * of the YAML on disk shifted during the audit — i.e. reconcile
 * rewrote the file. The expectation is zero drift in steady state;
 * non-zero drift indicates a missed chokidar event or a code path that
 * wrote a YAML without going through reconcile.
 *
 * Per-card failures are isolated — a malformed YAML or a thrown
 * reconcile body logs + skips so one bad file does not halt the audit
 * pass for the rest of the open dir.
 *
 * Best-effort: the audit pass is supplementary to the per-event
 * reconcile path. A run that aborts midway leaves the remaining cards
 * for the next tick (~60s).
 */

import { readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  reconcileIssue,
  type ReconcileRepoContext,
} from "../issue/reconcile.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import { createLogger } from "../logger.js";
import { isTrelloSyncOverrideDisabled } from "../settings-file.js";
import type { RepoContext } from "../types.js";

const log = createLogger("audit-pass");

export interface AuditPassResult {
  /** Total open YAMLs visited. */
  scanned: number;
  /** Cards whose audit reconcile reported `changed: true` — drift. */
  drifted: string[];
  /** Cards whose audit reconcile threw — logged + skipped. */
  errors: string[];
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and call
 * `reconcileIssue(id, "audit")` for each. Drift (`changed: true`) is
 * reported via `recordSystemError` so the dashboard's `audit-drift`
 * source surfaces a count to operators. The cron caller passes the
 * result through to its own log line so the per-tick scan summary
 * lands at info level.
 *
 * Returns a per-tick summary; the cron sweep emits a single log line
 * from the totals so the per-card detail stays at debug level (the
 * system-errors entries carry the per-id record).
 */
export async function runAuditPass(
  repo: RepoContext,
): Promise<AuditPassResult> {
  const reconcileRepo: ReconcileRepoContext = {
    name: repo.name,
    localPath: repo.localPath,
    issuePrefix: repo.issuePrefix,
  };
  const result: AuditPassResult = {
    scanned: 0,
    drifted: [],
    errors: [],
  };

  const openDir = join(repo.localPath, ".danxbot", "issues", "open");
  if (!existsSync(openDir)) return result;

  // Informational log only — DOES NOT short-circuit the audit pass.
  // `reconcileIssue` runs unconditionally for every card below; the
  // Trello push step inside reconcile (step 7) self-gates on the same
  // override flag (`src/issue/reconcile.ts:614`). Trello sync is a side
  // system; the issue-tracker convergence pass must NEVER gate on it.
  if (isTrelloSyncOverrideDisabled(repo.localPath)) {
    log.debug(
      `[${repo.name}] trelloSync override=false — reconcile will skip the Trello push step for each card (every other reconcile step runs as normal)`,
    );
  }

  let entries: string[];
  try {
    entries = readdirSync(openDir);
  } catch (err) {
    log.warn(
      `[${repo.name}] audit pass: readdir ${openDir} failed — skipping (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return result;
  }

  for (const filename of entries) {
    if (!filename.endsWith(".yml")) continue;
    const cardId = basename(filename, ".yml");
    result.scanned += 1;

    try {
      const reconcileResult = await reconcileIssue(
        reconcileRepo,
        cardId,
        "audit",
      );
      if (reconcileResult.changed) {
        result.drifted.push(cardId);
        recordSystemError({
          source: "audit-drift",
          severity: "warn",
          repo: repo.name,
          message: `Audit reconcile rewrote ${cardId} — drift detected (the chokidar event for the prior write was likely missed)`,
          details: {
            prevHash: reconcileResult.prevHash,
            nextHash: reconcileResult.nextHash,
            errors: reconcileResult.errors.map((e) => ({
              step: e.step,
              message: e.message,
              fatal: e.fatal,
            })),
          },
        });
      }
    } catch (err) {
      result.errors.push(cardId);
      log.warn(
        `[${repo.name}] audit pass: reconcile ${cardId} threw — skipping (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  return result;
}
