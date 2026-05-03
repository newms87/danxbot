/**
 * Worker HTTP handlers for the danx_issue_save / danx_issue_create MCP tools
 * (Phase 3 of tracker-agnostic-agents — Trello wsb4TVNT).
 *
 * The MCP server (`src/mcp/danxbot-server.ts`) runs as a per-dispatch `npx
 * tsx` subprocess and has no direct access to the worker's `IssueTracker`
 * instance, dispatch DB, or filesystem-relative repo paths. Both tools
 * therefore POST to per-dispatch worker endpoints (auto-injected as
 * `DANXBOT_ISSUE_SAVE_URL` / `DANXBOT_ISSUE_CREATE_URL` by the dispatch
 * core), and the bulk of the work lives here in-process.
 *
 * `danx_issue_save({external_id})` — two-tier semantics:
 *
 *   1. Sync (returned to agent): load + parseIssue from
 *      `<repo>/.danxbot/issues/{open,closed}/<external_id>.yml`. Format
 *      errors → `{saved: false, errors: [...]}` at HTTP 200 (agent-side
 *      failure, not a network error). Validation passing →
 *      `{saved: true}` returned IMMEDIATELY.
 *   2. Async (NOT returned to agent): syncIssue runs detached. Tracker
 *      errors are swallowed from the agent's view and surfaced via
 *      `updateDispatch({error})` so the dashboard SSE stream picks them
 *      up. When the saved status is Done or Cancelled, the YAML moves
 *      from `open/` → `closed/` (idempotent: skip when target file
 *      already exists).
 *
 * `danx_issue_create({filename})` — fully synchronous. Reads
 * `<repo>/.danxbot/issues/open/<filename>.yml`, validates as a draft
 * (allowing empty `external_id`), calls `tracker.createCard`, stamps
 * returned ids back into the YAML, renames to `<external_id>.yml`,
 * returns `{created: true, external_id}`. Drafts that already carry a
 * non-empty `external_id` are rejected — that's a save case, not a
 * create case.
 *
 * HTTP status codes:
 *   - 200 with `{ok: false, errors}` for every agent-recoverable failure
 *     (missing field, missing file, schema invalid, tracker rejected).
 *   - 400 ONLY for malformed JSON body (network-level malformed input).
 *
 * Concurrency: a process-scoped `Map<external_id, Promise<void>>`
 * serializes async sync work per issue. Worker mode = single Node process
 * per repo, so an in-memory Map is sufficient. No filesystem locks. A
 * separate `Set<Promise<void>>` tracks in-flight tasks for the test-only
 * drain helper — keeps drain semantics independent of the lock-chain
 * map's microtask-ordered deletion.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { json, parseBody } from "../http/helpers.js";
import {
  IssueParseError,
  parseDraftIssue,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import { syncIssue } from "../issue-tracker/sync.js";
import {
  ensureIssuesDirs,
  issuePath,
} from "../poller/yaml-lifecycle.js";
import type {
  CreateCardInput,
  Issue,
  IssueTracker,
} from "../issue-tracker/interface.js";
import { createIssueTracker } from "../issue-tracker/index.js";
import type { RepoContext } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("worker-issue-route");

/** Injected into both handlers; defaults built lazily via `getDeps`. */
export interface IssueRouteDeps {
  tracker: IssueTracker;
  /**
   * Persist an async-sync error against the dispatch row. Default
   * implementation calls `updateDispatch({ error })` which the DB change
   * detector turns into an SSE `dispatch:updated` event for the dashboard.
   */
  recordError?: (dispatchId: string, error: string) => Promise<void>;
}

/**
 * Worker mode hard-binds one Node process to one repo via
 * `DANXBOT_REPO_NAME` (see `src/repo-context.ts#loadRepoContext` —
 * always returns a single-element array). One process → one tracker
 * instance for its lifetime.
 */
let cachedTracker: IssueTracker | null = null;

/** Per-issue mutex — serializes async sync calls on the same external_id. */
const issueLocks = new Map<string, Promise<void>>();

/**
 * In-flight task set. Each scheduled async sync registers itself here
 * on creation and removes itself on settle. The test-only drain helper
 * snapshots this set to await every pending task. Independent of
 * `issueLocks` (which keys by external_id and exposes only the tail of
 * each chain) so drain semantics are insulated from microtask-ordered
 * map mutations.
 */
const inFlight = new Set<Promise<void>>();

function getDeps(repo: RepoContext, override?: IssueRouteDeps): IssueRouteDeps {
  if (override) return override;
  if (!cachedTracker) cachedTracker = createIssueTracker(repo);
  return {
    tracker: cachedTracker,
    recordError: defaultRecordError,
  };
}

async function defaultRecordError(
  dispatchId: string,
  message: string,
): Promise<void> {
  // Lazy-load `dispatches-db` so worker code paths that don't need DB
  // access (and tests injecting their own `recordError`) don't pay the
  // env-validation tax of `src/config.ts`. Config validates DB env vars
  // at module-init; the lazy import defers that until a real production
  // call site (where DB env is always present) actually fires.
  try {
    const { updateDispatch } = await import("../dashboard/dispatches-db.js");
    await updateDispatch(dispatchId, { error: message });
  } catch (err) {
    log.error(
      `Failed to record sync error on dispatch ${dispatchId}`,
      err,
    );
  }
}

/**
 * Test-only: clear the cached tracker and per-issue mutex map. Must run
 * between test cases that share the module-singleton state to avoid
 * cross-test tracker/lock leakage.
 */
export function _resetForTesting(): void {
  cachedTracker = null;
  issueLocks.clear();
  inFlight.clear();
}

/**
 * Test-only: await every in-flight async sync. The async branch of
 * `handleIssueSave` returns to the agent immediately and lets the sync
 * work run detached; tests need a deterministic await point before
 * asserting on disk + tracker state.
 */
export async function _drainAsyncWorkForTesting(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Schedule an async task on the per-issue mutex chain. Returns the
 * settle promise of the new tail. The previous tail's failure is
 * swallowed via `.catch(() => undefined)` so a single tracker error
 * doesn't poison every subsequent save in the queue — each task logs
 * its own failure independently. Both `scheduleAsyncSync` and
 * `syncTrackedIssueOnComplete` chain through this helper to keep the
 * mutex semantics in one place.
 */
function chainOnIssueLock(
  externalId: string,
  task: () => Promise<void>,
): Promise<void> {
  const prior = issueLocks.get(externalId) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => task());
  const finalized = next.finally(() => {
    if (issueLocks.get(externalId) === finalized) {
      issueLocks.delete(externalId);
    }
    inFlight.delete(finalized);
  });
  issueLocks.set(externalId, finalized);
  inFlight.add(finalized);
  return finalized;
}

/** POST /api/issue-save/:dispatchId — agent-facing save endpoint. */
export async function handleIssueSave(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
  override?: IssueRouteDeps,
): Promise<void> {
  const deps = getDeps(repo, override);

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err) {
    json(res, 400, {
      saved: false,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    return;
  }

  const externalId =
    typeof body.external_id === "string" ? body.external_id.trim() : "";
  if (!externalId) {
    json(res, 200, {
      saved: false,
      errors: ["missing required field: external_id"],
    });
    return;
  }

  const sourcePath = locateIssueFile(repo.localPath, externalId);
  if (!sourcePath) {
    json(res, 200, {
      saved: false,
      errors: [
        `No YAML file found at .danxbot/issues/{open,closed}/${externalId}.yml`,
      ],
    });
    return;
  }

  let issue: Issue;
  try {
    issue = parseIssue(readFileSync(sourcePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    json(res, 200, { saved: false, errors: [msg] });
    return;
  }

  // Sync validation passed — return `saved: true` immediately. Tracker
  // errors must NEVER surface to the agent (AC #2). The async branch runs
  // detached and reports failures to the dispatch row.
  json(res, 200, { saved: true });

  chainOnIssueLock(issue.external_id, () =>
    runSync(deps, dispatchId, repo, issue),
  );
}

async function runSync(
  deps: IssueRouteDeps,
  dispatchId: string,
  repo: RepoContext,
  issue: Issue,
): Promise<void> {
  try {
    const { updatedLocal } = await syncIssue(deps.tracker, issue);
    persistAfterSync(repo.localPath, updatedLocal);
  } catch (err) {
    const msg = `danx_issue_save async sync failed for ${issue.external_id}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    log.error(msg);
    await deps.recordError?.(dispatchId, msg);
  }
}

/**
 * Write `updatedLocal` back to disk, applying the open→closed move when
 * the saved status is terminal. Idempotent: re-running on a Done issue
 * already in `closed/` produces zero filesystem mutations beyond
 * rewriting the same content.
 */
function persistAfterSync(repoLocalPath: string, issue: Issue): void {
  ensureIssuesDirs(repoLocalPath);
  const openPath = issuePath(repoLocalPath, issue.external_id, "open");
  const closedPath = issuePath(repoLocalPath, issue.external_id, "closed");
  const isTerminal = issue.status === "Done" || issue.status === "Cancelled";

  if (isTerminal) {
    writeFileSync(closedPath, serializeIssue(issue));
    if (existsSync(openPath)) unlinkSync(openPath);
  } else {
    writeFileSync(openPath, serializeIssue(issue));
    // If a stale closed copy lingers from a previous Done save that the
    // operator manually re-opened, the open copy now wins — leave the
    // closed file alone. The poller will treat the open copy as
    // authoritative on the next tick.
  }
}

/** POST /api/issue-create/:dispatchId — synchronous create-card flow. */
export async function handleIssueCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _dispatchId: string,
  repo: RepoContext,
  override?: IssueRouteDeps,
): Promise<void> {
  const deps = getDeps(repo, override);

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err) {
    json(res, 400, {
      created: false,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    return;
  }

  const filenameRaw =
    typeof body.filename === "string" ? body.filename.trim() : "";
  if (!filenameRaw) {
    json(res, 200, {
      created: false,
      errors: ["missing required field: filename"],
    });
    return;
  }
  const filename = filenameRaw.endsWith(".yml")
    ? filenameRaw.slice(0, -4)
    : filenameRaw;

  const sourcePath = issuePath(repo.localPath, filename, "open");
  if (!existsSync(sourcePath)) {
    json(res, 200, {
      created: false,
      errors: [`File not found: .danxbot/issues/open/${filename}.yml`],
    });
    return;
  }

  let draft: Issue;
  try {
    draft = parseDraftIssue(readFileSync(sourcePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    json(res, 200, { created: false, errors: [msg] });
    return;
  }

  // Reject drafts that already carry an external_id. Creating a card
  // for a draft that the tracker already knows about would silently
  // produce a duplicate remote card and stamp a NEW id over the
  // existing one — the local YAML and tracker would then disagree on
  // identity. The fail-loud path is to push the agent to call
  // `danx_issue_save` instead, which is the right tool for an existing
  // card.
  if (draft.external_id !== "") {
    json(res, 200, {
      created: false,
      errors: [
        `Draft already has external_id "${draft.external_id}" — use danx_issue_save to update an existing card, not danx_issue_create`,
      ],
    });
    return;
  }

  const input: CreateCardInput = {
    schema_version: 1,
    tracker: draft.tracker,
    parent_id: draft.parent_id,
    status: draft.status,
    type: draft.type,
    title: draft.title,
    description: draft.description,
    triaged: draft.triaged,
    ac: draft.ac.map((a) => ({ title: a.title, checked: a.checked })),
    phases: draft.phases.map((p) => ({
      title: p.title,
      status: p.status,
      notes: p.notes,
    })),
    comments: draft.comments,
    retro: draft.retro,
  };

  let result: {
    external_id: string;
    ac: { check_item_id: string }[];
    phases: { check_item_id: string }[];
  };
  try {
    result = await deps.tracker.createCard(input);
  } catch (err) {
    json(res, 200, {
      created: false,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    return;
  }

  const stamped: Issue = {
    ...draft,
    external_id: result.external_id,
    ac: draft.ac.map((a, i) => ({
      ...a,
      check_item_id: result.ac[i]?.check_item_id ?? a.check_item_id,
    })),
    phases: draft.phases.map((p, i) => ({
      ...p,
      check_item_id: result.phases[i]?.check_item_id ?? p.check_item_id,
    })),
  };

  ensureIssuesDirs(repo.localPath);
  const targetPath = issuePath(repo.localPath, result.external_id, "open");
  writeFileSync(targetPath, serializeIssue(stamped));
  if (sourcePath !== targetPath && existsSync(sourcePath)) {
    unlinkSync(sourcePath);
  }

  json(res, 200, { created: true, external_id: result.external_id });
}

/** Look in `open/` first, then `closed/`. Returns null when neither exists. */
function locateIssueFile(
  repoLocalPath: string,
  externalId: string,
): string | null {
  const open = issuePath(repoLocalPath, externalId, "open");
  if (existsSync(open)) return open;
  const closed = issuePath(repoLocalPath, externalId, "closed");
  if (existsSync(closed)) return closed;
  return null;
}

/**
 * Run `danx_issue_save` synchronously from inside the worker (no HTTP
 * round-trip). Used by `handleStop` for `danxbot_complete` auto-sync —
 * the dispatch is already terminating, so the worker fires + awaits the
 * sync directly. Validation failures are recorded via `recordError`;
 * tracker errors are swallowed (same contract as the async path).
 *
 * Returns `{ ok, errors }` so the caller can log validation failures
 * without forcing them into the response body of an unrelated handler.
 */
export async function syncTrackedIssueOnComplete(
  dispatchId: string,
  repo: RepoContext,
  externalId: string,
  override?: IssueRouteDeps,
): Promise<{ ok: boolean; errors: string[] }> {
  const deps = getDeps(repo, override);
  const sourcePath = locateIssueFile(repo.localPath, externalId);
  if (!sourcePath) {
    return {
      ok: false,
      errors: [
        `No YAML file found at .danxbot/issues/{open,closed}/${externalId}.yml`,
      ],
    };
  }

  let issue: Issue;
  try {
    issue = parseIssue(readFileSync(sourcePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    await deps.recordError?.(
      dispatchId,
      `danxbot_complete auto-sync validation failure: ${msg}`,
    );
    return { ok: false, errors: [msg] };
  }

  // Wait on the per-issue mutex so we don't race a concurrent agent-
  // initiated save. The agent is shutting down here, so we await the
  // tracker push synchronously (unlike the async branch in handleIssueSave).
  await chainOnIssueLock(externalId, () =>
    runSync(deps, dispatchId, repo, issue),
  );
  return { ok: true, errors: [] };
}
