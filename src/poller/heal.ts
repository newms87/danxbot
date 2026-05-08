/**
 * Per-tick self-heal pass for `<repo>/.danxbot/issues/open/`. Walks every
 * `ISS-N.yml` in the dir; any whose `status` is `Done` or `Cancelled` is
 * moved to `closed/` via `moveToClosedIfTerminal`. Idempotent. Tracker-
 * independent. Tolerates malformed YAMLs (returned in `errors[]`; the
 * pass continues).
 *
 * ISS-133 (Phase 3 of the Trello-decouple epic ISS-130). Pairs with:
 *
 *  - Phase 1 / ISS-131 — `runSync` ordering: when the worker's tracker
 *    push throws, `persistAfterSync` is skipped and a YAML stamped with
 *    `status: "Done"` lingers in `open/`. Phase 1 (when shipped) makes
 *    that local-write happen first, but doesn't retroactively heal
 *    cards already stuck. This pass DOES — runs at the TOP of every
 *    `_poll`, before tracker fetches, before dispatch decisions, so a
 *    box that already has a stuck card auto-recovers without a human
 *    `mv`.
 *  - ISS-98 epic-status auto-derive — runs after this heal pass moves
 *    the last child to `closed/`; on the next tick the parent epic
 *    flips to Done automatically (and is itself healed on the tick
 *    after).
 *
 * Pure-local, no tracker imports — keeps the module testable with a
 * real tmpdir without paying the env-validation tax of `src/config.ts`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildIssueIdRegex,
  DEFAULT_ISSUE_PREFIX,
  IssueParseError,
  parseIssue,
} from "../issue-tracker/yaml.js";
import { moveToClosedIfTerminal } from "./yaml-lifecycle.js";

export interface HealedIssue {
  id: string;
  status: "Done" | "Cancelled";
}

export interface HealError {
  /** Absolute path of the YAML that failed to parse. */
  path: string;
  /** Error message from `parseIssue` (or any other read-time failure). */
  message: string;
}

export interface HealResult {
  /** YAMLs successfully moved open/ → closed/ on this pass. */
  healed: HealedIssue[];
  /** Files we couldn't read or parse. The pass continues past each. */
  errors: HealError[];
}

/**
 * Scan `<repo>/.danxbot/issues/open/` for terminal-status YAMLs and
 * move each to `closed/`. Returns the actions taken so the caller can
 * log them at info level (and Phase 4 can emit dashboard
 * `system_errors` events from the same data).
 *
 * Caller responsibility:
 *   - Logging: `result.healed` at info, `result.errors` at warn.
 *   - Dashboard surface (Phase 4): `recordSystemError` from
 *     `result.errors` with `{source: "healer", severity: "warn"}`.
 *
 * Idempotency: re-running on a clean dir returns `{healed: [], errors: []}`.
 * Filenames not matching the active prefix's `ISS-N` regex are skipped
 * (matches the `epic-status` walker — keeps the helper from touching
 * stray drafts whose filenames are slug-shaped).
 */
export function healLocalYamls(
  repoLocalPath: string,
  prefix: string = DEFAULT_ISSUE_PREFIX,
): HealResult {
  const dir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(dir)) return { healed: [], errors: [] };

  const idRegex = buildIssueIdRegex(prefix);
  const result: HealResult = { healed: [], errors: [] };

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!idRegex.test(stem)) continue;
    const path = resolve(dir, entry);

    let issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"), {
        expectedPrefix: prefix,
      });
    } catch (err) {
      const message =
        err instanceof IssueParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push({ path, message });
      continue;
    }

    if (issue.status !== "Done" && issue.status !== "Cancelled") continue;
    // Capture the narrowed terminal status here — TS does not propagate
    // the narrowing across the `{ ...issue, dispatch: null }` spread
    // below, but the field's value is identical, so we hand the result
    // entry the original `issue.status` (typed) instead of
    // `persisted.status` (re-widened to IssueStatus).
    const terminalStatus: "Done" | "Cancelled" = issue.status;

    // A terminal card has no live work — clear `dispatch` if it
    // lingered from a session that crashed before persisting. Mirrors
    // the `isDispatchSessionTerminal` clear inside `persistAfterSync`,
    // but scoped narrower: heal only fires for actual terminal status,
    // not for Needs Help / Needs Approval / blocked != null (those
    // stay in `open/` per spec).
    const persisted = issue.dispatch !== null ? { ...issue, dispatch: null } : issue;

    if (moveToClosedIfTerminal(repoLocalPath, persisted)) {
      result.healed.push({ id: persisted.id, status: terminalStatus });
    }
  }

  return result;
}
