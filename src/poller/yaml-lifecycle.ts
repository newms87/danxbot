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
 * `dispatch_id` overwrites every dispatch — it is the resume key, not a
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
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import {
  createEmptyIssue,
  ISSUE_ID_REGEX,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../issue-tracker/yaml.js";
import { nextIssueId } from "../issue-tracker/id-generator.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";

export type IssueState = "open" | "closed";

/**
 * Absolute path to the YAML file for an issue in a given lifecycle state.
 * Filename basename is the internal `id` (`ISS-N`), not the external_id.
 */
export function issuePath(
  repoLocalPath: string,
  id: string,
  state: IssueState,
): string {
  return resolve(
    repoLocalPath,
    ".danxbot",
    "issues",
    state,
    `${id}.yml`,
  );
}

/**
 * Create the `<repo>/.danxbot/issues/{open,closed}/` dirs if missing.
 * Idempotent — silent no-op when both already exist.
 */
export function ensureIssuesDirs(repoLocalPath: string): void {
  mkdirSync(resolve(repoLocalPath, ".danxbot", "issues", "open"), {
    recursive: true,
  });
  mkdirSync(resolve(repoLocalPath, ".danxbot", "issues", "closed"), {
    recursive: true,
  });
}

/**
 * Read + parse + validate the YAML for an issue by its internal `id`.
 * Looks in `open/` first, then `closed/`. Returns null when neither file
 * exists. Throws `IssueParseError` on malformed YAML or schema-validation
 * failure — the validator is strict and that's a load-bearing invariant.
 */
export function loadLocal(
  repoLocalPath: string,
  id: string,
): Issue | null {
  for (const state of ["open", "closed"] as const) {
    const path = issuePath(repoLocalPath, id, state);
    if (!existsSync(path)) continue;
    return parseIssue(readFileSync(path, "utf-8"));
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
  for (const state of ["open", "closed"] as const) {
    const dir = resolve(repoLocalPath, ".danxbot", "issues", state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!ISSUE_ID_REGEX.test(stem)) continue;
      const path = resolve(dir, entry);
      const issue = parseIssue(readFileSync(path, "utf-8"));
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
 * The validator is strict — every required field MUST be filled before
 * `validateIssue` runs, so we route through `createEmptyIssue` to
 * guarantee defaults for any field the tracker doesn't supply.
 */
export async function hydrateFromRemote(
  tracker: IssueTracker,
  externalId: string,
  dispatchId: string,
  repoLocalPath: string,
): Promise<Issue> {
  const remote = await tracker.getCard(externalId);
  const remoteComments = await tracker.getComments(externalId);

  let id = remote.id;
  if (!id) {
    id = await nextIssueId(resolve(repoLocalPath, ".danxbot", "issues"));
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
    dispatch_id: dispatchId,
    triaged: remote.triaged,
    ac: remote.ac,
    phases: remote.phases,
    comments: remoteComments.map((c) => ({
      id: c.id,
      author: c.author,
      timestamp: c.timestamp,
      text: c.text,
    })),
    retro: remote.retro,
  };

  const validated = validateIssue(candidate);
  if (!validated.ok) {
    throw new Error(
      `hydrateFromRemote: validation failed for ${externalId}:\n  - ${validated.errors.join("\n  - ")}`,
    );
  }
  return validated.issue;
}

/**
 * Overwrite `dispatch_id` on an existing local Issue and persist the
 * change. Returns the updated Issue. Used on the existing-file path
 * where the local YAML is authoritative for everything except the
 * dispatch_id (which the poller refreshes for every new dispatch).
 */
export function stampDispatchAndWrite(
  repoLocalPath: string,
  issue: Issue,
  dispatchId: string,
): Issue {
  const updated: Issue = { ...issue, dispatch_id: dispatchId };
  writeIssue(repoLocalPath, updated);
  return updated;
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
