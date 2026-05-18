/**
 * DX-631 (Phase 5 of DX-626 — Priority cascade) — backend cascade write
 * endpoint.
 *
 * `PATCH /api/issues/cascade?repo=<name>` — takes ONE drop from the
 * dashboard's epic-move dialog and persists trigger writes across N
 * descendant YAMLs (plus the parent epic) per the 5×5 spec table the
 * pure `cascadeEpicMove` helper (DX-630, Phase 4) encodes.
 *
 * Phase 4 owns the per-cell move policy (FROM tier × TO tier). Phase 5
 * owns only:
 *
 *   1. Validating the request body shape (epic_id, dest_list_name,
 *      unblock_confirmed, optional blocked_reason + overrides).
 *   2. Reading the epic + every descendant YAML (BFS-walk children[],
 *      depth-unbounded — nested epic-of-epics walks all levels).
 *   3. Resolving `dest_list_name` → `ListType` via lists.yaml.
 *   4. Sourcing `dispatchableByPriority` from the SAME picker helper the
 *      poller uses (`listDispatchableYamls`) — never duplicate the sort.
 *   5. Calling `cascadeEpicMove` and gating on its two pre-write outputs
 *      (`requiresUnblockConfirm` → 409, `blockedReasonRequired` → 400).
 *   6. Per-id locked, atomic temp+rename write of the trigger fields +
 *      synthetic raw `status` for each touched YAML so the v11
 *      status⟺blocked invariant survives a leftward-out-of-Blocked move.
 *   7. Publishing one `issue:updated` SSE event per touched id so the
 *      dashboard reducers update without refetch.
 *
 * No atomicity across files. Per user spec: "if it fails it fails, auto-
 * fix already built into the system." A mid-cascade worker crash leaves
 * partial state on disk; the per-card reconcile chain + tracker push
 * surface that to the operator on the next tick. The handler returns
 * `{updated, skipped}` so the SPA can render per-card transparency.
 *
 * `skipped[]` carries the descendant ids whose cascade action was
 * `kind: "stay"` (default-action terminal sources, blocked descendants
 * skipped without confirm, operator overrides to stay). Distinct from
 * `failed[]` which would carry per-card write errors — currently we
 * fail loud on the first write error (no `failed[]` field today) since
 * the only realistic write error inside a per-id mutex is a malformed
 * source YAML, which is a corruption signal, not a per-card transient.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { requireUser } from "./auth-middleware.js";
import { publishIssueUpsert } from "./publish-issue-update.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import type { Issue } from "../issue-tracker/interface.js";
import { LIST_TYPES, readLists, type ListType } from "../lists-file.js";
import {
  cascadeEpicMove,
  type CascadeAction,
  type CascadeMoveInput,
  type TriggerWrite,
} from "../issue/cascade-move.js";
import { rawStatusForListType } from "../issue/list-move.js";
import { deriveStatus } from "../issue/derive-status.js";
import { listDispatchableYamls } from "../poller/local-issues.js";
import {
  IssuePatchError,
  persistMutatedIssue,
  readIssueUnderLock,
  withPerIdLock,
} from "./issue-write.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

const log = createLogger("issue-write-cascade");

/**
 * Request body shape. Validated entry by entry BEFORE any disk read so a
 * malformed payload 400s without touching the filesystem.
 *
 *  - `epic_id` — the parent card being dropped. Need not be `type: Epic`;
 *    any card with non-empty `children[]` is a valid cascade root.
 *  - `dest_list_name` — operator's drop target. Resolved to a `ListType`
 *    via lists.yaml.
 *  - `unblock_confirmed` — set by the dialog when the operator confirms
 *    cascading across a blocked descendant. The cascade gates on this
 *    flag + the descendant's current `blocked` state.
 *  - `blocked_reason` — REQUIRED when `dest_list_name` resolves to type
 *    `blocked` (the parent is being moved INTO blocked).
 *  - `overrides` — per-descendant override keyed by `<PREFIX>-N`. Each
 *    override is one of `{kind: "stay"}` / `{kind: "move_same_type"}` /
 *    `{kind: "move_to", listType, listName}`. Bypasses the default-action
 *    spec table for that descendant only.
 */
export interface CascadeRequestBody {
  epic_id: string;
  dest_list_name: string;
  unblock_confirmed: boolean;
  blocked_reason?: string;
  overrides?: Record<string, CascadeAction>;
}

/**
 * Result echoed back to the caller (200 body).
 *
 *  - `updated[]` — ids whose YAML was written (parent + every moved
 *    descendant). Ordered: parent first, then descendants in BFS order.
 *  - `skipped[]` — descendant ids whose cascade action was `stay` (default
 *    terminal-source skip, blocked-without-confirm skip, operator
 *    stay-override). For operator transparency in the dashboard.
 */
export interface CascadeApplyResult {
  updated: string[];
  skipped: string[];
}

/**
 * Test-injectable dependencies. Production wires `listDispatchable` to
 * the picker helper (`listDispatchableYamls`); tests stub with a
 * deterministic Issue[] so the FIRST-DISPATCH spec cell's selection is
 * reproducible without standing up the chokidar mirror.
 */
export interface CascadeDeps {
  listDispatchable: (
    repoLocalPath: string,
    prefix: string,
  ) => Promise<Issue[]>;
}

const defaultDeps: CascadeDeps = {
  listDispatchable: listDispatchableYamls,
};

/**
 * Validate the body shape. Mirrors the per-field allowlist approach of
 * `validatePatchShape` in `issue-write.ts` — any unknown key 400s; any
 * malformed value 400s with a field-pointing message.
 */
function validateCascadeBody(body: unknown): CascadeRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IssuePatchError(400, { error: "Body must be a JSON object" });
  }
  const raw = body as Record<string, unknown>;
  const allowed = new Set([
    "epic_id",
    "dest_list_name",
    "unblock_confirmed",
    "blocked_reason",
    "overrides",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new IssuePatchError(400, {
        error: `Field not patchable: ${key}`,
      });
    }
  }
  if (typeof raw.epic_id !== "string" || !/^[A-Z]{2,4}-\d+$/.test(raw.epic_id)) {
    throw new IssuePatchError(400, {
      error: "epic_id must match <PREFIX>-N",
    });
  }
  if (typeof raw.dest_list_name !== "string" || raw.dest_list_name.length === 0) {
    throw new IssuePatchError(400, {
      error: "dest_list_name must be a non-empty string",
    });
  }
  if (typeof raw.unblock_confirmed !== "boolean") {
    throw new IssuePatchError(400, {
      error: "unblock_confirmed must be a boolean",
    });
  }
  let blockedReason: string | undefined;
  if (raw.blocked_reason !== undefined) {
    if (typeof raw.blocked_reason !== "string") {
      throw new IssuePatchError(400, {
        error: "blocked_reason must be a string when provided",
      });
    }
    blockedReason = raw.blocked_reason;
  }
  let overrides: Record<string, CascadeAction> | undefined;
  if (raw.overrides !== undefined) {
    if (!raw.overrides || typeof raw.overrides !== "object" || Array.isArray(raw.overrides)) {
      throw new IssuePatchError(400, {
        error: "overrides must be a mapping of <PREFIX>-N → action",
      });
    }
    overrides = {};
    for (const [id, action] of Object.entries(raw.overrides as Record<string, unknown>)) {
      if (!/^[A-Z]{2,4}-\d+$/.test(id)) {
        throw new IssuePatchError(400, {
          error: `overrides key "${id}" must match <PREFIX>-N`,
        });
      }
      overrides[id] = validateCascadeAction(id, action);
    }
  }
  return {
    epic_id: raw.epic_id,
    dest_list_name: raw.dest_list_name,
    unblock_confirmed: raw.unblock_confirmed,
    ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
  };
}

// `ListType` enumerates the seven canonical list types. Derive the
// validation set from the union's source-of-truth array so a future
// type addition (Phase 4+ schema bump) does not silently reject the
// new value here.
const VALID_LIST_TYPES: ReadonlySet<string> = new Set<string>(LIST_TYPES);

function validateCascadeAction(id: string, value: unknown): CascadeAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IssuePatchError(400, {
      error: `overrides["${id}"] must be a mapping with a "kind" field`,
    });
  }
  const v = value as Record<string, unknown>;
  if (v.kind === "stay") return { kind: "stay" };
  if (v.kind === "move_same_type") return { kind: "move_same_type" };
  if (v.kind === "move_to") {
    if (typeof v.listType !== "string" || !VALID_LIST_TYPES.has(v.listType)) {
      throw new IssuePatchError(400, {
        error: `overrides["${id}"].listType must be one of [${LIST_TYPES.join(", ")}]`,
      });
    }
    if (typeof v.listName !== "string" || v.listName.length === 0) {
      throw new IssuePatchError(400, {
        error: `overrides["${id}"].listName must be a non-empty string`,
      });
    }
    return { kind: "move_to", listType: v.listType as ListType, listName: v.listName };
  }
  throw new IssuePatchError(400, {
    error: `overrides["${id}"].kind must be one of [stay, move_same_type, move_to]`,
  });
}

/**
 * BFS-walk `children[]` from `rootId`, collecting every descendant Issue
 * in visit order. A child id that doesn't resolve to a file is skipped
 * silently — a half-deleted subtree is a normal mid-state (mirrors the
 * delete-cascade contract in `collectDescendants`).
 *
 * Malformed descendant YAMLs fail loud per the CLAUDE.md "Single
 * Canonical Schema — Fail Loud, No Legacy" contract: any YAML on disk
 * after the boot sweep that fails strict validation is a bug, not an
 * edge case. `readIssueUnderLock` already raises a 500 on parse failure;
 * we let it propagate so the cascade aborts with a precise error rather
 * than silently dropping a branch.
 */
function collectDescendantIssues(
  repoLocalPath: string,
  rootId: string,
  expectedPrefix: string,
): Issue[] {
  const visited = new Set<string>([rootId]);
  const out: Issue[] = [];
  const { current: rootIssue } = readIssueUnderLock(
    repoLocalPath,
    rootId,
    expectedPrefix,
  );
  const queue: string[] = [...rootIssue.children];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    try {
      const { current } = readIssueUnderLock(repoLocalPath, id, expectedPrefix);
      out.push(current);
      for (const childId of current.children) {
        if (!visited.has(childId)) queue.push(childId);
      }
    } catch (err) {
      // 404 on a child id — half-deleted subtree, expected. Skip without
      // raising so the cascade can still write the rest of the tree.
      // Other errors (500 from malformed YAML, anything else) propagate.
      if (err instanceof IssuePatchError && err.status === 404) continue;
      throw err;
    }
  }
  return out;
}

/**
 * Resolve a TriggerWrite + the operator's destination context to the
 * final destination `ListType` for status alignment.
 *
 *  - `move_to` override → use `override.listType` verbatim (operator
 *    explicitly picked a cross-type destination).
 *  - Every other moved descendant → `parentDestType` (move_same_type
 *    default-action and operator override both land on the parent's dest).
 */
function destTypeForChild(
  childId: string,
  overrides: Record<string, CascadeAction> | undefined,
  parentDestType: ListType,
): ListType {
  const override = overrides?.[childId];
  if (override && override.kind === "move_to") return override.listType;
  return parentDestType;
}

/**
 * Apply a TriggerWrite patch to an Issue and re-align the raw `status`
 * field to satisfy the v11 status⟺blocked invariant.
 *
 * Mirrors `applyListMove`'s approach: the lifecycle / gate fields are the
 * authoritative state; the raw `status` is a serializer round-trip
 * survivor that must agree with the derived value on read. We set it
 * explicitly from `destType` so a leftward-out-of-terminal move
 * (Done → ToDo via override) clears the rule-7 fallthrough.
 */
function applyTriggerWrite(
  issue: Issue,
  write: TriggerWrite,
  destType: ListType,
): Issue {
  const next: Issue = {
    ...issue,
    blocked: issue.blocked ? { ...issue.blocked } : null,
    dispatch: issue.dispatch ? { ...issue.dispatch } : null,
  };
  if (write.completed_at !== undefined) next.completed_at = write.completed_at;
  if (write.cancelled_at !== undefined) next.cancelled_at = write.cancelled_at;
  if (write.ready_at !== undefined) next.ready_at = write.ready_at;
  if (write.archived_at !== undefined) next.archived_at = write.archived_at;
  if (write.blocked !== undefined) {
    next.blocked = write.blocked === null ? null : { ...write.blocked };
  }
  if (write.list_name !== undefined) next.list_name = write.list_name;
  if (write.priority !== undefined) next.priority = write.priority;
  next.status = rawStatusForListType(destType);
  // Defense in depth: `dispatch` lingers on cards moved out of in_progress
  // via cascade because `triggerWritesForDest` doesn't touch it. Derived
  // status still computes correctly (terminal rules beat rule 4), but a
  // stale dispatch sidecar on a Done/Cancelled card misleads operators.
  // Clear it whenever the dest is terminal so the YAML reflects the
  // operator's intent.
  if (destType === "completed" || destType === "cancelled") {
    next.dispatch = null;
  }
  return next;
}

/**
 * Apply one TriggerWrite to one YAML on disk under the per-id mutex.
 * Delegates the lock + read+parse + write+publish primitives to the
 * shared helpers in `issue-write.ts` so the cascade and per-id PATCH
 * paths persist YAMLs through one canonical write tail.
 */
async function applyOneTriggerWrite(
  repoName: string,
  repoLocalPath: string,
  id: string,
  write: TriggerWrite,
  destType: ListType,
  expectedPrefix: string,
): Promise<void> {
  await withPerIdLock(repoLocalPath, id, async () => {
    const { source, current } = readIssueUnderLock(
      repoLocalPath,
      id,
      expectedPrefix,
    );
    const next = applyTriggerWrite(current, write, destType);
    const { mtimeMs } = persistMutatedIssue(
      repoLocalPath,
      id,
      source,
      next,
      expectedPrefix,
    );
    await publishIssueUpsert(repoName, next, mtimeMs);
  });
}

/**
 * Public core entry point. Validates body, reads epic + descendants,
 * resolves dest list, calls cascadeEpicMove, applies trigger writes.
 *
 * Throws `IssuePatchError` for client-fixable failures (400 / 404 / 409);
 * other errors propagate (route handler logs + 500s them).
 */
export async function applyIssueCascade(
  repoName: string,
  repoLocalPath: string,
  rawBody: unknown,
  deps: CascadeDeps = defaultDeps,
): Promise<CascadeApplyResult> {
  const body = validateCascadeBody(rawBody);
  const expectedPrefix = loadIssuePrefix(repoLocalPath);

  const { current: parent } = readIssueUnderLock(
    repoLocalPath,
    body.epic_id,
    expectedPrefix,
  );
  const descendants = collectDescendantIssues(
    repoLocalPath,
    body.epic_id,
    expectedPrefix,
  );

  const listsFile = readLists(repoLocalPath);
  const destList = listsFile.lists.find((l) => l.name === body.dest_list_name);
  if (!destList) {
    throw new IssuePatchError(404, {
      error: `dest_list_name "${body.dest_list_name}" not found in <repo>/.danxbot/lists.yaml`,
    });
  }
  const destListType = destList.type;

  if (destListType === "blocked" && (!body.blocked_reason || body.blocked_reason.length === 0)) {
    throw new IssuePatchError(400, {
      error: `blocked_reason is required when dest_list_name resolves to type "blocked"`,
    });
  }

  const dispatchableByPriority = await deps.listDispatchable(
    repoLocalPath,
    expectedPrefix,
  );

  const cascadeInput: CascadeMoveInput = {
    parent,
    descendants,
    destListType,
    destListName: destList.name,
    unblockConfirmed: body.unblock_confirmed,
    ...(body.blocked_reason !== undefined ? { blockedReason: body.blocked_reason } : {}),
    ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
    dispatchableByPriority,
    now: new Date().toISOString(),
  };

  const cascadeOutput = cascadeEpicMove(cascadeInput);

  // Surface every blocked descendant so the dialog can render the
  // per-row confirmation list. `cascadeEpicMove` does not expose which
  // descendants triggered the gate in its output, so we re-walk via
  // `deriveStatus` — N is bounded by the descendant count.
  if (cascadeOutput.requiresUnblockConfirm) {
    const blockedDescendants = descendants
      .filter((d) => deriveStatus(d) === "Blocked")
      .map((d) => d.id);
    throw new IssuePatchError(409, {
      error: "Unblock confirm required",
      blocked_descendants: blockedDescendants,
    });
  }

  // `cascadeOutput.blockedReasonRequired` would re-raise the same 400
  // we already produced at line ~464 (pre-helper validation). Single
  // source of truth — we trust the pre-validation and do not re-check
  // here. The helper still emits the field for in-process callers that
  // bypass `applyIssueCascade`.

  const updated: string[] = [];
  const skipped: string[] = [];
  const writtenIds = new Set<string>();

  // Apply parent first so the dashboard sees the epic move land before
  // any descendant cascades render — minor UX nicety; the per-card SSE
  // events still arrive in any order so reducers must be order-tolerant.
  if (Object.keys(cascadeOutput.parentWrite).length > 0) {
    await applyOneTriggerWrite(
      repoName,
      repoLocalPath,
      parent.id,
      cascadeOutput.parentWrite,
      destListType,
      expectedPrefix,
    );
    updated.push(parent.id);
    writtenIds.add(parent.id);
  }

  for (const { id, write } of cascadeOutput.childWrites) {
    const destType = destTypeForChild(id, body.overrides, destListType);
    await applyOneTriggerWrite(
      repoName,
      repoLocalPath,
      id,
      write,
      destType,
      expectedPrefix,
    );
    updated.push(id);
    writtenIds.add(id);
  }

  // Skipped = every descendant not written. Includes blocked-without-
  // confirm skips (cascade returned without emitting their write) and
  // operator stay-overrides.
  for (const d of descendants) {
    if (!writtenIds.has(d.id)) skipped.push(d.id);
  }

  return { updated, skipped };
}

/**
 * `PATCH /api/issues/cascade?repo=<name>` — auth-gated cascade route.
 * Same per-user bearer auth band as `PATCH /api/issues/:id`. Body is
 * `CascadeRequestBody`; response is `CascadeApplyResult` (200) or one of
 * the `IssuePatchError` shapes below:
 *
 *   - 400 — body shape / unknown fields / missing blocked_reason on
 *     INTO-blocked / unknown override kind.
 *   - 401 — missing/invalid bearer.
 *   - 404 — repo unknown / epic not found / dest_list_name unknown.
 *   - 409 — `{error: "Unblock confirm required", blocked_descendants:
 *     [...ids]}`. Returned when any descendant is currently Blocked AND
 *     `unblock_confirmed: false` AND destination is not Blocked. The SPA's
 *     dialog re-renders the per-row confirm checkbox list from
 *     `blocked_descendants`.
 *   - 500 — unexpected error (malformed YAML on disk, disk write failure).
 */
export async function handlePatchIssueCascade(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
  cascadeDeps: CascadeDeps = defaultDeps,
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
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  try {
    const result = await applyIssueCascade(
      repo.name,
      repo.localPath,
      body,
      cascadeDeps,
    );
    json(res, 200, result);
  } catch (err) {
    if (err instanceof IssuePatchError) {
      json(res, err.status, err.body);
      return;
    }
    log.error(`handlePatchIssueCascade(${repo.name}) failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to cascade issue",
    });
  }
}

