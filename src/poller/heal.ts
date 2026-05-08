/**
 * Per-tick self-heal pass for `<repo>/.danxbot/issues/{open,closed}/`.
 * Two complementary sweeps that together keep the on-disk state of every
 * card aligned with the file location convention (terminal → `closed/`,
 * non-terminal → `open/`):
 *
 *  1. **`open/` → `closed/`** (the "typical" heal, ISS-133): walks
 *     `<repo>/.danxbot/issues/open/`. Any YAML whose `status` is `Done`
 *     or `Cancelled` is moved to `closed/` via
 *     `moveToClosedIfTerminal`. The status field itself is unchanged —
 *     the move is a janitorial filesystem fix, NOT a state delta. No
 *     `history[]` entry is emitted (DX-147 AC #3: history reflects real
 *     status changes, not filesystem noise).
 *
 *  2. **`closed/` → `open/`** (the "inverse" heal, DX-147): walks
 *     `<repo>/.danxbot/issues/closed/`. Any YAML whose `status` is NOT
 *     `Done` / `Cancelled` is a real state delta — the operator (or a
 *     prior write that bypassed the lifecycle helpers) drifted a closed
 *     card back to a non-terminal status. The healer moves the file
 *     back to `open/` AND stamps a `worker:heal` `status_change` entry
 *     on the card's `history[]` so the audit log records the reverse
 *     transition. The `from` is taken via the filename-location
 *     heuristic — closed/ implies a prior terminal state; the most
 *     recent terminal in `history[]` (if any) wins, otherwise we
 *     default to `Done` (the more common terminal).
 *
 * Idempotent. Tracker-independent. Tolerates malformed YAMLs (returned
 * in `errors[]`; the pass continues).
 *
 * Pairs with:
 *
 *  - DX-145 — schema + `appendHistory` helper (`src/issue-tracker/yaml.ts`).
 *  - DX-146 — dispatch-driven save/create history.
 *  - DX-147 — this file's `worker:heal` actor + the `closed/`→`open/`
 *    inverse pass.
 *  - ISS-98 epic-status auto-derive — runs after this heal pass moves
 *    the last child to `closed/`; on the next tick the parent epic
 *    flips to Done automatically (and is itself healed on the tick
 *    after).
 *
 * Pure-local, no tracker imports — keeps the module testable with a
 * real tmpdir without paying the env-validation tax of `src/config.ts`.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  appendHistory,
  buildIssueIdRegex,

  IssueParseError,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import { ensureIssuesDirs, issuePath, moveToClosedIfTerminal } from "./yaml-lifecycle.js";

/**
 * One heal action recorded by `healLocalYamls`. The `direction` tag
 * disambiguates the typical `open/` → `closed/` move (terminal status
 * flushed to closed bucket) from the DX-147 inverse `closed/` → `open/`
 * move (status drifted back to non-terminal). Callers that log per-action
 * (e.g. the poller `_poll` block) can render direction-aware strings
 * without re-parsing the issue.
 */
export interface HealedIssue {
  id: string;
  status: IssueStatus;
  direction: "open-to-closed" | "closed-to-open";
}

export interface HealError {
  /** Absolute path of the YAML that failed to parse. */
  path: string;
  /** Error message from `parseIssue` (or any other read-time failure). */
  message: string;
}

export interface HealResult {
  /** YAMLs successfully moved on this pass — both directions. */
  healed: HealedIssue[];
  /** Files we couldn't read or parse. The pass continues past each. */
  errors: HealError[];
}

/**
 * Scan `<repo>/.danxbot/issues/{open,closed}/` for YAMLs whose file
 * location disagrees with the YAML's `status`. Move each to its correct
 * bucket. Returns the actions taken so the caller can log them at info
 * level (and Phase 4 can emit dashboard `system_errors` events from the
 * same data).
 *
 * Caller responsibility:
 *   - Logging: `result.healed` at info, `result.errors` at warn.
 *   - Dashboard surface (Phase 4): `recordSystemError` from
 *     `result.errors` with `{source: "healer", severity: "warn"}`.
 *
 * Idempotency: re-running on a clean dir returns
 * `{healed: [], errors: []}`. Filenames not matching the active prefix's
 * `<PREFIX>-N` regex are skipped (matches the `epic-status` walker —
 * keeps the helper from touching stray drafts whose filenames are
 * slug-shaped).
 */
export function healLocalYamls(
  repoLocalPath: string,
  prefix: string,
): HealResult {
  const result: HealResult = { healed: [], errors: [] };

  const idRegex = buildIssueIdRegex(prefix);

  // ----- sweep 1: open/ → closed/ (terminal status flushed to closed) -----
  const openDir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (existsSync(openDir)) {
    for (const entry of readdirSync(openDir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!idRegex.test(stem)) continue;
      const path = resolve(openDir, entry);

      let issue;
      try {
        issue = parseIssue(readFileSync(path, "utf-8"), {
          expectedPrefix: prefix,
        });
      } catch (err) {
        result.errors.push({ path, message: parseErrorMessage(err) });
        continue;
      }

      if (issue.status !== "Done" && issue.status !== "Cancelled") continue;
      const terminalStatus: "Done" | "Cancelled" = issue.status;

      // A terminal card has no live work — clear `dispatch` if it
      // lingered from a session that crashed before persisting. Mirrors
      // the `isDispatchSessionTerminal` clear inside `persistAfterSync`,
      // but scoped narrower: heal only fires for actual terminal status,
      // not for Needs Help / Needs Approval / blocked != null (those
      // stay in `open/` per spec).
      //
      // No `history[]` entry is emitted on this branch — the YAML's
      // status is already terminal and the file move is a janitorial
      // filesystem fix, not a state change. DX-147 AC #3 explicitly
      // calls for "no filesystem-noise entries".
      const persisted = issue.dispatch !== null ? { ...issue, dispatch: null } : issue;

      if (moveToClosedIfTerminal(repoLocalPath, persisted)) {
        result.healed.push({
          id: persisted.id,
          status: terminalStatus,
          direction: "open-to-closed",
        });
      }
    }
  }

  // ----- sweep 2: closed/ → open/ (drifted-back inverse heal, DX-147) -----
  const closedDir = resolve(repoLocalPath, ".danxbot", "issues", "closed");
  if (existsSync(closedDir)) {
    for (const entry of readdirSync(closedDir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!idRegex.test(stem)) continue;
      const path = resolve(closedDir, entry);

      let issue: Issue;
      try {
        issue = parseIssue(readFileSync(path, "utf-8"), {
          expectedPrefix: prefix,
        });
      } catch (err) {
        result.errors.push({ path, message: parseErrorMessage(err) });
        continue;
      }

      // Closed/ YAML whose status is still terminal — file is in the
      // right bucket. No-op (idempotency).
      if (issue.status === "Done" || issue.status === "Cancelled") continue;

      // Real state delta: the card was once terminal (it lived in
      // closed/) but now carries a non-terminal status. Move it back to
      // open/ AND stamp a `worker:heal` `status_change` entry. The
      // `from` field is REQUIRED on `status_change`; we pick the most
      // recent terminal status from `history[]` if available, otherwise
      // default to "Done" (the filename-location heuristic — closed/
      // implies a prior terminal save, and Done is the more common one).
      const priorTerminal = inferPriorTerminalStatus(issue.history);
      const updated: Issue = {
        ...issue,
        history: appendHistory(issue.history, {
          timestamp: new Date().toISOString(),
          actor: "worker:heal",
          event: "status_change",
          from: priorTerminal,
          to: issue.status,
          note: "Healer moved closed → open to match status",
        }),
      };

      ensureIssuesDirs(repoLocalPath);
      const openPath = issuePath(repoLocalPath, updated.id, "open");
      writeFileSync(openPath, serializeIssue(updated));
      // Remove the closed copy AFTER the open write succeeds so a write
      // failure leaves the YAML recoverable from closed/ (consistent with
      // `moveToClosedIfTerminal`'s ordering).
      unlinkSync(path);
      result.healed.push({
        id: updated.id,
        status: updated.status,
        direction: "closed-to-open",
      });
    }
  }

  return result;
}

function parseErrorMessage(err: unknown): string {
  if (err instanceof IssueParseError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Filename-location heuristic for the `from` field of the `closed/` →
 * `open/` inverse-heal `status_change` entry. The card lived in `closed/`
 * before this drift, which means it was once Done or Cancelled.
 *
 *  1. **Primary** — most recent `status_change` entry in `history[]`
 *     whose `to` is terminal. This is the accurate path for any card
 *     written after DX-146 / DX-147 instrumented the worker save and
 *     hydrate paths; every realistic post-Phase-2 card has at least
 *     one such entry by the time it reaches `closed/`.
 *  2. **Legacy fallback** — `"Done"`. Fires only for pre-Phase-2 YAMLs
 *     (or hand-written test fixtures with empty history). Picked
 *     because Done is the more common terminal across the codebase;
 *     the alternative would be to fail the heal entirely, which is
 *     worse — losing audit fidelity is preferable to leaving a card
 *     stuck in `closed/`.
 *
 * Either way the function returns a definite `IssueStatus`, satisfying
 * `appendHistory`'s `status_change requires from` invariant.
 */
function inferPriorTerminalStatus(history: Issue["history"]): IssueStatus {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.event !== "status_change") continue;
    if (entry.to === "Done" || entry.to === "Cancelled") return entry.to;
  }
  return "Done";
}
