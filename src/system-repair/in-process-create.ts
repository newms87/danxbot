/**
 * DX-563 — in-process bridge to {@link nextIssueId} + the issue-tracker
 * write path. The self-repair-dispatch cron job calls this INSTEAD of
 * a self-HTTP loop to `/api/issue-create/<id>` — the dispatcher already
 * runs in the worker, so the HTTP round-trip is unnecessary overhead.
 *
 * Side effects mirror the YAML-only branch of `handleIssueCreate`:
 *
 *  1. Read the draft YAML at `open/<filename>.yml`.
 *  2. Allocate the next `<PREFIX>-N` for the repo via `nextIssueId`.
 *  3. Write the stamped Issue to `open/<id>.yml`.
 *  4. Remove the draft file.
 *  5. Return `{created: true, id}`.
 *
 * The tracker push (Trello, etc.) is NOT performed here — the worker's
 * per-tick mirror + `auto-sync` push handle that asynchronously. The
 * issue-tracker decoupling invariant (CLAUDE.md §"Trello Is Background
 * Infrastructure") explicitly forbids tracker calls in the agent's
 * critical path; the self-repair dispatcher is no different.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseIssue, serializeIssue, IssueParseError } from "../issue-tracker/yaml.js";
import { nextIssueId } from "../issue-tracker/id-generator.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import { ensureIssuesDirs, issuePath } from "../issue-tracker/paths.js";

export interface CreateInProcessIssueInput {
  repoRoot: string;
  /** Draft filename (without `.yml`) — matches the file under `open/`. */
  filename: string;
}

export interface CreateInProcessIssueResult {
  created: boolean;
  id?: string;
  errors?: string[];
}

export async function createInProcessIssue(
  input: CreateInProcessIssueInput,
): Promise<CreateInProcessIssueResult> {
  const { repoRoot, filename } = input;

  const draftPath = resolve(
    repoRoot,
    ".danxbot",
    "issues",
    "open",
    `${filename}.yml`,
  );
  if (!existsSync(draftPath)) {
    return {
      created: false,
      errors: [`Draft not found: .danxbot/issues/open/${filename}.yml`],
    };
  }

  let prefix: string;
  try {
    prefix = loadIssuePrefix(repoRoot);
  } catch (err) {
    return {
      created: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  const id = await nextIssueId(
    resolve(repoRoot, ".danxbot", "issues"),
    prefix,
  );

  // Re-stamp the draft's id via the YAML lib (matches the worker's
  // existing `handleIssueCreate` flow): parse raw, set `id`, re-emit,
  // run `parseIssue` strict on the stamped output. Avoids carrying a
  // custom `allowEmptyId` knob on the validator just for this helper.
  let stamped: string;
  try {
    const yaml = await import("yaml");
    const rawDraft = yaml.parse(readFileSync(draftPath, "utf-8")) as Record<
      string,
      unknown
    >;
    rawDraft.id = id;
    const stampedRaw = yaml.stringify(rawDraft);
    const parsed = parseIssue(stampedRaw, { expectedPrefix: prefix });
    stamped = serializeIssue(parsed);
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    return { created: false, errors: [msg] };
  }

  ensureIssuesDirs(repoRoot);
  const finalPath = issuePath(repoRoot, id, "open");
  writeFileSync(finalPath, stamped, "utf-8");

  // Remove the draft AFTER the final write succeeds — a crash between
  // the two would otherwise leave the repo without the stamped card.
  // The chokidar mirror picks up both the create + unlink events, but
  // the writer's intent is "rename" so the ordering matters.
  if (draftPath !== finalPath) {
    try {
      unlinkSync(draftPath);
    } catch {
      // Best-effort: if the unlink fails the stamped file is already
      // on disk; the operator can clean the draft later.
    }
  }

  return { created: true, id };
}
