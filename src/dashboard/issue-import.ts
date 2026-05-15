/**
 * DX-519 — Copy / Paste issue cards across dashboards.
 *
 * Two responsibilities:
 *
 *  1. `buildIssueSubtreePayload` — walk `children[]` from a root issue,
 *     read every YAML in the hierarchy, strip repo-specific bits, and
 *     return a self-contained `IssueCopyPayload`. The dashboard's Copy
 *     button calls this through `GET /api/issues/:id/subtree` and writes
 *     the JSON result to the clipboard via `navigator.clipboard`.
 *
 *  2. `applyIssueImport` — accept an `IssueCopyPayload`, allocate fresh
 *     `<TARGET-PREFIX>-N` ids for every issue, rewrite every internal
 *     reference (`parent_id`, `children[]`, `waiting_on.by[]`,
 *     `conflict_on[].id`, `retro.action_item_ids[]`) to point at the
 *     new ids, drop references outside the payload, and atomically
 *     write every YAML or none. The dashboard's Paste affordance calls
 *     this through `POST /api/issues/import`.
 *
 * Cross-dashboard portability — the payload carries no `external_id`,
 * no tracker-specific bits, no absolute paths. Pasting into a different
 * connected repo's dashboard works the same as pasting into the same
 * one; each issue gets allocated against the target repo's id sequence.
 *
 * Atomicity — every imported issue is serialized + parsed BEFORE any
 * disk write. The write phase records every successful destination
 * path; if any later write fails, every prior destination is unlinked
 * so a partial import never lands. `IssuePatchError(500)` propagates
 * to the route with the underlying message.
 *
 * Lock sharing — id allocation runs under the same per-repo create
 * mutex `issue-write.ts` uses for `POST /api/issues`. Without sharing
 * the lock, an import + a concurrent create would both read `max(N)`
 * from disk and stomp each other.
 *
 * References outside the payload — for `parent_id`, `children[]`,
 * `waiting_on.by[]`, `conflict_on[].id`, and `retro.action_item_ids[]`,
 * any id NOT present in the payload's `issues[]` is dropped (or set to
 * null for the scalar `parent_id`). The card description allows
 * keeping `retro.action_item_ids[]` verbatim, but parseIssue's
 * target-prefix regex would reject foreign-prefix ids in a cross-
 * prefix paste — drop is the only validation-safe choice.
 *
 * `waiting_on` collapses to `null` when every id in `by[]` is dropped
 * (the schema invariant requires `by[]` non-empty).
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { requireUser } from "./auth-middleware.js";
import { eventBus } from "./event-bus.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import {
  KNOWN_SCHEMA_MAX,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import { maxIssueNumber } from "../issue-tracker/id-generator.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import type {
  ConflictOnEntry,
  Issue,
  IssueComment,
  IssueCopyPayload,
} from "../issue-tracker/interface.js";
import {
  IssuePatchError,
  withPerRepoCreateLock,
  writeIssueYamlAtomic,
} from "./issue-write.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

const log = createLogger("issue-import");

const ID_SHAPE = /^[A-Z]{2,4}-\d+$/;

/**
 * Walk `children[]` from `rootId`, read every YAML in the open subtree,
 * strip repo-specific bits, and return a self-contained payload ready
 * for clipboard transport.
 *
 * Read order — root first, then BFS over `children[]`. Each YAML's
 * `parent_id` and `children[]` are preserved verbatim (source ids); the
 * paste-side import handler rewrites them to the new id-space. Cycle
 * defense: a visited set prevents an erroneous parent→child→parent
 * loop from infinite-recursing; the second visit is silently skipped.
 *
 * Read failures abort with `IssuePatchError(500)` carrying the offending
 * id — a partial subtree is never returned. The CLOSED-state YAMLs are
 * NOT walked: a copy of a card whose descendants are already closed
 * lands as a recursively-collapsed payload, the operator pastes the
 * remaining open subtree. This matches operator expectation — copy of
 * an "in progress" epic should not pull in cards already retired.
 */
export function buildIssueSubtreePayload(
  repoLocalPath: string,
  rootId: string,
  expectedPrefix: string,
): IssueCopyPayload {
  const visited = new Set<string>();
  const out: Issue[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const openPath = issuePath(repoLocalPath, id, "open");
    if (!existsSync(openPath)) {
      // Root missing → 404 surfaced by the route handler. A missing
      // CHILD mid-walk is treated the same way: a copy must be a
      // coherent snapshot, not a half-broken subtree with dangling
      // children[] references.
      throw new IssuePatchError(404, {
        error:
          out.length === 0
            ? `Issue "${id}" not found in open/`
            : `Descendant "${id}" of "${rootId}" not found in open/ — subtree is incoherent`,
      });
    }
    let issue: Issue;
    try {
      const text = readFileSync(openPath, "utf-8");
      issue = parseIssue(text, { expectedPrefix });
    } catch (err) {
      throw new IssuePatchError(500, {
        error: `On-disk YAML for ${id} is malformed: ${(err as Error).message}`,
      });
    }
    out.push(stripIssueForCopy(issue));
    for (const childId of issue.children) {
      if (!visited.has(childId)) queue.push(childId);
    }
  }
  return { schema_version: 9, issues: out };
}

/**
 * Strip a source-repo Issue down to the repo-agnostic shape carried by
 * the clipboard payload. Wipes:
 *
 *  - `external_id` → "" (no tracker presence on the new card)
 *  - `tracker` → "memory" (worker re-derives on first sync)
 *  - `dispatch` → null (no agent runs on the freshly-pasted card)
 *  - `triage` → empty (re-triages on next poll)
 *  - `history` → [] (source's audit log doesn't carry semantics on the
 *    duplicated card)
 *  - `assigned_agent` → null (target repo's agent roster is unrelated
 *    to the source's)
 *  - `position` → null (column-local ordering doesn't survive the move;
 *    pasted card lands at the bottom of its column)
 *  - `comments[].id` → absent (tracker-native ids reference the source's
 *    tracker; outbound sync treats id-less comments as new and re-posts
 *    them on the new card)
 *  - `ac[].check_item_id` → "" (worker re-allocates on next tracker push)
 *  - `labels` → undefined (transient tracker projection)
 *
 * Preserved verbatim:
 *
 *  - `status` (parent-rollup auto-corrects mismatches on next reconcile)
 *  - `type`, `title`, `description`, `priority`, `effort_level`
 *  - `blocked`, `waiting_on`, `requires_human` (operator duplicates the
 *    gates along with the work)
 *  - `retro` (good / bad / action_item_ids / commits)
 *  - `ac[].title`, `ac[].checked` (preserve operator-visible progress)
 *  - `comments[].author`, `comments[].timestamp`, `comments[].text`
 *  - `parent_id`, `children[]`, `conflict_on[]` — source ids, the
 *    paste side rewrites them
 *
 * Source id (`issue.id`) is preserved as the rewrite-map key — the
 * paste handler uses it to look up the new id when rewriting refs.
 */
function stripIssueForCopy(issue: Issue): Issue {
  const stripped: Issue = {
    schema_version: 9,
    tracker: "memory",
    id: issue.id,
    external_id: "",
    parent_id: issue.parent_id,
    children: [...issue.children],
    dispatch: null,
    status: issue.status,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: issue.ac.map((a) => ({
      check_item_id: "",
      title: a.title,
      checked: a.checked,
    })),
    comments: issue.comments.map((c): IssueComment => ({
      author: c.author,
      timestamp: c.timestamp,
      text: c.text,
      // id intentionally omitted — outbound sync treats id-less comments
      // as new and re-posts to the new card's tracker on next tick.
    })),
    retro: {
      good: issue.retro.good,
      bad: issue.retro.bad,
      action_item_ids: [...issue.retro.action_item_ids],
      commits: [...issue.retro.commits],
    },
    assigned_agent: null,
    waiting_on:
      issue.waiting_on === null
        ? null
        : {
            reason: issue.waiting_on.reason,
            timestamp: issue.waiting_on.timestamp,
            by: [...issue.waiting_on.by],
          },
    blocked:
      issue.blocked === null
        ? null
        : {
            reason: issue.blocked.reason,
            timestamp: issue.blocked.timestamp,
          },
    requires_human:
      issue.requires_human === null
        ? null
        : {
            reason: issue.requires_human.reason,
            steps: [...issue.requires_human.steps],
            set_by: issue.requires_human.set_by,
            set_at: issue.requires_human.set_at,
          },
    conflict_on: issue.conflict_on.map((c) => ({
      id: c.id,
      reason: c.reason,
    })),
    effort_level: issue.effort_level,
    history: [],
    db_updated_at: "",
  };
  return stripped;
}

/**
 * Shape-validate an incoming payload. The wire format is the JSON the
 * Copy side produced, so this validator is intentionally lenient on
 * unknown future fields (forward-compat — `parseIssue` drops them on
 * round-trip) but strict on the structural keys this module reads.
 *
 * Returns the payload typed as `IssueCopyPayload`; throws
 * `IssuePatchError(400)` with a specific error for any structural
 * problem.
 */
function validatePayloadShape(raw: unknown): IssueCopyPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new IssuePatchError(400, {
      error: "Body must be a JSON object",
    });
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.schema_version !== "number" ||
    !Number.isInteger(obj.schema_version) ||
    obj.schema_version < 3
  ) {
    throw new IssuePatchError(400, {
      error: `schema_version must be an integer >= 3 (got ${JSON.stringify(obj.schema_version)})`,
    });
  }
  if (obj.schema_version > KNOWN_SCHEMA_MAX) {
    // Future payload pasted into older dashboard — refuse rather than
    // silently truncating unknown fields. The operator should paste
    // into a matching-or-newer dashboard.
    throw new IssuePatchError(400, {
      error: `schema_version ${obj.schema_version} is newer than this dashboard's KNOWN_SCHEMA_MAX (${KNOWN_SCHEMA_MAX}) — upgrade the target before importing`,
    });
  }
  if (!Array.isArray(obj.issues) || obj.issues.length === 0) {
    throw new IssuePatchError(400, {
      error: "issues must be a non-empty array",
    });
  }
  // Duplicate-id reject — the rewrite phase uses `idMap.set(src.id, …)`
  // and would silently overwrite the first entry when two issues share
  // an id, producing one ghost card (allocated id, never referenced)
  // and one card whose refs land on the second writer. Fail-loud so
  // the operator fixes the payload before any disk write.
  const seenSourceIds = new Set<string>();
  for (let i = 0; i < obj.issues.length; i++) {
    const entry = obj.issues[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new IssuePatchError(400, {
        error: `issues[${i}] must be an Issue mapping`,
      });
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== "string" || !ID_SHAPE.test(rec.id)) {
      throw new IssuePatchError(400, {
        error: `issues[${i}].id must match <PREFIX>-N`,
      });
    }
    if (seenSourceIds.has(rec.id)) {
      throw new IssuePatchError(400, {
        error: `issues[${i}].id "${rec.id}" duplicates an earlier entry in the payload`,
      });
    }
    seenSourceIds.add(rec.id);
  }
  // Cast is safe — `parseIssue` round-trip in the apply phase will
  // catch any field-level drift the schema validator owns.
  return obj as unknown as IssueCopyPayload;
}

interface ImportResult {
  /** New id of the payload's first issue (the operator's copied root). */
  topId: string;
  /** Every freshly-imported issue, post-rewrite. */
  issues: Issue[];
}

/**
 * Core import path. Acquires the per-repo create mutex (shared with
 * `POST /api/issues`), allocates fresh ids, rewrites refs, validates
 * every Issue via parseIssue, atomically writes every YAML or none,
 * and publishes one `issue:updated` SSE event per new card.
 *
 * Returns `{topId, issues}` so the caller can open the drawer on the
 * new top-level card.
 */
export async function applyIssueImport(
  repoName: string,
  repoLocalPath: string,
  rawBody: unknown,
): Promise<ImportResult> {
  const payload = validatePayloadShape(rawBody);
  const expectedPrefix = loadIssuePrefix(repoLocalPath);
  const issuesRoot = resolve(repoLocalPath, ".danxbot", "issues");

  return withPerRepoCreateLock(repoLocalPath, async () => {
    // Phase 1 — allocate fresh ids in payload order. We hold the
    // per-repo create lock (taken at function entry), so the disk
    // counter cannot move under us; one `maxIssueNumber` read then
    // an in-memory bump per allocation is sufficient. Bumping
    // in-memory (vs re-reading) also avoids the per-iteration
    // `readdir` cost that `nextIssueId` would impose.
    const idMap = new Map<string, string>();
    let nextN = await maxIssueNumber(issuesRoot, expectedPrefix);
    for (const src of payload.issues) {
      nextN += 1;
      idMap.set(src.id, `${expectedPrefix}-${nextN}`);
    }

    // Phase 2 — rewrite refs in memory, serialize each Issue, and
    // parseIssue round-trip every one against the target prefix.
    // Any validation failure here happens BEFORE any disk write.
    const rewritten: Issue[] = [];
    const serialized: string[] = [];
    const targets: string[] = [];
    for (const src of payload.issues) {
      const newId = idMap.get(src.id)!;
      const issue = rewriteForImport(src, newId, idMap);
      const yamlText = serializeIssue(issue);
      let parsed: Issue;
      try {
        parsed = parseIssue(yamlText, { expectedPrefix });
      } catch (err) {
        throw new IssuePatchError(400, {
          error: `Imported issue "${src.id}" produced invalid YAML after rewrite: ${(err as Error).message}`,
        });
      }
      rewritten.push(parsed);
      serialized.push(yamlText);
      targets.push(issuePath(repoLocalPath, newId, "open"));
    }

    // Phase 3 — atomic write. Track every destination we wrote so a
    // mid-loop failure can roll back. `writeIssueYamlAtomic` already
    // cleans up the per-file `.tmp` residue on its own; the rollback
    // below handles the destinations that succeeded BEFORE the
    // failure.
    ensureIssuesDirs(repoLocalPath);
    const written: string[] = [];
    try {
      for (let i = 0; i < serialized.length; i++) {
        writeIssueYamlAtomic(targets[i], serialized[i], rewritten[i].id);
        written.push(targets[i]);
      }
    } catch (err) {
      for (const path of written) {
        try {
          unlinkSync(path);
        } catch (rollbackErr) {
          // Best-effort — the operator surface already shows the
          // primary import failure. Logging keeps the partial residue
          // observable so the next reconcile can clean up if needed.
          log.warn(
            `Import rollback failed to unlink ${path}: ${(rollbackErr as Error).message}`,
          );
        }
      }
      throw err;
    }

    // Phase 4 — fan out SSE so every connected dashboard sees the new
    // cards without a manual refetch. The watcher mirror will fire
    // the same topic when chokidar catches the disk writes; SSE
    // subscribers must already be idempotent per DX-236.
    for (const issue of rewritten) {
      eventBus.publish({
        topic: "issue:updated",
        data: { repoName, id: issue.id, issue },
      });
    }

    return {
      topId: rewritten[0].id,
      issues: rewritten,
    };
  });
}

/**
 * Rewrite a (possibly unstripped) source Issue for import into the
 * target repo. Defensively re-strips every repo-specific field — the
 * Copy side's `stripIssueForCopy` already handled this, but a payload
 * pasted from a hand-edited JSON file or a third-party tool may carry
 * leaked fields. Belt-and-suspenders so the trust boundary is the
 * import handler, not the producer.
 *
 *  - `id` → newly allocated `<TARGET-PREFIX>-N`
 *  - `parent_id` → mapped via idMap, or `null` if not in payload
 *  - `children[]` → mapped via idMap, drop entries not in payload
 *  - `waiting_on.by[]` → mapped via idMap, drop entries not in
 *    payload. If `by[]` empties, set `waiting_on: null` (schema
 *    invariant requires non-empty `by[]`).
 *  - `conflict_on[].id` → mapped via idMap, drop entries not in
 *    payload (orphan mutex would never auto-resolve in the target
 *    repo)
 *  - `retro.action_item_ids[]` → mapped via idMap, drop entries not
 *    in payload. (Card description allows verbatim retention but
 *    `parseIssue` validates these against the target prefix, so
 *    cross-prefix verbatim retention would 400 — drop is the only
 *    validation-safe call. The operator re-files the dropped action
 *    items by hand if needed.)
 *  - Repo-specific bits forcibly reset regardless of source value:
 *    `external_id: ""`, `tracker: "memory"`, `dispatch: null`,
 *    `assigned_agent: null`, `position: null`, `history: []`,
 *    `triage: emptyTriage`, `ac[].check_item_id: ""`, `comments[].id`
 *    dropped, `labels` undefined.
 */
function rewriteForImport(
  src: Issue,
  newId: string,
  idMap: Map<string, string>,
): Issue {
  const mapId = (id: string): string | null => idMap.get(id) ?? null;

  const newParentId = src.parent_id === null ? null : mapId(src.parent_id);

  const newChildren = src.children
    .map((c) => mapId(c))
    .filter((c): c is string => c !== null);

  let newWaitingOn = src.waiting_on;
  if (newWaitingOn !== null) {
    const mappedBy = newWaitingOn.by
      .map((b) => mapId(b))
      .filter((b): b is string => b !== null);
    if (mappedBy.length === 0) {
      newWaitingOn = null;
    } else {
      newWaitingOn = {
        reason: newWaitingOn.reason,
        timestamp: newWaitingOn.timestamp,
        by: mappedBy,
      };
    }
  }

  const newConflictOn: ConflictOnEntry[] = [];
  for (const c of src.conflict_on) {
    const mapped = mapId(c.id);
    if (mapped === null) continue;
    newConflictOn.push({ id: mapped, reason: c.reason });
  }

  const newActionItemIds = src.retro.action_item_ids
    .map((id) => mapId(id))
    .filter((id): id is string => id !== null);

  return {
    schema_version: 9,
    tracker: "memory",
    id: newId,
    external_id: "",
    parent_id: newParentId,
    children: newChildren,
    dispatch: null,
    status: src.status,
    type: src.type,
    title: src.title,
    description: src.description,
    priority: src.priority,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: src.ac.map((a) => ({
      check_item_id: "",
      title: a.title,
      checked: a.checked,
    })),
    comments: src.comments.map((c): IssueComment => ({
      author: c.author,
      timestamp: c.timestamp,
      text: c.text,
    })),
    retro: {
      good: src.retro.good,
      bad: src.retro.bad,
      action_item_ids: newActionItemIds,
      commits: [...src.retro.commits],
    },
    assigned_agent: null,
    waiting_on: newWaitingOn,
    blocked:
      src.blocked === null
        ? null
        : {
            reason: src.blocked.reason,
            timestamp: src.blocked.timestamp,
          },
    requires_human:
      src.requires_human === null
        ? null
        : {
            reason: src.requires_human.reason,
            steps: [...src.requires_human.steps],
            set_by: src.requires_human.set_by,
            set_at: src.requires_human.set_at,
          },
    conflict_on: newConflictOn,
    effort_level: src.effort_level,
    history: [],
    db_updated_at: "",
  };
}

/**
 * `GET /api/issues/:id/subtree?repo=<name>` — auth-gated read of the
 * root + descendant subtree, stripped to clipboard-ready shape.
 *
 * The route handler's own `requireUser` produces the 401 (matched
 * ahead of the blanket /api/* gate in `server.ts` for the same
 * reason `PATCH /api/issues/:id` is — both routes need the user's
 * identity for an audit-adjacent operation; subtree reads don't
 * record the username but keep the auth band consistent with the
 * write counterpart `POST /api/issues/import`).
 */
export async function handleGetIssueSubtree(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  if (!repoQuery) {
    json(res, 400, { error: "Missing required query param: repo" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoQuery);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoQuery}" is not configured` });
    return;
  }
  try {
    const expectedPrefix = loadIssuePrefix(repo.localPath);
    const payload = buildIssueSubtreePayload(repo.localPath, id, expectedPrefix);
    json(res, 200, payload);
  } catch (err) {
    if (err instanceof IssuePatchError) {
      json(res, err.status, err.body);
      return;
    }
    log.error(`handleGetIssueSubtree(${repo.name}, ${id}) failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to build subtree",
    });
  }
}

/**
 * `POST /api/issues/import?repo=<name>` — auth-gated paste handler.
 * Receives an `IssueCopyPayload`, allocates fresh ids, atomically
 * writes every YAML, returns `{topId, issues[]}` so the SPA can open
 * the drawer on the new top-level card.
 *
 * Auth — per-user bearer (NOT the dispatch token). Same band as the
 * other dashboard write routes (`PATCH /api/issues/:id`,
 * `POST /api/issues`). Matched ahead of the blanket /api/* gate so
 * the handler's own `requireUser` produces the 401.
 */
export async function handleImportIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  if (!repoQuery) {
    json(res, 400, { error: "Missing required query param: repo" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoQuery);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoQuery}" is not configured` });
    return;
  }
  let body: unknown;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  try {
    const result = await applyIssueImport(repo.name, repo.localPath, body);
    json(res, 200, result);
  } catch (err) {
    if (err instanceof IssuePatchError) {
      json(res, err.status, err.body);
      return;
    }
    log.error(`handleImportIssues(${repo.name}) failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to import issues",
    });
  }
}
