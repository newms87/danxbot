/**
 * Per-card triage `setTimeout` — Phase 4b.2 of the Event-Driven Worker
 * epic (DX-289). Replaces the per-tick triage walk
 * (`tryTriageDispatch` over `listTriageDueYamls` in `src/cron/sync-and-audit.ts`)
 * with an event-driven timer per card.
 *
 * Contract:
 *   - `armTriageTimer(repoName, cardId, expiresAtMs, deps)` — clear any
 *     existing timer for the (repo, card), schedule a fresh
 *     `setTimeout(handleExpiry, expiresAt - now)`. When `expiresAt` is
 *     in the past (or zero), the timer fires on the next macrotask.
 *   - `clearTriageTimer(repoName, cardId)` — explicit clear; called from
 *     reconcile when the card moves to a terminal status or the file is
 *     deleted.
 *   - `scanAndArmTriageTimers(repo)` — boot-scan rehydrate. Walks every
 *     open YAML and arms a timer for each card whose `triage.expires_at`
 *     is parseable (future = future fire; past or empty = immediate
 *     fire so reconcile re-decides triage eligibility).
 *   - `_clearAllTriageTimers()` — test seam; drains the module map
 *     between cases.
 *
 * On expiry, the timer invokes `reconcileIssue(repo, id, "audit")`. The
 * reconcile body re-derives state and (when dispatch-eligibility flipped)
 * pokes the scheduler via the Phase 4b.1 (`onReconcileResult`) hook.
 * This module never reads triage rules itself — the source of truth
 * stays in `reconcile` + the picker; the timer is purely the wakeup.
 *
 * Module-scoped Map<`${repoName}-${cardId}`, NodeJS.Timeout>. Tests use
 * `vi.useFakeTimers()` + `vi.advanceTimersByTime()` to drive expiry.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { issuePath } from "../issue-tracker/paths.js";
import { parseIssue, IssueParseError } from "../issue-tracker/yaml.js";
import { createLogger } from "../logger.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";

const log = createLogger("triage-timer");

/**
 * Reconcile dependency injected at arm time. Production wires
 * `reconcileIssue` from `src/issue/reconcile.ts`; tests pass a spy. The
 * arg shape matches `reconcileIssue` exactly so callers can pass the
 * function by reference.
 */
export type ReconcileFn = (
  repo: ReconcileRepoContext,
  id: string,
  trigger: "audit",
) => Promise<ReconcileResult>;

interface ArmedEntry {
  timer: NodeJS.Timeout;
  expiresAtMs: number;
}

const armed = new Map<string, ArmedEntry>();

function timerKey(repoName: string, cardId: string): string {
  return `${repoName}-${cardId}`;
}

/**
 * Arm (or re-arm) a triage timer for a single card. Clears any existing
 * timer for the same (repo, card) before scheduling the fresh one — so
 * the most recent `triage.expires_at` observation always wins.
 *
 * `expiresAtMs` may be in the past or 0; we clamp the delay to 0 so the
 * timer fires on the next macrotask. Past-due cards are the common
 * boot-scan path: the worker missed the wakeup while it was down, and
 * the immediate fire lets reconcile catch up.
 */
export function armTriageTimer(args: {
  repo: ReconcileRepoContext;
  cardId: string;
  expiresAtMs: number;
  reconcile: ReconcileFn;
}): void {
  const { repo, cardId, expiresAtMs, reconcile } = args;
  const key = timerKey(repo.name, cardId);
  const prior = armed.get(key);
  if (prior) {
    clearTimeout(prior.timer);
  }
  const delayMs = Math.max(0, expiresAtMs - Date.now());
  const timer = setTimeout(() => {
    armed.delete(key);
    // Fire reconcile in audit mode. The promise is intentionally
    // unawaited — the timer fires from the event loop, not a caller
    // we can return errors to. A rejection lands here and is logged.
    reconcile(repo, cardId, "audit").catch((err) => {
      log.warn(
        `[${repo.name}] ${cardId} triage-timer reconcile rejected: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }, delayMs);
  armed.set(key, { timer, expiresAtMs });
}

/**
 * Clear a triage timer. Idempotent — silent no-op when no timer is
 * armed for the key. Called from reconcile when:
 *   - The card's file is deleted (tombstone).
 *   - The card moves to a terminal status (Done / Cancelled) — the
 *     reconcile-driven `closed/` move makes the prior open-YAML path
 *     stale; if a triage timer was armed against that file the fire
 *     would re-trigger a moot audit reconcile.
 */
export function clearTriageTimer(repoName: string, cardId: string): void {
  const key = timerKey(repoName, cardId);
  const prior = armed.get(key);
  if (prior) {
    clearTimeout(prior.timer);
    armed.delete(key);
  }
}

/**
 * Visible for tests + diagnostics. The internal map is a private
 * implementation detail; consumers should not depend on its shape, but
 * tests need to assert "timer was armed" / "timer was cleared" without
 * tripping the real setTimeout.
 */
export function _isTriageTimerArmed(
  repoName: string,
  cardId: string,
): boolean {
  return armed.has(timerKey(repoName, cardId));
}

/**
 * Visible for tests — read the cached expiresAtMs for an armed entry
 * to assert re-arm produced the expected target time.
 */
export function _getTriageTimerExpiresAt(
  repoName: string,
  cardId: string,
): number | undefined {
  return armed.get(timerKey(repoName, cardId))?.expiresAtMs;
}

/**
 * Test seam — drain every armed timer. Required between vitest cases
 * because the module map is process-scoped.
 */
export function _clearAllTriageTimers(): void {
  for (const entry of armed.values()) {
    clearTimeout(entry.timer);
  }
  armed.clear();
}

/**
 * Translate a YAML `triage.expires_at` string into the absolute ms
 * timestamp the timer module wants. The two callers (boot-scan +
 * reconcile step 7b) shared this logic verbatim before extraction.
 *
 *  - Empty string (never-triaged) → 0 (immediate fire).
 *  - Unparseable string → 0 (immediate fire; matches the legacy
 *    `listTriageDueYamls` fail-open semantic — a fresh stamp from the
 *    audit reconcile overwrites the bad value).
 *  - Parseable ISO timestamp → its `Date.parse` value (may be past,
 *    in which case the arm-time clamp fires immediately).
 */
export function parseTriageExpiresAtMs(raw: string): number {
  if (raw === "") return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Boot-scan rehydrate. Walks `<repo>/.danxbot/issues/open/*.yml` and
 * arms a triage timer for every card whose `triage.expires_at` parses
 * as a valid timestamp. Cards with an empty `triage.expires_at` ARE
 * armed (immediate fire) so reconcile can stamp a fresh value on a
 * never-triaged card without waiting for the next chokidar edit.
 *
 * Best-effort: a single malformed YAML logs a warning and the scan
 * continues. Boot must never fail because of one bad file.
 */
export function scanAndArmTriageTimers(args: {
  repo: ReconcileRepoContext;
  reconcile: ReconcileFn;
}): void {
  const { repo, reconcile } = args;
  const openDir = join(repo.localPath, ".danxbot", "issues", "open");
  if (!existsSync(openDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(openDir);
  } catch (err) {
    log.warn(
      `[${repo.name}] triage-timer boot-scan: failed to read ${openDir} — skipping (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return;
  }

  for (const filename of entries) {
    if (!filename.endsWith(".yml")) continue;
    const cardId = basename(filename, ".yml");
    const path = issuePath(repo.localPath, cardId, "open");
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      log.warn(
        `[${repo.name}] ${cardId} triage-timer boot-scan: read failed (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      continue;
    }

    let expiresAtMs: number;
    try {
      const issue = parseIssue(text, { expectedPrefix: repo.issuePrefix });
      expiresAtMs = parseTriageExpiresAtMs(issue.triage.expires_at);
    } catch (err) {
      if (err instanceof IssueParseError) {
        log.warn(
          `[${repo.name}] ${cardId} triage-timer boot-scan: parse failed — skipping`,
        );
      } else {
        log.warn(
          `[${repo.name}] ${cardId} triage-timer boot-scan: unexpected error — skipping (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
      continue;
    }

    armTriageTimer({ repo, cardId, expiresAtMs, reconcile });
  }
}
