/**
 * Worker HTTP handler for the `danx_issue_create` MCP tool, plus the
 * `syncTrackedIssueOnComplete` helper invoked by `handleStop` /
 * `auto-sync.ts` when an agent calls `danxbot_complete`.
 *
 * The MCP server (`src/mcp/danxbot-server.ts`) runs as a per-dispatch `npx
 * tsx` subprocess and has no direct access to the worker's `IssueTracker`
 * instance, dispatch DB, or filesystem-relative repo paths. The tool
 * therefore POSTs to a per-dispatch worker endpoint (auto-injected as
 * `DANXBOT_ISSUE_CREATE_URL` by the dispatch core), and the bulk of the
 * work lives here in-process.
 *
 * **DX-157 retired the parallel agent save tool / HTTP route.**
 * Agents now `Edit` / `Write` the YAML at
 * `<repo>/.danxbot/issues/{open,closed}/<id>.yml` directly. The chokidar
 * watcher (Phase 3, `src/db/issues-mirror.ts`) catches the file event and
 * mirrors it to Postgres; the poller's per-tick mirror handles the
 * outbound tracker push asynchronously. The watcher is ALWAYS the canonical
 * write path to the DB, including for agent-driven edits.
 *
 * `danx_issue_create({filename})` — fully synchronous. Reads
 * `<repo>/.danxbot/issues/open/<filename>.yml` (a draft slug, e.g.
 * `add-jsonl-tail.yml`), allocates the next internal `<PREFIX>-N` id via
 * `nextIssueId`, stamps it into the draft, calls `tracker.createCard`,
 * stamps the returned `external_id` + check_item_ids back into the YAML,
 * renames the file to `<id>.yml`, and returns `{created: true, id,
 * external_id}`. Drafts that already carry a non-empty `id` are rejected
 * — the existing-id update path is `Edit` directly, not `create`.
 *
 * `syncTrackedIssueOnComplete` runs synchronously from inside the worker
 * (no HTTP round-trip) when an agent signals `danxbot_complete`. It
 * applies the same `forceWaitingOnToToDo` normalization + history-diff
 * append the legacy save handler did, then calls `runSync` to push to
 * the tracker. This is the immediate-tracker-push safety net; without it
 * a completed agent's terminal-state YAML would only reach the tracker
 * on the poller's next tick (~30-60s lag).
 *
 * HTTP status codes:
 *   - 200 with `{ok: false, errors}` for every agent-recoverable failure
 *     (missing field, missing file, schema invalid, tracker rejected).
 *   - 400 ONLY for malformed JSON body (network-level malformed input).
 *
 * Concurrency: a process-scoped `Map<id, Promise<void>>` serializes async
 * sync work per issue (keyed by internal id, NOT external_id, because
 * external_id is empty for memory-tracker issues + drafts pre-create).
 * Worker mode = single Node process per repo, so an in-memory Map is
 * sufficient. No filesystem locks. A separate `Set<Promise<void>>` tracks
 * in-flight tasks for the test-only drain helper — keeps drain semantics
 * independent of the lock-chain map's microtask-ordered deletion.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { json, parseBody } from "../http/helpers.js";
import {
  appendHistory,
  IssueParseError,
  issueToCreateInput,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import { nextIssueId } from "../issue-tracker/id-generator.js";
import { loadActionItemTitles, syncIssue } from "../issue-tracker/sync.js";
import { enqueueRetry } from "../issue-tracker/retry-queue.js";
import {
  ensureIssuesDirs,
  issuePath,
  moveToClosedIfTerminal,
} from "../poller/yaml-lifecycle.js";
import type {
  CreateCardInput,
  Issue,
  WaitingOn,
  IssueHistoryEntry,
  IssueStatus,
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
  /**
   * Surface a worker-internal anomaly to the dashboard's `system_errors`
   * stream. Today the only invocation site is the actor-resolution gap
   * on save / create when `dispatchId` is empty (DX-146 / Phase 2). The
   * dashboard's analytics pipe (DX-134 / future Phase 4) is the eventual
   * consumer; until then the hook is a no-op in production. Tests inject
   * a recorder to assert the gap is loud, not silent.
   */
  recordSystemError?: (message: string) => void | Promise<void>;
}

/**
 * Worker mode hard-binds one Node process to one repo via
 * `DANXBOT_REPO_NAME` (see `src/repo-context.ts#loadRepoContext` —
 * always returns a single-element array). One process → one tracker
 * instance for its lifetime.
 */
let cachedTracker: IssueTracker | null = null;

/** Per-issue mutex — serializes async sync calls on the same internal id. */
const issueLocks = new Map<string, Promise<void>>();

/**
 * Last-seen `{status, waiting_on}` per internal id. Populated by
 * `handleIssueCreate` on the `created` event and by every
 * `syncTrackedIssueOnComplete` invocation; read at the start of each
 * subsequent invocation to compute the diff that drives
 * `appendDiffEntries`.
 *
 * This is the only place the worker carries cross-call state for an
 * issue. Cache miss = first event in this worker process for that id =
 * no diff (intentional; we have no prior reference state). Worker
 * restart loses the cache, so the first sync after restart also has no
 * diff — same fallback. The cache is updated AFTER `appendDiffEntries`
 * runs so the next call sees the post-normalization state
 * (`forceWaitingOnToToDo` already applied).
 *
 * **Concurrent-call safety on the same id.** `applyHistoryDiff` reads
 * `prior` and writes the new state in straight-line synchronous code
 * (no `await` between the `.get` and the `.set`). Two concurrent
 * `syncTrackedIssueOnComplete` calls on the same id can interleave at
 * the application level, but inside `applyHistoryDiff` each call
 * observes a coherent snapshot of `prior`. The "last call wins" outcome
 * is the intended semantic — B's post-normalization state IS the correct
 * reference for whatever call lands next, regardless of which arrived
 * first at the cache.
 *
 * NOT a substitute for the on-disk YAML — the YAML remains the only
 * persisted source of truth. The cache is purely a diff-source for the
 * append-only `history[]` audit log.
 */
const lastSeenIssueState = new Map<
  string,
  { status: IssueStatus; waiting_on: WaitingOn | null }
>();

/**
 * Fire-and-forget invocation of an optional `recordSystemError` hook.
 * The hook is `void | Promise<void>` per `IssueRouteDeps`, so a
 * synchronous throw OR an async rejection both need containment — a
 * naked `void Promise.resolve(hook())` adopts a rejected return value
 * without attaching `.catch`, surfacing as `UnhandledPromiseRejection`
 * (and on `--unhandled-rejections=strict`, exiting the worker).
 *
 * Mirrors the `try { await … } catch { log.warn(…) }` shape used by
 * `src/issue-tracker/retry-queue.ts:433` so the worker has exactly one
 * way to call instrumentation hooks. We do not block the save path on
 * the hook — the dashboard SSE consumer (DX-134, future) is best-effort
 * instrumentation, never a save gate.
 */
function fireAndForgetSystemError(
  deps: Pick<IssueRouteDeps, "recordSystemError"> | undefined,
  message: string,
): void {
  const hook = deps?.recordSystemError;
  if (!hook) return;
  let result: void | Promise<void>;
  try {
    result = hook(message);
  } catch (err) {
    log.warn(
      `recordSystemError hook threw synchronously: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (
    result &&
    typeof (result as Promise<unknown>).then === "function"
  ) {
    (result as Promise<unknown>).catch((err) => {
      log.warn(
        `recordSystemError hook rejected: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}

/**
 * Resolve the actor identity for a save / create event. Empty
 * `dispatchId` is a worker bug we want surfaced to the dashboard,
 * not silenced — the bare `"unknown"` actor is grandfathered through
 * `appendHistory`'s format check, so the entry still lands on disk
 * (operator can chase the gap), but the `recordSystemError` hook
 * fires so the dashboard `system_errors` stream surfaces it.
 *
 * Single source of truth for both `appendDiffEntries` (save path) and
 * `handleIssueCreate` (create path). The `context` literal is folded
 * into the diagnostic message so logs distinguish save vs create.
 */
function resolveDispatchActor(
  dispatchId: string,
  context: "save" | "create",
  deps: Pick<IssueRouteDeps, "recordSystemError"> | undefined,
): string {
  if (dispatchId) return `dispatch:${dispatchId}`;
  fireAndForgetSystemError(
    deps,
    `missing dispatch id on issue ${context} — actor falls back to 'unknown'`,
  );
  return "unknown";
}

/**
 * Pure helper: compute the new history array for a save by diffing the
 * agent's saved state against the worker's last-seen state, then
 * appending one entry per detected transition. Order: `status_change`
 * before `blocked` / `unblocked` so a same-save status flip reads first
 * in the timeline.
 *
 * Both inputs are taken AFTER `forceWaitingOnToToDo` normalization so an
 * agent's `(status: "Blocked", waiting_on: {…})` save — given prior
 * cached state `In Progress` — emits a proper
 * `status_change(In Progress, ToDo)` plus `blocked` event, not a
 * spurious `(In Progress, Needs Help)` jump that never actually
 * persisted (the worker normalizes status → ToDo whenever waiting_on is
 * non-null).
 *
 *  - `oldIssue == null` → first save in this worker process for this id.
 *    Returns `newIssue.history` unchanged (by reference, so the upstream
 *    identity check in `applyHistoryDiff` can avoid the spread). The
 *    first transition is intentionally unrecorded; the
 *    `recordSystemError` hook is also NOT fired on this branch — no
 *    `"unknown"` entry was actually written, so there is nothing for
 *    the operator to chase.
 *  - Empty `dispatchId` with at least one transition detected → actor
 *    falls back to bare `"unknown"` AND `recordSystemError` is invoked
 *    once. The dashboard's `system_errors` stream (DX-134, future)
 *    surfaces these gaps so the operator can chase the missing actor at
 *    the source.
 *  - All cap + truncation logic is delegated to `appendHistory` (DX-145).
 */
export function appendDiffEntries(
  oldIssue: Pick<Issue, "status" | "waiting_on"> | null,
  newIssue: Issue,
  dispatchId: string,
  nowIso: string,
  deps?: Pick<IssueRouteDeps, "recordSystemError">,
): IssueHistoryEntry[] {
  if (!oldIssue) return newIssue.history;

  const actor = resolveDispatchActor(dispatchId, "save", deps);

  let history = newIssue.history;

  if (oldIssue.status !== newIssue.status) {
    history = appendHistory(history, {
      timestamp: nowIso,
      actor,
      event: "status_change",
      from: oldIssue.status,
      to: newIssue.status,
    });
  }

  if (oldIssue.waiting_on === null && newIssue.waiting_on !== null) {
    history = appendHistory(history, {
      timestamp: nowIso,
      actor,
      event: "blocked",
      to: newIssue.status,
      note: `Waiting on ${newIssue.waiting_on.by.join(", ")}`,
    });
  }

  if (oldIssue.waiting_on !== null && newIssue.waiting_on === null) {
    history = appendHistory(history, {
      timestamp: nowIso,
      actor,
      event: "unblocked",
      to: newIssue.status,
    });
  }

  return history;
}

/**
 * Apply the diff-driven history append AND update the last-seen cache
 * in one place. Called by `syncTrackedIssueOnComplete` BEFORE the first
 * `persistAfterSync` so the on-disk YAML carries the new entries. The
 * cache update happens unconditionally so the next call sees this
 * call's post-normalization state.
 *
 * The `forceWaitingOnToToDo` normalization happens upstream (in
 * `syncTrackedIssueOnComplete`), so `issue` here is already the
 * post-normalized shape per the diff contract.
 *
 * **Allocation:** when no transitions were detected, `appendDiffEntries`
 * returns `issue.history` by reference; the identity check below short-
 * circuits the spread so steady-state mid-session calls do not pay an
 * issue-clone allocation per call.
 */
function applyHistoryDiff(
  issue: Issue,
  dispatchId: string,
  deps: IssueRouteDeps,
): Issue {
  const prior = lastSeenIssueState.get(issue.id) ?? null;
  const updatedHistory = appendDiffEntries(
    prior,
    issue,
    dispatchId,
    new Date().toISOString(),
    deps,
  );
  lastSeenIssueState.set(issue.id, {
    status: issue.status,
    waiting_on: issue.waiting_on,
  });
  return updatedHistory === issue.history
    ? issue
    : { ...issue, history: updatedHistory };
}

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
    recordSystemError: (message) => defaultRecordSystemError(repo, message),
  };
}

/**
 * Default `recordSystemError` for the runSync catch + actor-resolution
 * gap. Lazy-imports `system-errors` so worker code paths that don't need
 * the dashboard module don't pay the import cost; the import itself is
 * cheap (no env validation), but keeping the surface symmetric with
 * `defaultRecordError` above also makes it trivially mockable in tests.
 */
async function defaultRecordSystemError(
  repo: RepoContext,
  message: string,
): Promise<void> {
  try {
    const { recordSystemError } = await import("../dashboard/system-errors.js");
    recordSystemError({
      source: "tracker",
      severity: "error",
      repo: repo.name,
      message,
    });
  } catch (err) {
    log.warn(
      `defaultRecordSystemError failed for ${repo.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
    log.error(`Failed to record sync error on dispatch ${dispatchId}`, err);
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
  lastSeenIssueState.clear();
}

/**
 * Test-only: await every in-flight async task on the per-issue mutex
 * chain. `chainOnIssueLock` schedules tracker pushes off the hot path
 * (currently invoked only from `syncTrackedIssueOnComplete`); tests
 * need a deterministic await point before asserting on disk + tracker
 * state.
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
 * doesn't poison every subsequent task in the queue — each task logs
 * its own failure independently. `syncTrackedIssueOnComplete` is the
 * sole production caller; helper exists in its own function so the
 * mutex semantics live in one place even if a future caller is added.
 */
function chainOnIssueLock(
  id: string,
  task: () => Promise<void>,
): Promise<void> {
  const prior = issueLocks.get(id) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => task());
  const finalized = next.finally(() => {
    if (issueLocks.get(id) === finalized) {
      issueLocks.delete(id);
    }
    inFlight.delete(finalized);
  });
  issueLocks.set(id, finalized);
  inFlight.add(finalized);
  return finalized;
}

/**
 * Local-first sync: persist the agent's edit to disk BEFORE pushing to
 * the tracker, then push, then re-persist any tracker-side mutations
 * (orphan-recovery `external_id` allocation, `check_item_id` stamps,
 * inbound human comments).
 *
 * The local YAML at `<repo>/.danxbot/issues/{open,closed}/` is the
 * single source of truth — Trello is a one-way mirror (see
 * `.claude/rules/agent-dispatch.md` "Source of Truth"). When Trello is
 * unreachable (401, 500, network outage), the previous order — push
 * first, persist on success — left terminal-status YAMLs stranded in
 * `open/`: the in-memory copy reflected the agent's `Done` edit but the
 * on-disk file never got the open→closed move. That was the root cause
 * of DX-95 sitting in `open/` with `status: Done`.
 *
 * Re-persisting after a successful tracker push is idempotent:
 * `persistAfterSync` is a single `writeFileSync` plus an `existsSync`-
 * gated `unlinkSync`, both safe to repeat with identical input. When
 * `updatedLocal` is structurally identical to `issue` (no orphan-id
 * mint, no new check_item_ids, no inbound comments), the second call
 * writes the same bytes — same end state.
 *
 * The second persist is unconditional rather than guarded on
 * `remoteWriteCount > 0`: deciding "did the tracker mutate anything?"
 * cleanly requires a deep diff of `issue` vs `updatedLocal` (ac stamps,
 * comment merges, orphan-recovered external_id), and that branch is
 * more expensive than a same-content `writeFileSync`. Idempotency is
 * the contract — pinned by the byte-identical re-run test in
 * `issue-route.test.ts`.
 *
 * Tracker errors are recorded against the dispatch row (so the
 * dashboard surfaces them) but never roll back the local persist.
 *
 * Exported for two reasons: (a) `syncTrackedIssueOnComplete` reuses it
 * for the synchronous danxbot-complete auto-sync path; (b) the unit
 * tests in `issue-route.test.ts` drive it directly with a mocked
 * `syncIssue`. Not part of the worker's public HTTP surface — DX-157
 * retired the legacy agent-facing save route entirely.
 */
export async function runSync(
  deps: IssueRouteDeps,
  dispatchId: string,
  repo: RepoContext,
  issue: Issue,
): Promise<void> {
  persistAfterSync(repo.localPath, issue);

  try {
    const actionItemTitles = loadActionItemTitles(
      repo.localPath,
      issue.retro.action_item_ids,
      repo.issuePrefix,
      log,
    );
    const { updatedLocal } = await syncIssue(deps.tracker, issue, {
      actionItemTitles,
    });
    persistAfterSync(repo.localPath, updatedLocal);
  } catch (err) {
    const msg = `tracker sync failed for ${issue.external_id}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    log.error(msg);
    await deps.recordError?.(dispatchId, msg);
    // DX-134 Phase 4: surface the same failure to the dashboard's
    // `system-errors` SSE channel so the operator banner shows it
    // even when no specific dispatch row is currently open in the UI.
    // Fire-and-forget — the hook is a no-op when not configured (tests
    // not wiring the dep) and never blocks the save path.
    fireAndForgetSystemError(deps, msg);
    // DX-132 Phase 2: persist a retry intent to disk. Phase 1 made the
    // local YAML write happen first (so terminal-status moves are no
    // longer rolled back by tracker errors); this line ensures the
    // failed tracker push is REPLAYED on a subsequent poller tick
    // instead of being permanently lost. Drain runs at the top of
    // every `_poll`. Enqueue is best-effort — a filesystem failure
    // here would shadow the original tracker error, so we swallow.
    try {
      enqueueRetry({
        issueId: issue.id,
        repoLocalPath: repo.localPath,
        errMessage: err instanceof Error ? err.message : String(err),
      });
    } catch (enqueueErr) {
      log.warn(
        `Retry queue: enqueue failed for ${issue.id}: ${
          enqueueErr instanceof Error
            ? enqueueErr.message
            : String(enqueueErr)
        }`,
      );
    }
  }
}

/**
 * `persistAfterSync` clears `dispatch: null` whenever the agent's save
 * indicates the dispatch slot is no longer needed (ISS-92, Phase 2).
 *
 * Triggers on save:
 *  - terminal status: Done, Cancelled, Blocked
 *  - non-terminal status with `waiting_on != null`: the agent has flipped
 *    the card to waiting (worker normalizes to ToDo) and is exiting
 *    its session. Mid-session saves keep status: ToDo / In Progress
 *    with `waiting_on: null`, which fall through and preserve the live
 *    dispatch record.
 *  - `requires_human != null` on save: the agent flipped the orthogonal
 *    "needs human action" indicator and is exiting; the human is the
 *    next actor.
 *
 * Without this, a stale `dispatch{}` block survives every Done /
 * Blocked / Waiting / requires_human save and falsely re-claims the card
 * on the next poller startup's reattach pass — the symptom that prompted
 * Phase 2 of the poller-triage rework.
 *
 * DX-231 retired `Needs Approval`; the orthogonal `requires_human` field
 * is now the trigger for the agent-set "human is next actor" handoff.
 */
export function isDispatchSessionTerminal(issue: Issue): boolean {
  if (
    issue.status === "Done" ||
    issue.status === "Cancelled" ||
    issue.status === "Blocked"
  ) {
    return true;
  }
  if (issue.waiting_on !== null) return true;
  if (issue.requires_human !== null) return true;
  return false;
}

/**
 * Write `updatedLocal` back to disk, applying the open→closed move when
 * the saved status is terminal. Idempotent: re-running on a Done issue
 * already in `closed/` produces zero filesystem mutations beyond
 * rewriting the same content.
 *
 * Filename is the issue's internal `id` — the local primary key. The
 * external_id is irrelevant to file layout (some issues have none).
 *
 * The terminal-status open→closed move is delegated to
 * `moveToClosedIfTerminal` (ISS-133, Phase 3) — same helper the poller's
 * per-tick `healLocalYamls` pass uses, so a YAML stuck in `open/` from a
 * prior failed sync auto-recovers next tick without diverging from the
 * worker's persist semantics.
 */
function persistAfterSync(repoLocalPath: string, issue: Issue): void {
  // Clear the dispatch slot on terminal-for-session saves (ISS-92,
  // Phase 2). Mid-session saves with non-null dispatch survive
  // unchanged so the reattach pass + per-tick liveness scan still see
  // the running agent.
  const persisted = isDispatchSessionTerminal(issue) && issue.dispatch !== null
    ? { ...issue, dispatch: null }
    : issue;

  if (moveToClosedIfTerminal(repoLocalPath, persisted)) return;

  // Non-terminal save — write to `open/`. If a stale closed copy
  // lingers from a previous Done save that the operator manually
  // re-opened, the open copy now wins — leave the closed file alone.
  // The poller will treat the open copy as authoritative on the next
  // tick.
  ensureIssuesDirs(repoLocalPath);
  const openPath = issuePath(repoLocalPath, persisted.id, "open");
  writeFileSync(openPath, serializeIssue(persisted));
}

/** POST /api/issue-create/:dispatchId — synchronous create-card flow. */
export async function handleIssueCreate(
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

  // Drafts pre-create have empty `id` AND empty `external_id`. We parse
  // strict (parseIssue requires a non-empty id) AFTER stamping the id —
  // see below. To get there we need to read the raw YAML first.
  let rawDraft: unknown;
  try {
    const yaml = await import("yaml");
    rawDraft = yaml.parse(readFileSync(sourcePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 200, { created: false, errors: [`Malformed YAML: ${msg}`] });
    return;
  }

  if (
    typeof rawDraft !== "object" ||
    rawDraft === null ||
    Array.isArray(rawDraft)
  ) {
    json(res, 200, {
      created: false,
      errors: ["Draft YAML must be a mapping"],
    });
    return;
  }
  const draftMap = rawDraft as Record<string, unknown>;

  // Reject drafts that already carry an id or external_id. Either is a
  // signal the file is not a fresh draft — running create on it would
  // either duplicate the tracker card or overwrite the existing id.
  // Fail loud and push the agent toward `Edit` / `Write` directly.
  if (typeof draftMap.id === "string" && draftMap.id.length > 0) {
    json(res, 200, {
      created: false,
      errors: [
        `Draft already has id "${String(draftMap.id)}" — edit the existing YAML at .danxbot/issues/{open,closed}/${String(draftMap.id)}.yml directly, not danx_issue_create`,
      ],
    });
    return;
  }
  if (
    typeof draftMap.external_id === "string" &&
    draftMap.external_id.length > 0
  ) {
    json(res, 200, {
      created: false,
      errors: [
        `Draft already has external_id "${String(draftMap.external_id)}" — edit the existing YAML directly, not danx_issue_create`,
      ],
    });
    return;
  }

  // Allocate the next `<PREFIX>-N` (per `repo.issuePrefix`) before
  // parsing so the strict validator accepts the draft as a fully-formed
  // v3 issue.
  const newId = await nextIssueId(
    path.join(repo.localPath, ".danxbot", "issues"),
    repo.issuePrefix,
  );
  draftMap.id = newId;
  // `parseIssue` requires schema_version: 3 — auto-fill if the agent
  // omitted it (drafts are increasingly skeletal).
  if (draftMap.schema_version === undefined) {
    draftMap.schema_version = 3;
  }
  // Provide an empty external_id explicitly so the validator's required-
  // field check passes.
  if (draftMap.external_id === undefined) {
    draftMap.external_id = "";
  }
  // `children` is required by the strict validator. Drafts almost always
  // come in without it (children are populated by the danx-epic-link skill
  // post-create on epics, never on the create call itself).
  if (draftMap.children === undefined) {
    draftMap.children = [];
  }

  // `phases` was retired in ISS-81 — unified into `children[]`. Reject any
  // draft that carries a non-empty phases payload so the agent learns to
  // use `children[]` instead. An empty `phases: []` from a stale template is
  // tolerated silently and stripped below.
  if (draftMap.phases !== undefined) {
    const isEmptyArr = Array.isArray(draftMap.phases) && draftMap.phases.length === 0;
    if (!isEmptyArr) {
      json(res, 200, {
        created: false,
        errors: [
          "phases field removed (ISS-81); use children[] for sub-cards / epic phase cards",
        ],
      });
      return;
    }
    delete draftMap.phases;
  }

  let draft: Issue;
  try {
    // Re-validate via the strict path so every other field is checked.
    const yaml = await import("yaml");
    draft = parseIssue(yaml.stringify(draftMap), {
      expectedPrefix: repo.issuePrefix,
    });
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    json(res, 200, { created: false, errors: [msg] });
    return;
  }

  const input: CreateCardInput = issueToCreateInput(draft);

  let result: {
    external_id: string;
    ac: { check_item_id: string }[];
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

  const partiallyStamped: Issue = {
    ...draft,
    external_id: result.external_id,
    ac: draft.ac.map((a, i) => ({
      ...a,
      check_item_id: result.ac[i]?.check_item_id ?? a.check_item_id,
    })),
  };

  // DX-146 / Phase 2: every freshly-created card gets exactly one
  // `created` history entry. Empty `dispatchId` falls back to the bare
  // `unknown` actor and emits a `system_errors` event (same contract
  // as the save path's actor resolution — both go through
  // `resolveDispatchActor`). Append happens BEFORE the first
  // writeFileSync so the entry rides on disk from the very first
  // persisted byte.
  const actor = resolveDispatchActor(dispatchId, "create", deps);
  const stamped: Issue = {
    ...partiallyStamped,
    history: appendHistory(partiallyStamped.history, {
      timestamp: new Date().toISOString(),
      actor,
      event: "created",
      to: partiallyStamped.status,
    }),
  };

  ensureIssuesDirs(repo.localPath);
  // Filename = internal id, NOT external_id. external_id is just one of
  // the values stored inside the YAML.
  const targetPath = issuePath(repo.localPath, draft.id, "open");
  writeFileSync(targetPath, serializeIssue(stamped));
  if (sourcePath !== targetPath && existsSync(sourcePath)) {
    unlinkSync(sourcePath);
  }

  // Seed the diff cache AFTER `writeFileSync` so a failed persist does
  // not leave the cache holding a snapshot of an issue that does not
  // exist on disk. The cache is the next save's reference state — any
  // divergence between cache and on-disk YAML is a correctness hazard.
  lastSeenIssueState.set(stamped.id, {
    status: stamped.status,
    waiting_on: stamped.waiting_on,
  });

  json(res, 200, {
    created: true,
    id: draft.id,
    external_id: result.external_id,
  });
}

/**
 * Defense-in-depth normalizer. Forces `status: "ToDo"` whenever the input
 * Issue carries a non-null `waiting_on` record. Returns the original issue
 * unchanged when `waiting_on === null` or `status` is already ToDo, so the
 * no-op path doesn't allocate.
 *
 * **Load-bearing enforcement of this invariant lives in the parser.**
 * `validateIssue` in `src/issue-tracker/yaml.ts` rejects any YAML with
 * `waiting_on != null && status !== "ToDo"` (DX-212). Every `parseIssue`
 * caller — `syncTrackedIssueOnComplete`, the poller's heal pass, the
 * dashboard reader, the retry queue — therefore refuses the bad shape on
 * read. This helper only matters for in-memory `Issue` values constructed
 * WITHOUT going through `parseIssue` (test fixtures, future programmatic
 * builders). On the auto-sync path here, `parseIssue` at line ~898 throws
 * before this helper would ever see a non-compliant shape, so the helper
 * is a no-op in production. Kept for two reasons: (a) defense-in-depth
 * against a future caller that constructs an Issue programmatically and
 * forgets the pairing, (b) the existing test surface invokes it directly.
 *
 * Historical note (pre-DX-212): this WAS the load-bearing enforcement.
 * The `auto-sync.ts` `trigger === "trello"` gate meant non-Trello
 * dispatches skipped this normalization entirely, leaving
 * `status: In Progress + waiting_on: {…}` on disk indefinitely. Promoting
 * the invariant into the parser closed that gap structurally.
 */
export function forceWaitingOnToToDo(issue: Issue): Issue {
  if (issue.waiting_on === null) return issue;
  if (issue.status === "ToDo" && issue.blocked === null) return issue;
  // waiting_on overrides any self-block + Blocked status — the card is
  // queued behind deps, not self-blocked. Clear `blocked` along with the
  // status flip so the v4 invariant `status === "Blocked" ⟺ blocked !== null`
  // holds post-normalization.
  return { ...issue, status: "ToDo", blocked: null };
}

/**
 * Look in `open/` first, then `closed/`. Returns null when neither exists.
 * Lookup key is the issue's internal `id` (the on-disk filename basename),
 * not the external_id.
 */
function locateIssueFile(repoLocalPath: string, id: string): string | null {
  const open = issuePath(repoLocalPath, id, "open");
  if (existsSync(open)) return open;
  const closed = issuePath(repoLocalPath, id, "closed");
  if (existsSync(closed)) return closed;
  return null;
}

/**
 * Run the post-completion tracker sync synchronously from inside the
 * worker. Used by `handleStop` for `danxbot_complete` auto-sync — the
 * dispatch is already terminating, so the worker fires + awaits the
 * sync directly. Validation failures are recorded via `recordError`;
 * tracker errors are swallowed (same contract as the async path).
 *
 * DX-157 made this the SOLE entry point for the tracker push triggered
 * by an agent's terminal save: the legacy agent-facing save HTTP route
 * was retired, and the chokidar watcher (`src/db/issues-mirror.ts`)
 * now mirrors agent-driven YAML edits to the DB on every file event.
 * The poller's per-tick mirror handles the eventual outbound tracker
 * push; this helper is the immediate-push safety net so the dashboard
 * sees the final tracker state without waiting up to ~30-60s for the
 * next poll.
 *
 * Returns `{ ok, errors }` so the caller can log validation failures
 * without forcing them into the response body of an unrelated handler.
 */
export async function syncTrackedIssueOnComplete(
  dispatchId: string,
  repo: RepoContext,
  id: string,
  override?: IssueRouteDeps,
): Promise<{ ok: boolean; errors: string[] }> {
  const deps = getDeps(repo, override);
  const sourcePath = locateIssueFile(repo.localPath, id);
  if (!sourcePath) {
    return {
      ok: false,
      errors: [`No YAML file found at .danxbot/issues/{open,closed}/${id}.yml`],
    };
  }

  let issue: Issue;
  try {
    issue = parseIssue(readFileSync(sourcePath, "utf-8"), {
      expectedPrefix: repo.issuePrefix,
    });
  } catch (err) {
    const msg = err instanceof IssueParseError ? err.message : String(err);
    await deps.recordError?.(
      dispatchId,
      `danxbot_complete auto-sync validation failure: ${msg}`,
    );
    return { ok: false, errors: [msg] };
  }

  // Worker contract: `waiting_on != null` ALWAYS forces `status:
  // "ToDo"`. Agents set the waiting_on record only — they don't
  // separately move status, and a stray `Blocked` / `Done` paired with
  // a non-null waiting_on is a category error we silently normalize.
  // The poller's dispatch gate then skips the card while every blocker
  // in `by[]` is non-terminal. See `forceWaitingOnToToDo`.
  issue = forceWaitingOnToToDo(issue);

  // DX-146 / Phase 2: diff append. The auto-sync triggered by
  // `danxbot_complete` is a save event from history's perspective —
  // flipping a phase to Done by walking off mints the status_change
  // entry that pairs with the cache-seeded create state.
  issue = applyHistoryDiff(issue, dispatchId, deps);

  // Skip the tracker push entirely when no external_id is set (memory
  // tracker, drafts that never made it to create). Persist the local
  // file so terminal-status moves still happen.
  if (!issue.external_id) {
    await chainOnIssueLock(issue.id, async () => {
      persistAfterSync(repo.localPath, issue);
    });
    return { ok: true, errors: [] };
  }

  // Wait on the per-issue mutex so we don't race a concurrent
  // chain-scheduled task. The agent is shutting down here, so we await
  // the tracker push synchronously (the async branch is gone — DX-157).
  await chainOnIssueLock(issue.id, () =>
    runSync(deps, dispatchId, repo, issue),
  );
  return { ok: true, errors: [] };
}
