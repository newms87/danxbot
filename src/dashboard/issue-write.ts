/**
 * Phase 5 of DX-231 — dashboard human write surface.
 *
 * Two responsibilities:
 *  1. `applyIssuePatch` — pure-ish core that applies an allowlisted
 *     `IssuePatch` against the on-disk YAML for `<repo>/.danxbot/issues/
 *     {open,closed}/<id>.yml` with per-id mutex serialization, atomic
 *     temp-then-rename, schema-round-trip validation, and terminal-state
 *     file move (open ↔ closed).
 *  2. `handlePatchIssue` — HTTP handler for `PATCH /api/issues/:id`. Auth-
 *     gates via `requireUser`, parses + allowlists the body, calls the
 *     core, emits the `issue:updated` SSE topic on success.
 *
 * The dashboard process is the SOLE writer for human-driven mutations. The
 * agent path continues to use `Edit` / `Write` against the same YAML; the
 * worker's chokidar mirror in `src/db/issues-mirror.ts` watches both writers
 * and mirrors to Postgres on every file event. There is no cross-process
 * lock — agent + dashboard editing the same YAML simultaneously is last-
 * writer-wins, same model as agent-vs-poller already in production.
 *
 * Why per-id and not per-repo: the contention shape is "two operators
 * clicking the AC checkbox on the SAME card race each other," not "the
 * dashboard burns through one repo's cards serially." Per-id gives every
 * other card on the same repo full parallelism while still serializing
 * the dangerous path (read-modify-write the same file).
 *
 * Why no `blocked` / `waiting_on` in the patch allowlist: those carry
 * agent-side invariants (`status === "Blocked" ⟺ blocked !== null`) that
 * the dashboard's "drag a card to a column" UX cannot satisfy in one
 * round-trip — setting `blocked: null` while dragging into the Blocked
 * column would fail validation. Phase 6+ will add a dedicated affordance
 * if the requirement materializes; the validator will reject any DnD into
 * the Blocked column with a clear 400 in the meantime.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { requireUser } from "./auth-middleware.js";
import { eventBus } from "./event-bus.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import {
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import {
  ISSUE_STATUSES,
  type Blocked,
  type ConflictOnEntry,
  type Issue,
  type IssueAcItem,
  type IssueStatus,
  type RequiresHuman,
} from "../issue-tracker/interface.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

const log = createLogger("issue-write");

/**
 * Slim input shape for `requires_human` writes. The dashboard's panel ships
 * exactly `{reason, steps}`; the server stamps `set_by: "human"` and
 * `set_at: now` regardless of what the client sends. Exporting the slim
 * shape lets the SPA's typed `patchIssue` wrapper express the wire format
 * honestly — no `set_at: ""` placeholders required.
 */
export interface RequiresHumanPatchInput {
  reason: string;
  steps: string[];
}

/**
 * Allowlisted body shape for `PATCH /api/issues/:id`. Any other field
 * triggers `400 Field not patchable: <name>` BEFORE the file is read,
 * so a typo can't accidentally land an empty patch on disk.
 */
export interface IssuePatch {
  status?: IssueStatus;
  title?: string;
  description?: string;
  /** Full array replace — server does not merge ac items. */
  ac?: IssueAcItem[];
  /**
   * Single new comment to append. `author` is server-stamped from the
   * authed user; `timestamp` is server-stamped to current ISO 8601;
   * client-supplied `author`/`timestamp` are ignored.
   */
  comments_append?: { text: string };
  /**
   * Server stamps `set_by: "human"` + `set_at: now` on every set; client
   * input is only the `reason` + `steps[]` (other fields are ignored).
   * Accepts either the slim `RequiresHumanPatchInput` shape (the dashboard
   * panel's wire format — DX-239) or a full `RequiresHuman` record (legacy
   * callers that already had the timestamps lying around — the extras
   * are dropped by `validatePatchShape`). `null` clears the field.
   */
  requires_human?: RequiresHumanPatchInput | RequiresHuman | null;
  /**
   * Move a Done / Cancelled card from `closed/` back to `open/`. When
   * passed without an explicit `status`, defaults to `ToDo`. Setting
   * `reopen: true` against a card already in `open/` is a 400.
   */
  reopen?: true;
  /**
   * Operator manual ordering knob inside the card's status column
   * (DX-264). Finite number wins over the canonical ICE → priority →
   * mtime tier; `null` clears the override. Computed by the dashboard's
   * fractional-indexing helper on intra-column drop. Schema invariants
   * are checked by `validatePatchShape` (must be a finite number or
   * null — anything else is a 400).
   */
  position?: number | null;
  /**
   * Full array replace of `conflict_on[]` (DX-309). Validated entry by
   * entry — every entry must be `{id: "<PREFIX>-N", reason: "<non-empty>"}`.
   * Empty array clears all conflicts (audit + active alike). The dashboard
   * drawer's per-entry "Clear" button sends a filtered copy of the prior
   * list with the cleared entry removed.
   */
  conflict_on?: ConflictOnEntry[];
  /**
   * Self-block clear (DX-309). Only `null` is accepted — operator clears
   * via the drawer's "Clear" button on the Blocked subsection. The
   * `status: "Blocked" ⟺ blocked !== null` invariant is preserved by
   * pairing the clear with `status: "ToDo"` (the dashboard sends both in
   * one patch; the validator accepts both). Setting blocked to a record
   * is reserved for the agent path — humans flip status, the auto-stamp
   * in `applyValidatedPatch` synthesizes the record.
   */
  blocked?: null;
}

const PATCHABLE_FIELDS = new Set<keyof IssuePatch>([
  "status",
  "title",
  "description",
  "ac",
  "comments_append",
  "requires_human",
  "reopen",
  "position",
  "conflict_on",
  "blocked",
]);

const REOPEN_ALLOWED_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "Review",
  "ToDo",
  "In Progress",
  "Blocked",
]);

/**
 * Per-id async mutex. Each entry is the tail of a chain — to acquire,
 * await the current tail, then atomically swap in your own tail.
 * Cleared after the last waiter resolves so the map doesn't leak entries
 * for cards never touched again. Keyed by `<repoLocalPath>::<id>` so
 * two operators flipping the same `DX-1` on different repos don't
 * serialize against each other.
 */
const inFlight = new Map<string, Promise<void>>();

function mutexKey(repoLocalPath: string, id: string): string {
  return `${resolve(repoLocalPath)}::${id}`;
}

async function withPerIdLock<T>(
  repoLocalPath: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = mutexKey(repoLocalPath, id);
  const prev = inFlight.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => {
    release = res;
  });
  inFlight.set(key, next);
  try {
    // `.catch(() => {})` so a prior waiter's rejection does NOT bleed
    // into ours — each turn must run its own logic on a clean slate
    // (the prior caller already saw the rejection via its own
    // `IssuePatchError` / route 500 path). Without the swallow, a
    // single bad patch on `DX-1` would propagate-reject every
    // subsequent patch queued behind it on `DX-1` for the rest of the
    // process lifetime — found by code review M1.
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    // Only clear when we're still the tail — otherwise a newer waiter
    // already replaced us and is awaiting `next`, which we just released.
    if (inFlight.get(key) === next) {
      inFlight.delete(key);
    }
  }
}

export class IssuePatchError extends Error {
  constructor(
    public status: number,
    public body: { error: string },
  ) {
    super(body.error);
    this.name = "IssuePatchError";
  }
}

interface ResolvedSource {
  state: "open" | "closed";
  path: string;
}

function locateIssueFile(
  repoLocalPath: string,
  id: string,
): ResolvedSource | null {
  const openPath = issuePath(repoLocalPath, id, "open");
  if (existsSync(openPath)) return { state: "open", path: openPath };
  const closedPath = issuePath(repoLocalPath, id, "closed");
  if (existsSync(closedPath)) return { state: "closed", path: closedPath };
  return null;
}

/**
 * Validate the body shape BEFORE reading any file. Returns an
 * `IssuePatchError` (400) when the shape is bad — the per-id mutex
 * isn't even acquired in that case so a flood of bad requests can't
 * starve legitimate writers.
 */
function validatePatchShape(body: unknown): IssuePatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IssuePatchError(400, { error: "Body must be a JSON object" });
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PATCHABLE_FIELDS.has(key as keyof IssuePatch)) {
      throw new IssuePatchError(400, {
        error: `Field not patchable: ${key}`,
      });
    }
  }
  if (Object.keys(raw).length === 0) {
    throw new IssuePatchError(400, { error: "Empty patch" });
  }

  const patch: IssuePatch = {};

  if ("status" in raw) {
    const v = raw.status;
    if (typeof v !== "string" || !ISSUE_STATUSES.includes(v as IssueStatus)) {
      throw new IssuePatchError(400, {
        error: `status must be one of [${ISSUE_STATUSES.join(", ")}]`,
      });
    }
    patch.status = v as IssueStatus;
  }
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.length === 0) {
      throw new IssuePatchError(400, {
        error: "title must be a non-empty string",
      });
    }
    patch.title = raw.title;
  }
  if ("description" in raw) {
    if (typeof raw.description !== "string") {
      throw new IssuePatchError(400, { error: "description must be a string" });
    }
    patch.description = raw.description;
  }
  if ("ac" in raw) {
    if (!Array.isArray(raw.ac)) {
      throw new IssuePatchError(400, { error: "ac must be a list" });
    }
    const items: IssueAcItem[] = [];
    for (let i = 0; i < raw.ac.length; i++) {
      const item = raw.ac[i] as Record<string, unknown>;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new IssuePatchError(400, {
          error: `ac[${i}] must be a mapping`,
        });
      }
      if (typeof item.title !== "string") {
        throw new IssuePatchError(400, {
          error: `ac[${i}].title must be a string`,
        });
      }
      if (typeof item.checked !== "boolean") {
        throw new IssuePatchError(400, {
          error: `ac[${i}].checked must be a boolean`,
        });
      }
      // `check_item_id` is optional from the client — preserve when supplied
      // (the SPA round-trips the existing id so the tracker push edits
      // in place); default to "" otherwise (worker assigns on next push).
      const checkItemId =
        typeof item.check_item_id === "string" ? item.check_item_id : "";
      items.push({
        check_item_id: checkItemId,
        title: item.title,
        checked: item.checked,
      });
    }
    patch.ac = items;
  }
  if ("comments_append" in raw) {
    const c = raw.comments_append as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new IssuePatchError(400, {
        error: "comments_append must be a mapping",
      });
    }
    if (typeof c.text !== "string" || c.text.length === 0) {
      throw new IssuePatchError(400, {
        error: "comments_append.text must be a non-empty string",
      });
    }
    patch.comments_append = { text: c.text };
  }
  if ("requires_human" in raw) {
    const v = raw.requires_human;
    if (v === null) {
      patch.requires_human = null;
    } else if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new IssuePatchError(400, {
        error: "requires_human must be a mapping or null",
      });
    } else {
      const r = v as Record<string, unknown>;
      if (typeof r.reason !== "string" || r.reason.length === 0) {
        throw new IssuePatchError(400, {
          error: "requires_human.reason must be a non-empty string",
        });
      }
      if (!Array.isArray(r.steps)) {
        throw new IssuePatchError(400, {
          error: "requires_human.steps must be a list of strings",
        });
      }
      const steps: string[] = [];
      for (let i = 0; i < r.steps.length; i++) {
        const item = r.steps[i];
        if (typeof item !== "string") {
          throw new IssuePatchError(400, {
            error: `requires_human.steps[${i}] must be a string`,
          });
        }
        steps.push(item);
      }
      // Server stamps set_by + set_at — ignore client values to avoid
      // spoofing (the audit field IS the trust boundary).
      patch.requires_human = {
        reason: r.reason,
        steps,
        set_by: "human",
        set_at: "",
      };
    }
  }
  if ("reopen" in raw) {
    if (raw.reopen !== true) {
      throw new IssuePatchError(400, {
        error: "reopen must be the literal value true",
      });
    }
    patch.reopen = true;
  }
  if ("position" in raw) {
    const v = raw.position;
    if (v === null) {
      patch.position = null;
    } else if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new IssuePatchError(400, {
        error: "position must be a finite number or null",
      });
    } else {
      patch.position = v;
    }
  }
  if ("conflict_on" in raw) {
    if (!Array.isArray(raw.conflict_on)) {
      throw new IssuePatchError(400, {
        error: "conflict_on must be a list",
      });
    }
    const entries: ConflictOnEntry[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < raw.conflict_on.length; i++) {
      const e = raw.conflict_on[i] as Record<string, unknown>;
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        throw new IssuePatchError(400, {
          error: `conflict_on[${i}] must be a mapping`,
        });
      }
      if (typeof e.id !== "string" || !/^[A-Z]{2,4}-\d+$/.test(e.id)) {
        throw new IssuePatchError(400, {
          error: `conflict_on[${i}].id must match <PREFIX>-N`,
        });
      }
      if (typeof e.reason !== "string" || e.reason.length === 0) {
        throw new IssuePatchError(400, {
          error: `conflict_on[${i}].reason must be a non-empty string`,
        });
      }
      if (seenIds.has(e.id)) {
        throw new IssuePatchError(400, {
          error: `conflict_on[${i}].id "${e.id}" duplicates an earlier entry`,
        });
      }
      seenIds.add(e.id);
      entries.push({ id: e.id, reason: e.reason });
    }
    patch.conflict_on = entries;
  }
  if ("blocked" in raw) {
    if (raw.blocked !== null) {
      throw new IssuePatchError(400, {
        error: "blocked may only be patched to null (use status to flip)",
      });
    }
    patch.blocked = null;
  }
  return patch;
}

interface ApplyResult {
  issue: Issue;
  sourceState: "open" | "closed";
  targetState: "open" | "closed";
  sourcePath: string;
  targetPath: string;
}

/**
 * Apply the validated patch against the on-disk YAML for `id`. Atomic:
 * writes to `<target>.yml.tmp`, fsyncs (via writeFileSync), renames over
 * `<target>.yml`. When the target path differs from the source (terminal
 * status move, or reopen) the source is unlinked AFTER the rename so a
 * crash mid-move leaves the source intact and the next reconcile catches
 * the divergence.
 *
 * Caller MUST hold the per-id mutex. `applyIssuePatch` does that for you;
 * tests / future direct callers must acquire `withPerIdLock` themselves.
 */
function applyValidatedPatch(
  repoLocalPath: string,
  id: string,
  patch: IssuePatch,
  authUsername: string,
  expectedPrefix: string,
): ApplyResult {
  const source = locateIssueFile(repoLocalPath, id);
  if (!source) {
    throw new IssuePatchError(404, {
      error: `Issue "${id}" not found in open/ or closed/`,
    });
  }

  // Reopen pre-flight: only valid against a closed source. An explicit
  // status of Done/Cancelled paired with `reopen: true` is contradictory
  // — reject loud rather than silently dropping the reopen.
  if (patch.reopen) {
    if (source.state !== "closed") {
      throw new IssuePatchError(400, {
        error: `reopen requires source to be in closed/; ${id} is in ${source.state}/`,
      });
    }
    if (
      patch.status !== undefined &&
      !REOPEN_ALLOWED_STATUSES.has(patch.status)
    ) {
      throw new IssuePatchError(400, {
        error: `reopen incompatible with status "${patch.status}" — pick one of [${[...REOPEN_ALLOWED_STATUSES].join(", ")}]`,
      });
    }
  }

  const text = readFileSync(source.path, "utf-8");
  let current: Issue;
  try {
    current = parseIssue(text, { expectedPrefix });
  } catch (err) {
    throw new IssuePatchError(500, {
      error: `On-disk YAML for ${id} is malformed: ${(err as Error).message}`,
    });
  }

  const nowIso = new Date().toISOString();
  const next: Issue = {
    ...current,
    children: [...current.children],
    ac: current.ac.map((a) => ({ ...a })),
    comments: current.comments.map((c) => ({ ...c })),
    history: current.history.map((h) => ({ ...h })),
    retro: {
      good: current.retro.good,
      bad: current.retro.bad,
      action_item_ids: [...current.retro.action_item_ids],
      commits: [...current.retro.commits],
    },
  };

  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.ac !== undefined) next.ac = patch.ac.map((a) => ({ ...a }));
  if (patch.comments_append !== undefined) {
    next.comments = [
      ...next.comments,
      {
        author: authUsername,
        timestamp: nowIso,
        text: patch.comments_append.text,
      },
    ];
  }
  if (patch.requires_human !== undefined) {
    next.requires_human =
      patch.requires_human === null
        ? null
        : {
            reason: patch.requires_human.reason,
            steps: [...patch.requires_human.steps],
            set_by: "human",
            set_at: nowIso,
          };
  }
  if (patch.reopen) {
    // Default reopen status is ToDo — caller can override via explicit `status`
    // (ToDo / In Progress / Blocked / Review only; the pre-flight rejects Done /
    // Cancelled paired with reopen).
    next.status = patch.status ?? "ToDo";
  } else if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.position !== undefined) {
    next.position = patch.position;
  }
  if (patch.conflict_on !== undefined) {
    next.conflict_on = patch.conflict_on.map((e) => ({ ...e }));
  }
  if (patch.blocked !== undefined) {
    next.blocked = patch.blocked;
  }

  // Operator action (dashboard drag, manual status patch) overrides the
  // dispatch gates `blocked` / `waiting_on`. Without this normalization
  // the YAML-level invariant `status === "Blocked" ⟺ blocked != null`
  // (and `waiting_on != null ⟹ status === "ToDo"`) would 400 every
  // drag-into-Blocked or drag-out-of-Blocked, since the inbound patch
  // only carries `status`. Auto-stamp / auto-clear so the drag UX
  // round-trips cleanly. The operator wins; if they explicitly set
  // `blocked` or `waiting_on` in the patch (future field expansion),
  // those take precedence over this normalization.
  if (patch.status !== undefined) {
    if (next.status === "Blocked" && next.blocked === null) {
      next.blocked = {
        reason: "Manually moved to Blocked via dashboard",
        timestamp: nowIso,
      };
    } else if (next.status !== "Blocked" && next.blocked !== null) {
      next.blocked = null;
    }
    if (next.status !== "ToDo" && next.waiting_on !== null) {
      next.waiting_on = null;
    }
  }

  // Compute target state from the post-patch status. Done / Cancelled
  // close the card; everything else opens it. Reopen is a special case
  // of "force open" — the status is set above, and the target derives
  // from it the same way.
  const targetState: "open" | "closed" =
    next.status === "Done" || next.status === "Cancelled" ? "closed" : "open";
  const targetPath = issuePath(repoLocalPath, id, targetState);

  // Validate the merged Issue by serializing + re-parsing through the
  // strict schema. Any patch that produces an invalid document (e.g.
  // status: Blocked without populating `blocked`, or violates the
  // waiting_on/status invariant) fails here BEFORE any disk write.
  const serialized = serializeIssue(next);
  try {
    parseIssue(serialized, { expectedPrefix });
  } catch (err) {
    throw new IssuePatchError(400, {
      error: `Patch produced invalid YAML: ${(err as Error).message}`,
    });
  }

  ensureIssuesDirs(repoLocalPath);
  // Temp + atomic rename. The .tmp suffix sits in the SAME directory as
  // the destination so `rename(2)` is atomic on every supported fs (we
  // cross dirs only via the explicit unlink below). chokidar's
  // `awaitWriteFinish` debounces the resulting add/change event, so the
  // mirror sees a single stable write rather than a tmp-then-rename pair.
  const tmpPath = `${targetPath}.tmp`;
  mkdirSync(dirname(tmpPath), { recursive: true });
  try {
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup so a partial-write doesn't leave a stale .tmp
    // residue. The destination is untouched on rename failure.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore — tmp may not exist if writeFileSync threw */
    }
    throw new IssuePatchError(500, {
      error: `Failed to write ${id}: ${(err as Error).message}`,
    });
  }

  // Source unlink AFTER the rename so a crash between the two leaves
  // both files on disk — the reconcile pass detects the duplicate and
  // the dashboard reader's "open wins" rule recovers the active state.
  if (source.path !== targetPath) {
    try {
      unlinkSync(source.path);
    } catch (err) {
      // Don't fail the whole patch — destination is the new truth.
      // chokidar's unlink event would tombstone in the mirror; here it
      // doesn't fire so the periodic reconcile tombstones eventually.
      log.warn(
        `Failed to unlink old source ${source.path} after rename to ${targetPath}: ${(err as Error).message}`,
      );
    }
  }

  return {
    issue: next,
    sourceState: source.state,
    targetState,
    sourcePath: source.path,
    targetPath,
  };
}

/**
 * Public core entry point. Acquires the per-id mutex, validates the patch
 * shape, applies the patch, and emits the `issue:updated` SSE event.
 * Throws `IssuePatchError` for client-fixable failures (400 / 404); other
 * errors propagate (the route handler logs + 500s them).
 */
export async function applyIssuePatch(
  repoName: string,
  repoLocalPath: string,
  id: string,
  rawBody: unknown,
  authUsername: string,
): Promise<Issue> {
  const patch = validatePatchShape(rawBody);
  const expectedPrefix = loadIssuePrefix(repoLocalPath);
  const result = await withPerIdLock(repoLocalPath, id, async () => {
    return applyValidatedPatch(
      repoLocalPath,
      id,
      patch,
      authUsername,
      expectedPrefix,
    );
  });
  eventBus.publish({
    topic: "issue:updated",
    data: { repo: repoName, id, issue: result.issue },
  });
  return result.issue;
}

/**
 * `PATCH /api/issues/:id?repo=<name>` — auth-gated dashboard write
 * surface. Matched ahead of the blanket `/api/*` user-auth gate in
 * `server.ts` so this handler's own `requireUser` call produces the
 * 401, mirroring the PATCH/DELETE handlers in `agents-toggles.ts` /
 * `agents-crud.ts`.
 */
export async function handlePatchIssue(
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
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  try {
    const issue = await applyIssuePatch(
      repo.name,
      repo.localPath,
      id,
      body,
      auth.user.username,
    );
    json(res, 200, { issue });
  } catch (err) {
    if (err instanceof IssuePatchError) {
      json(res, err.status, err.body);
      return;
    }
    log.error(`handlePatchIssue(${repo.name}, ${id}) failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to patch issue",
    });
  }
}
