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
 *     open/<external_id>.yml      active issues
 *     closed/<external_id>.yml    issues whose status is Done or Cancelled
 *
 * `dispatch_id` overwrites every dispatch — it is the resume key, not a
 * history. The poller pre-generates the dispatch UUID, threads it
 * through `DispatchInput.dispatchId` to `dispatch()`, and stamps the
 * SAME UUID into the YAML file via `stampDispatchAndWrite` (existing
 * local file) or `hydrateFromRemote` + `writeIssue` (brand-new card on
 * remote, no local file yet).
 *
 * Phase 2 owns: hydration, load, stamp, write, dirs, gitignore. The
 * `open/` → `closed/` move when status is Done or Cancelled is Phase 3
 * (`danx_issue_save` MCP tool, Trello wsb4TVNT).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import {
  createEmptyIssue,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../issue-tracker/yaml.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";

export type IssueState = "open" | "closed";

/** Absolute path to the YAML file for an issue in a given lifecycle state. */
export function issuePath(
  repoLocalPath: string,
  externalId: string,
  state: IssueState,
): string {
  return resolve(
    repoLocalPath,
    ".danxbot",
    "issues",
    state,
    `${externalId}.yml`,
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
 * Read + parse + validate the YAML for an issue. Looks in `open/` first,
 * then `closed/`. Returns null when neither file exists. Throws
 * `IssueParseError` on malformed YAML or schema-validation failure — the
 * validator is strict and that's a load-bearing invariant.
 */
export function loadLocal(
  repoLocalPath: string,
  externalId: string,
): Issue | null {
  for (const state of ["open", "closed"] as const) {
    const path = issuePath(repoLocalPath, externalId, state);
    if (!existsSync(path)) continue;
    return parseIssue(readFileSync(path, "utf-8"));
  }
  return null;
}

/**
 * Write the issue to `<repo>/.danxbot/issues/open/<external_id>.yml`.
 * Always writes to `open/` — the move to `closed/` is Phase 3's
 * `danx_issue_save` job.
 */
export function writeIssue(repoLocalPath: string, issue: Issue): void {
  ensureIssuesDirs(repoLocalPath);
  const path = issuePath(repoLocalPath, issue.external_id, "open");
  writeFileSync(path, serializeIssue(issue));
}

/**
 * Brand-new card on the remote → one-time full hydration. Calls the
 * tracker for card metadata + comments, builds a complete Issue stamped
 * with the supplied `dispatchId`, and validates strictly. Does NOT write
 * to disk — caller is responsible for `writeIssue` (this keeps the
 * helper testable without a tmpdir).
 *
 * The validator is strict — every required field MUST be filled before
 * `validateIssue` runs, so we route through `createEmptyIssue` to
 * guarantee defaults for any field the tracker doesn't supply.
 */
export async function hydrateFromRemote(
  tracker: IssueTracker,
  externalId: string,
  dispatchId: string,
): Promise<Issue> {
  const remote = await tracker.getCard(externalId);
  const remoteComments = await tracker.getComments(externalId);

  const seed = createEmptyIssue({
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
