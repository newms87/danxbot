/**
 * Pure helpers for the per-issue YAML lifecycle on disk. Phase 2 of the
 * tracker-agnostic-agents epic (Trello ZDb7FOGO + parent k8kZjI5c).
 *
 * Everything here is fs-only + tracker-only — no `config.js` import, no
 * logger, no env-var reads. Test files can import this module without
 * paying the env-validation tax that pulling `src/cron/sync-and-audit.ts` does
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
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  appendHistory,
  createEmptyIssue,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../issue-tracker/yaml.js";
import {
  dbSelectIssueById,
  dbSelectIssueByExternalId,
} from "./issues-db.js";
import { repoNameFromPath } from "./repo-name.js";
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
import { parse as parseYamlText } from "yaml";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { getMirrorByLocalPath } from "../db/issues-mirror.js";
import { createLogger } from "../logger.js";

const writeIssueLog = createLogger("write-issue");
/**
 * `awaitMirror`'s read-your-writes budget. MUST exceed
 * `DEFAULT_AWAIT_WRITE_FINISH.stabilityThreshold` in
 * `src/db/issues-mirror.ts` (currently 5s) by enough margin to cover the
 * post-debounce chain — chokidar `change` emit → `processFileEvent` →
 * `parseYamlText` + canonicalize + hash → `upsert` → `resolvePending`.
 *
 * Equal values produced a tight race that the reject path consistently
 * won under write-bursts (boot reattach clearing 3-6 stale dispatches in
 * one shot), surfacing as `awaitMirror timed out for danxbot/<ID> — DB
 * will catch up via reconcile` warns even though the upsert landed a few
 * ms later. 3s margin is generous enough that a slow disk or load spike
 * doesn't tip the race back; not so generous that a genuinely-dropped
 * chokidar event leaves callers blocked for a noticeable interval.
 */
const WRITE_ISSUE_AWAIT_TIMEOUT_MS = 8_000;

/**
 * Read the issue identified by `id`. Returns null when no row exists.
 *
 * Phase 4 (DX-155) — DB-backed: queries the `issues` table by
 * `(repo_name, id)`. Open / closed status is a column, not a directory:
 * a Done / Cancelled card whose YAML lives in `closed/` is still
 * findable. The `prefix` argument is unused under SQL (every card in a
 * repo carries the same prefix; the `repo_name` filter is sufficient)
 * but kept for caller compatibility. The mirror canonicalizes parsed
 * YAML before storing, so the returned `Issue` has already been
 * structurally validated through the strict schema at write time —
 * the previous YAML-walk's `parseIssue` validation ran on every read,
 * which was redundant work.
 */
export async function loadLocal(
  repoLocalPath: string,
  id: string,
  _prefix: string,
): Promise<Issue | null> {
  const repoName = repoNameFromPath(repoLocalPath);
  return dbSelectIssueById(repoName, id);
}

/**
 * Disk-backed counterpart to `loadLocal`. Reads `open/<id>.yml`
 * directly via the file system and `parseIssue`s the bytes — no DB
 * round-trip, no mirror dependency.
 *
 * Cleanup paths that fire IMMEDIATELY after a `writeIssue` (especially
 * `stampDispatchAndWrite` followed by a synchronous `dispatch()`
 * throw) MUST use this helper rather than `loadLocal`. `writeIssue`'s
 * mirror ack uses an 8-second `awaitMirror` timeout that frequently
 * lapses under chokidar pressure; when it does, `loadLocal` returns
 * the PRE-write DB shape, the cleanup's `if (fresh.dispatch !== null)`
 * guard evaluates false, the clear is skipped, and the orphan
 * `dispatch{pid:0}` block lives on disk forever — the symptom that
 * stuck the poller in DX-284.
 *
 * Returns `null` when the file is missing (card moved to `closed/`,
 * was renamed, was never written). The caller treats null as "card
 * not in the open bucket, nothing to clear here."
 */
export function loadLocalFromDisk(
  repoLocalPath: string,
  id: string,
  prefix: string,
): Issue | null {
  const path = issuePath(repoLocalPath, id, "open");
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return parseIssue(text, { expectedPrefix: prefix });
  } catch {
    return null;
  }
}

/**
 * Look up an issue by its tracker-native `external_id`. Returns null
 * when no row carries the supplied id (or when `externalId` is empty).
 *
 * Phase 4 (DX-155) — DB-backed: queries the `issues` table by
 * `(repo_name, external_id)`. The previous YAML-walk's prefix-agnostic
 * scan over `open/` + `closed/` is redundant under SQL — a single
 * indexed predicate over the full `issues` row set replaces it.
 */
export async function findByExternalId(
  repoLocalPath: string,
  externalId: string,
): Promise<Issue | null> {
  if (!externalId) return null;
  const repoName = repoNameFromPath(repoLocalPath);
  return dbSelectIssueByExternalId(repoName, externalId);
}

/**
 * Write the issue to `<repo>/.danxbot/issues/open/<id>.yml`. Always writes
 * to `open/` — the move to `closed/` happens via `moveToClosedIfTerminal`
 * (called by `persistAfterSync` in the worker's auto-sync path) when the
 * status reaches Done or Cancelled.
 *
 * Read-your-writes integration (DX-154): after `writeFileSync`, looks up
 * the registered mirror for this repoLocalPath via
 * `getMirrorByLocalPath`. If a mirror is active, awaits its
 * `awaitMirror(repoName, id, contentHash)` with a 5-second timeout.
 * Timeout logs a warning and returns successfully — the file IS on disk,
 * the periodic reconcile + boot scan will catch the DB up. If no mirror
 * is active (unit tests, dashboard mode, pre-Phase-4 paths), returns
 * immediately after the file write — that's the legacy file-only
 * behavior.
 *
 * The async signature applies even on the legacy path so callers don't
 * need to branch on whether the mirror is active. Phase 4+ readers
 * depend on the post-await guarantee that the DB reflects the just-
 * written hash.
 */
export function writeIssue(
  repoLocalPath: string,
  issue: Issue,
): Promise<void> {
  // SYNC PHASE: file write throws synchronously. Callers wrapping
  // `writeIssue(...)` in try/catch for fs errors keep working — the
  // body before the first `return await` runs synchronously, and any
  // throw from `writeFileSync` propagates up the stack as a sync error
  // (NOT as a rejected promise).
  ensureIssuesDirs(repoLocalPath);
  const path = issuePath(repoLocalPath, issue.id, "open");
  const serialized = serializeIssue(issue);
  writeFileSync(path, serialized);

  // ASYNC PHASE: await the mirror's read-your-writes ack. Best-effort —
  // the file is on disk regardless. Wrapped in a helper so the sync
  // throw above can't be converted to a rejected promise by the
  // surrounding async wrapper.
  return awaitMirrorRoundtrip(repoLocalPath, issue, serialized);
}

async function awaitMirrorRoundtrip(
  repoLocalPath: string,
  issue: Issue,
  serialized: string,
): Promise<void> {
  const mirror = getMirrorByLocalPath(repoLocalPath);
  if (!mirror) return;

  // The mirror canonicalizes parsed YAML data, not raw text. Round-trip
  // through `yaml.parse` once so the writer's hash exactly matches what
  // the watcher will compute on the same file.
  let parsed: unknown;
  try {
    parsed = parseYamlText(serialized);
  } catch {
    // Should never happen — we just serialized through `serializeIssue`.
    // If the round-trip parse fails, the mirror's awaitMirror would never
    // resolve anyway; bail out and let reconcile catch up.
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const contentHash = sha256(canonicalize(parsed));
  try {
    await mirror.awaitMirror(mirror.repoName, issue.id, contentHash, {
      timeoutMs: WRITE_ISSUE_AWAIT_TIMEOUT_MS,
    });
  } catch (err) {
    // Best-effort by design — surface the timeout as a warning without
    // failing the write. Reconcile will pick up the drift on the next
    // tick.
    writeIssueLog.warn(
      `awaitMirror timed out for ${mirror.repoName}/${issue.id} — DB will catch up via reconcile`,
      err,
    );
  }
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
  prefix: string,
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

  // DX-147: stamp exactly one `tracker:<name>` `created` entry on a
  // freshly-hydrated issue. Actor uses the dynamic `issue.tracker`
  // value (e.g. `tracker:trello`, `tracker:memory`) so the audit log
  // accurately attributes the source. `hydrateFromRemote` is the SOLE
  // entry point for the `created` event — the bulk-sync caller in
  // `src/cron/sync-and-audit.ts#bulkSyncMissingYamls` skips cards that already
  // have a local YAML via `findByExternalId`, so this function only
  // ever runs against a tracker-born card with no prior local state.
  // Tracker implementations (`MemoryTracker`, `TrelloTracker`) always
  // return `history: []` on `getCard` — history is local-only audit.
  // That's why no idempotency guard is needed here: the candidate's
  // history is always empty, and re-hydration of an existing card
  // never happens.
  return {
    ...validated.issue,
    history: appendHistory(validated.issue.history, {
      timestamp: new Date().toISOString(),
      actor: `tracker:${validated.issue.tracker}`,
      event: "created",
      to: validated.issue.status,
      note: `Hydrated from tracker external_id ${externalId}`,
    }),
  };
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
): Promise<Issue> {
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
  // writeIssue's SYNC phase runs sync — any fs throw propagates from
  // this call directly into the caller's stack frame, preserving the
  // pre-DX-154 try/catch semantics. The returned Promise resolves once
  // the mirror's read-your-writes ack lands (or its 5s timeout fires).
  return writeIssue(repoLocalPath, updated).then(() => updated);
}

/**
 * Overwrite `assigned_agent` on an existing local Issue and persist
 * the change. Returns the updated Issue. Used by the multi-worker pick
 * algorithm (DX-200 / multi-worker dispatch epic DX-158 Phase 5)
 * BEFORE dispatch so the YAML mirror surfaces the persona claim to the
 * dashboard's per-card chat tab and to the next tick's
 * `assignedCards()` lookup.
 *
 * `agentName` MUST match `AGENT_NAME_SHAPE` (defended at write time by
 * `validateIssue` — passing a malformed name throws on the first read
 * back through `parseIssue` + the chokidar mirror flips the row to
 * `_malformed: true`). Pass `null` to clear a previous claim (the
 * poller does this when an agent's worktree has been torn down or the
 * operator deleted the agent record).
 *
 * No-op when the value is already what was requested — preserves the
 * existing pattern used by `clearDispatchAndWrite` and avoids spurious
 * mirror writes that would re-assert the same content hash.
 */
/**
 * Overwrite `status` on an existing local Issue and persist. Returns
 * the updated Issue. Used by `dispatch()` to flip ToDo → In Progress
 * BEFORE spawning an agent on a work dispatch (DX — auto-flip epic) so
 * the YAML / dashboard / tracker reflect the assignment the moment the
 * agent begins. Revert path uses the same helper to roll back to the
 * prior status when spawnAgent throws before the agent reaches a
 * terminal state.
 *
 * No-op when the value is already what was requested.
 */
export function stampStatusAndWrite(
  repoLocalPath: string,
  issue: Issue,
  status: Issue["status"],
): Promise<Issue> {
  if (issue.status === status) return Promise.resolve(issue);
  const updated: Issue = { ...issue, status };
  return writeIssue(repoLocalPath, updated).then(() => updated);
}

export function stampAssignedAgentAndWrite(
  repoLocalPath: string,
  issue: Issue,
  agentName: string | null,
): Promise<Issue> {
  if (issue.assigned_agent === agentName) return Promise.resolve(issue);
  const updated: Issue = { ...issue, assigned_agent: agentName };
  return writeIssue(repoLocalPath, updated).then(() => updated);
}

/**
 * Clear `dispatch` on an existing local Issue and persist the change.
 * Returns the updated Issue. Used on the dispatch-end path:
 *
 *   - Worker `persistAfterSync` clears whenever the saved status is
 *     terminal-for-session (Done / Cancelled / Needs Help / Needs
 *     Approval) or when `waiting_on != null`. The agent's session is
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
 * `assigned_agent` is PRESERVED — it records who last owned the card
 * and is durable across dispatch end + terminal save. The old
 * co-ownership invariant `(dispatch != null) ⇔ (assigned_agent != null)`
 * is retired: `assigned_agent` is now persistent audit, only cleared
 * when the agent is removed from the repo's roster (handled in
 * `multi-agent-pick.ts` orphan-roster guard + agent-delete flow).
 *
 * Same-agent re-claim still works: `pickCardForAgent` allows a card
 * whose `assigned_agent` matches the picking agent. Other-agent
 * exclusion is unchanged.
 *
 * No-op when `dispatch` is already null (returns the input unchanged
 * AND skips the write).
 */
export function clearDispatchAndWrite(
  repoLocalPath: string,
  issue: Issue,
): Promise<Issue> {
  if (issue.dispatch === null) {
    return Promise.resolve(issue);
  }
  const updated: Issue = { ...issue, dispatch: null };
  // Sync phase first — see `stampDispatchAndWrite` for the rationale.
  return writeIssue(repoLocalPath, updated).then(() => updated);
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
