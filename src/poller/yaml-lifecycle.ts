/**
 * Pure helpers for the per-issue YAML lifecycle on disk. Phase 2 of the
 * tracker-agnostic-agents epic (Trello ZDb7FOGO + parent k8kZjI5c).
 *
 * Everything here is fs-only + tracker-only — no `config.js` import, no
 * logger, no env-var reads. Test files can import this module without
 * paying the env-validation tax that pulling `src/poller/index.ts` does
 * (see `.claude/rules/danx-repo-workflow.md` "Isolate Pure Helpers").
 *
 * Filesystem layout:
 *
 *   <repo>/.danxbot/issues/
 *     open/<id>.yml      active issues   (filename = internal id, e.g. ISS-138.yml)
 *     closed/<id>.yml    issues whose status is Done or Cancelled
 *
 * `dispatch` overwrites every dispatch — it is the resume key, not a
 * history. The poller pre-generates the dispatch UUID, threads it
 * through `DispatchInput.dispatchId` to `dispatch()`, and stamps the
 * SAME UUID into the YAML file via `stampDispatchAndWrite` (existing
 * local file) or `hydrateFromRemote` + `writeIssue` (brand-new card on
 * remote, no local file yet).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import {
  createEmptyIssue,
  DEFAULT_ISSUE_PREFIX,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../issue-tracker/yaml.js";
import { nextIssueId } from "../issue-tracker/id-generator.js";
import type {
  Issue,
  IssueDispatch,
  IssueTracker,
} from "../issue-tracker/interface.js";

// DX-132: pure path helpers moved to `src/issue-tracker/paths.ts` so
// tracker-layer modules can import them without an upward dependency
// into the poller. Re-exported here so every existing caller keeps
// working unchanged.
export { type IssueState, issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";

/**
 * Read + parse + validate the YAML for an issue by its internal `id`.
 * Looks in `open/` first, then `closed/`. Returns null when neither file
 * exists. Throws `IssueParseError` on malformed YAML or schema-validation
 * failure — the validator is strict and that's a load-bearing invariant.
 */
export function loadLocal(
  repoLocalPath: string,
  id: string,
  prefix: string = DEFAULT_ISSUE_PREFIX,
): Issue | null {
  for (const state of ["open", "closed"] as const) {
    const path = issuePath(repoLocalPath, id, state);
    if (!existsSync(path)) continue;
    return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: prefix });
  }
  return null;
}

/**
 * Locate the local YAML for an issue keyed by its tracker-native
 * `external_id`. Scans every `ISS-N.yml` in `open/` and `closed/`,
 * parses, and returns the first match. Returns null when no file
 * carries the given `external_id`.
 *
 * The lookup is O(N) in the issue count — acceptable because the
 * poller calls it once per tick and N is per-repo (small). If this
 * grows hot, swap to an in-memory `external_id → id` index built from
 * `readdirSync` filenames + a single parse pass.
 */
export function findByExternalId(
  repoLocalPath: string,
  externalId: string,
): Issue | null {
  if (!externalId) return null;
  // Prefix-agnostic by contract — `external_id` is the unique key across
  // the tracker, so filtering by a single prefix returns false-negatives
  // during prefix-migration windows (a cached `prefix=ISS` worker that
  // ran bulk-sync after every YAML had been renamed to `DX-*` matched
  // zero files → re-hydrated every card as a dup ISS-*.yml). Stems must
  // match `<2-4 caps>-<digits>`; a stem-shape miss is a real disk
  // anomaly (rogue file in the issues dir) and throws.
  const stemShape = /^([A-Z]{2,4})-\d+$/;
  for (const state of ["open", "closed"] as const) {
    const dir = resolve(repoLocalPath, ".danxbot", "issues", state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      const match = stemShape.exec(stem);
      if (!match) {
        throw new Error(
          `findByExternalId: rogue filename in ${dir}: "${entry}" — stem must match ${stemShape}. Remove or rename before retrying.`,
        );
      }
      const path = resolve(dir, entry);
      // parseIssue throws on schema / id-shape / prefix mismatch — let
      // it propagate. A corrupt YAML in the issues tree is operator-fix
      // territory, never silent-skip territory.
      const issue = parseIssue(readFileSync(path, "utf-8"), {
        expectedPrefix: match[1]!,
      });
      if (issue.external_id === externalId) return issue;
    }
  }
  return null;
}

/**
 * Write the issue to `<repo>/.danxbot/issues/open/<id>.yml`. Always writes
 * to `open/` — the move to `closed/` happens via `danx_issue_save` when
 * status reaches Done or Cancelled.
 */
export function writeIssue(repoLocalPath: string, issue: Issue): void {
  ensureIssuesDirs(repoLocalPath);
  const path = issuePath(repoLocalPath, issue.id, "open");
  writeFileSync(path, serializeIssue(issue));
}

/**
 * Brand-new card on the remote → one-time full hydration. Calls the
 * tracker for card metadata + comments, builds a complete Issue stamped
 * with the supplied `dispatchId`, and validates strictly. Does NOT write
 * to disk — caller is responsible for `writeIssue` (this keeps the
 * helper testable without a tmpdir).
 *
 * Internal id resolution:
 *  - If the remote card's title carries the `#ISS-N: ` prefix, the
 *    parsed id (surfaced via `tracker.getCard`'s `Issue.id`) is the
 *    internal id. No allocation, no remote write.
 *  - Otherwise we allocate the next `ISS-N` from disk, patch the
 *    tracker's title to add the prefix (so future polls see it), and
 *    use that id locally. This is the migration entry point for cards
 *    created by humans without going through `danx_issue_create`.
 *
 * `dispatchId` may be `null` for bulk-sync writes (the poller pre-
 * hydrates every ToDo card on each tick so siblings of the dispatch
 * primary have local YAMLs the moment the poller sees them — see
 * `pollAndProcess`'s bulk-sync block). Cards hydrated via bulk-sync
 * carry `dispatch: null` until they're picked as the dispatch primary,
 * at which point `stampDispatchAndWrite` overwrites it with the real
 * dispatch record.
 *
 * The validator is strict — every required field MUST be filled before
 * `validateIssue` runs, so we route through `createEmptyIssue` to
 * guarantee defaults for any field the tracker doesn't supply.
 */
export async function hydrateFromRemote(
  tracker: IssueTracker,
  externalId: string,
  dispatchId: string | null,
  repoLocalPath: string,
  prefix: string = DEFAULT_ISSUE_PREFIX,
): Promise<Issue> {
  const remote = await tracker.getCard(externalId);
  const remoteComments = await tracker.getComments(externalId);

  let id = remote.id;
  if (!id) {
    id = await nextIssueId(
      resolve(repoLocalPath, ".danxbot", "issues"),
      prefix,
    );
    // Patch the remote title so the `#<id>: ` prefix is visible on the
    // tracker UI and subsequent polls find the id without re-allocating.
    await tracker.updateCard(externalId, {
      title: remote.title,
      id,
    });
  }

  const seed = createEmptyIssue({
    id,
    external_id: externalId,
    status: remote.status,
    type: remote.type,
    title: remote.title,
    description: remote.description,
  });
  const candidate: Issue = {
    ...seed,
    tracker: remote.tracker,
    parent_id: remote.parent_id,
    dispatch:
      dispatchId === null
        ? null
        : {
            id: dispatchId,
            pid: 0,
            host: "",
            kind: "work",
            started_at: "",
            ttl_seconds: 0,
          },
    triage: remote.triage,
    ac: remote.ac,
    comments: remoteComments.map((c) => ({
      id: c.id,
      author: c.author,
      timestamp: c.timestamp,
      text: c.text,
    })),
    retro: remote.retro,
  };

  const validated = validateIssue(candidate, { expectedPrefix: prefix });
  if (!validated.ok) {
    throw new Error(
      `hydrateFromRemote: validation failed for ${externalId}:\n  - ${validated.errors.join("\n  - ")}`,
    );
  }
  return validated.issue;
}

/**
 * Overwrite `dispatch` on an existing local Issue and persist the
 * change. Returns the updated Issue. Used on the existing-file path
 * where the local YAML is authoritative for everything except the
 * dispatch record (which the poller refreshes for every new dispatch).
 *
 * Two call shapes:
 *
 *   - `string` — the legacy "id only" form. Stamps a placeholder
 *     record with `pid: 0`, `host: ""`, `kind: "work"`, empty
 *     `started_at`, `ttl_seconds: 0`. The placeholder is what the
 *     pre-spawn write produces — the poller then enriches it
 *     post-spawn via the full-record form below.
 *   - `IssueDispatch` — the Phase 2 enriched form. Caller has captured
 *     real PID + host + kind + started_at + ttl_seconds (typically
 *     after `dispatch()` returns). Writes verbatim.
 *
 * Both forms persist via `writeIssue`. Validation lives in
 * `validateIssue` — `IssueDispatch.id` must be non-empty, the
 * placeholder shape passes the strict validator because Phase 1
 * deliberately allows `pid: 0` / `host: ""` / `started_at: ""` /
 * `ttl_seconds: 0` for in-flight migrations.
 */
export function stampDispatchAndWrite(
  repoLocalPath: string,
  issue: Issue,
  dispatchOrId: string | IssueDispatch,
): Issue {
  const dispatch: IssueDispatch =
    typeof dispatchOrId === "string"
      ? {
          id: dispatchOrId,
          pid: 0,
          host: "",
          kind: "work",
          started_at: "",
          ttl_seconds: 0,
        }
      : { ...dispatchOrId };
  const updated: Issue = { ...issue, dispatch };
  writeIssue(repoLocalPath, updated);
  return updated;
}

/**
 * Clear `dispatch` on an existing local Issue and persist the change.
 * Returns the updated Issue. Used on the dispatch-end path:
 *
 *   - Worker `persistAfterSync` clears whenever the saved status is
 *     terminal-for-session (Done / Cancelled / Needs Help / Needs
 *     Approval) or when `blocked != null`. The agent's session is
 *     done with this card; leaving the stale `dispatch` block on
 *     disk would falsely trip the next poller startup's reattach
 *     into "live" status.
 *   - Poller `onComplete` clears whenever the agent terminates without
 *     reaching a terminal save (timeout, stall, kill, crash). The
 *     YAML's `status` may still be `In Progress` — that's fine; the
 *     orphan-resume path keys off `dispatch.id` for resume detection,
 *     and clearing forces the regular ToDo dispatch path on the next
 *     tick.
 *
 * No-op when `issue.dispatch` is already null (returns the input
 * unchanged AND skips the write).
 */
export function clearDispatchAndWrite(
  repoLocalPath: string,
  issue: Issue,
): Issue {
  if (issue.dispatch === null) return issue;
  const updated: Issue = { ...issue, dispatch: null };
  writeIssue(repoLocalPath, updated);
  return updated;
}

/**
 * Persist a terminal-status issue to `closed/<id>.yml` and remove
 * `open/<id>.yml`. Returns `true` when the move ran, `false` when the
 * status is non-terminal (caller should write to `open/` itself).
 *
 * "Open wins" contract: when both `open/<id>.yml` and `closed/<id>.yml`
 * exist (e.g. operator manually re-opened a Done card by editing the
 * YAML in `open/` directly), the open copy overwrites the closed copy
 * on the next terminal save. Same semantics as the inlined block in
 * `persistAfterSync` before ISS-133 extracted it.
 *
 * Used by:
 *   - `persistAfterSync` (worker, terminal-status save path)
 *   - `healLocalYamls` (poller, per-tick self-heal pass — ISS-133)
 *
 * Caller is responsible for any pre-write mutation (e.g. clearing
 * `dispatch: null` on terminal-for-session saves) — this helper
 * persists the issue verbatim. Validation lives upstream in
 * `parseIssue` / `validateIssue`; if a caller hands in a malformed
 * Issue, `serializeIssue` throws.
 */
export function moveToClosedIfTerminal(
  repoLocalPath: string,
  issue: Issue,
): boolean {
  if (issue.status !== "Done" && issue.status !== "Cancelled") return false;
  ensureIssuesDirs(repoLocalPath);
  const openPath = issuePath(repoLocalPath, issue.id, "open");
  const closedPath = issuePath(repoLocalPath, issue.id, "closed");
  writeFileSync(closedPath, serializeIssue(issue));
  if (existsSync(openPath)) unlinkSync(openPath);
  return true;
}

/**
 * Idempotently ensure a single line is present in
 * `<repo>/.danxbot/.gitignore`. Match is by exact line equality (newline-
 * bounded), so `issues/` does NOT match `old-issues/`. Creates the file
 * with just the line if missing; appends the line if absent; no-op if
 * already present.
 *
 * The setup skill (`.claude/skills/setup/SKILL.md` §8f) writes the full
 * gitignore once at install time. This helper exists so connected repos
 * that pre-date the `issues/` line pick it up on the next poll tick
 * without a re-install.
 */
export function ensureGitignoreEntry(
  repoLocalPath: string,
  line: string,
): void {
  const path = resolve(repoLocalPath, ".danxbot", ".gitignore");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${line}\n`);
    return;
  }
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  if (lines.includes(line)) return;
  // Preserve trailing newline if present, append the new line, then a
  // trailing newline. Avoids a malformed file when the existing content
  // ended without one.
  const sep = content.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${content}${sep}${line}\n`);
}
