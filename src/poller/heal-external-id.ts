/**
 * Per-tick `external_id` format heal pass for `<repo>/.danxbot/issues/`.
 *
 * Walks every `<PREFIX>-N.yml` in BOTH `open/` and `closed/`. Any YAML whose
 * `external_id` is a non-empty string the active tracker does not recognize
 * (`tracker.isValidExternalId(externalId) === false`) is healed by:
 *
 *   1. Blanking the `external_id` field in place.
 *   2. Appending a `comments[]` entry titled `## Tracker swap — external_id healed`
 *      that records the old id verbatim and explains why it was cleared.
 *      The comment has no `id` (worker assigns on the next push), no
 *      remote-side counterpart yet, and `author: "danxbot"`.
 *   3. Persisting the YAML back to its same directory (open/ or closed/).
 *
 * The blanked YAML now looks like an orphan to `pushOrphans`, which
 * runs LATER IN THE SAME `runSync` tick (`healExternalIds` is wired
 * before `tracker.fetchOpenCards`; `pushOrphans` runs after the
 * inbound mirror). `tracker.createCard` mints a fresh tracker-native
 * id within the same tick — recovery is single-tick for `open/` YAMLs.
 * `closed/` YAMLs are healed but NOT re-pushed (existing `pushOrphans`
 * contract; see its docstring) — the bad data is removed from disk but
 * the closed card stays orphaned, which is harmless: a Done card has
 * no live work, and the alternative (resurrecting it as a fresh
 * tracker card with empty history) was rejected by the same epic.
 *
 * Idempotent: a YAML whose `external_id` is already valid OR already
 * empty is a no-op. Pass runs every tick — cost is one regex check per
 * YAML, no tracker call.
 *
 * Why this exists (DX-150 / Trello-decouple Phase 9):
 *
 * Older test stubs minted `mem-${nextExternalId++}` for every card
 * created during a no-Trello window (e.g. a fresh repo before the
 * operator wires up Trello). When the operator later switches the
 * repo's tracker to Trello (config edit), those `mem-N` ids become
 * permanently invalid against the new tracker — every Trello call
 * against them returns 400. DX-149 (Phase 8) prevented those 400s from
 * crashing the worker; this phase prevents the 400s from happening at
 * all by removing the foreign-tracker ids from disk.
 *
 * Tracker-method (vs static regex map): the tracker already abstracts the
 * "what's my id format" concept. A static `EXTERNAL_ID_PATTERNS` map
 * duplicates that knowledge in two places and rots when a new tracker
 * lands. Tracker owns its id format → tracker validates.
 *
 * Scope:
 *  - In: format-heal of `external_id`. Pure-local audit comment append.
 *  - Out: pruning closed/ YAMLs that no longer reference any real card,
 *    cross-tracker migration of card history, proactive tracker-swap
 *    detection (config-watch). All tracked separately if/when needed.
 *
 * Pure-local, no env-var reads — keeps the module testable with a real
 * tmpdir without paying the env-validation tax of `src/config.ts`.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildIssueIdRegex,

  IssueParseError,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";

/**
 * Header line for the audit comment appended to a healed YAML. Exported
 * so callers (and tests) match against this string verbatim instead of
 * grepping for substrings — keeps the comment shape part of the
 * load-bearing contract.
 */
export const HEAL_COMMENT_HEADER = "## Tracker swap — external_id healed";

export interface HealedExternalId {
  /** Internal `<PREFIX>-N` id of the healed issue. */
  id: string;
  /** The foreign-tracker id that was blanked. Surfaced for caller logging. */
  oldExternalId: string;
}

export interface HealExternalIdError {
  /** Absolute path of the YAML that failed to parse (or write). */
  path: string;
  /** Error message from `parseIssue` (or any other read/write failure). */
  message: string;
}

export interface HealExternalIdResult {
  /** YAMLs whose `external_id` was blanked on this pass. */
  healed: HealedExternalId[];
  /** Files we couldn't read, parse, or write. The pass continues past each. */
  errors: HealExternalIdError[];
}

/**
 * Scan `<repo>/.danxbot/issues/{open,closed}/` for YAMLs carrying an
 * `external_id` the active tracker does not recognize, and heal each
 * by blanking the field + appending an audit comment + persisting the
 * YAML in place. Returns the actions taken so the caller can log them
 * (info per heal, warn per error — mirrors `healLocalYamls`).
 *
 * Caller responsibility:
 *   - Logging: `result.healed` at info, `result.errors` at warn.
 *
 * Idempotency: a tick following a successful heal returns
 * `{healed: [], errors: []}` (the blanked field is now empty, which the
 * pass skips). A tick where every YAML's `external_id` is already valid
 * OR empty is similarly a no-op.
 *
 * `now` is injected so tests can pin the audit-comment timestamp; defaults
 * to wall-clock UTC ISO 8601.
 */
export function healExternalIds(
  repoLocalPath: string,
  tracker: IssueTracker,
  prefix: string,
  now: () => string = () => new Date().toISOString(),
): HealExternalIdResult {
  const result: HealExternalIdResult = { healed: [], errors: [] };
  const idRegex = buildIssueIdRegex(prefix);

  for (const state of ["open", "closed"] as const) {
    const dir = resolve(repoLocalPath, ".danxbot", "issues", state);
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      // Filenames not matching the active prefix's `<PREFIX>-N` regex are
      // skipped — keeps the helper from touching stray drafts whose
      // filenames are slug-shaped (matches the `healLocalYamls` walker).
      if (!idRegex.test(stem)) continue;
      const path = resolve(dir, entry);

      let issue: Issue;
      try {
        issue = parseIssue(readFileSync(path, "utf-8"), {
          expectedPrefix: prefix,
        });
      } catch (err) {
        result.errors.push({
          path,
          message:
            err instanceof IssueParseError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err),
        });
        continue;
      }

      // Orphan: `pushOrphans` already handles the empty-external_id case.
      // Skip BEFORE consulting the tracker so a future tracker that
      // throws on empty input can't break the pass.
      if (issue.external_id === "") continue;
      if (tracker.isValidExternalId(issue.external_id)) continue;

      const oldExternalId = issue.external_id;
      const healed: Issue = {
        ...issue,
        external_id: "",
        comments: [
          ...issue.comments,
          {
            author: "danxbot",
            timestamp: now(),
            text: buildHealCommentBody(oldExternalId),
          },
        ],
      };

      try {
        writeFileSync(path, serializeIssue(healed));
      } catch (err) {
        result.errors.push({
          path,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      result.healed.push({ id: issue.id, oldExternalId });
    }
  }

  return result;
}

function buildHealCommentBody(oldExternalId: string): string {
  // Inline backticks around the old id so the dashboard's MarkdownEditor
  // renders it monospace; readers correlating an audit log entry to a
  // worker log line ("Healed external_id mismatch on DX-N: <old>") want
  // the byte-for-byte string, not the prose-ified version.
  return [
    HEAL_COMMENT_HEADER,
    "",
    `The previous \`external_id\` (\`${oldExternalId}\`) was minted by a different tracker and the active tracker does not recognize that format. The id has been cleared so the next sync pass can mint a fresh tracker-native id.`,
  ].join("\n");
}
