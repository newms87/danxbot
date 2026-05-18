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
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { requireUser } from "./auth-middleware.js";
import {
  publishIssueRemoved,
  publishIssueUpsert,
} from "./publish-issue-update.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import {
  createEmptyIssue,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import { nextIssueId } from "../issue-tracker/id-generator.js";
import {
  ISSUE_TYPES,
  type Blocked,
  type ConflictOnEntry,
  type Issue,
  type IssueAcItem,
  type IssueStatus,
  type IssueType,
  type RequiresHuman,
} from "../issue-tracker/interface.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import { readLists, type List, type ListType } from "../lists-file.js";
import {
  applyListMove,
  ListMoveError,
  type BlockedPatchInput,
} from "../issue/list-move.js";
import { randomUUID } from "node:crypto";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

/**
 * Statuses allowed on the human-driven create surface (`POST /api/issues`).
 * Cards always start in `Review` (operator wants triage + flesh-out) or
 * `ToDo` (operator already knows the scope). Anything else — `In Progress`,
 * `Blocked`, `Done`, `Cancelled` — must come from the agent / poller path
 * or a follow-up PATCH, not from the create surface.
 */
const CREATE_ALLOWED_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "Review",
  "ToDo",
]);

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
 *
 * DX-586 — `status` is NOT patchable. The board's drag/drop + drawer
 * dropdown send `list_name` (resolved server-side to a `ListType` via
 * `lists.yaml`); the server applies ladder semantics and writes the
 * lifecycle timestamps + gate fields that make `deriveStatus` project
 * the intended derived value. A client passing `status` gets a 400.
 */
export interface IssuePatch {
  /**
   * Card type label. Allowed values are `IssueType` (Feature / Bug / Epic /
   * Chore / Spike / Refactor / etc — see `ISSUE_TYPES`). The type is mostly
   * a UI label, but flipping to/from `Epic` has two backend consequences:
   *   1. Poller dispatch filter skips `type === "Epic"` — flipping a card
   *      to Epic stops it from being picked up; flipping away makes it
   *      dispatchable again (subject to other gates).
   *   2. UI hides the AC tab on Epics and labels children as "Phases".
   * Parent-status derivation gates on `children.length > 0`, NOT on type,
   * so a card with children has its status derived regardless of type.
   * No flip guards — the operator is trusted; the type-menu UI surfaces
   * the dispatch implication.
   */
  type?: IssueType;
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
   * passed without an explicit `list_name`, the server resolves the
   * `ready`-type default list from `lists.yaml`. Pairing with a
   * `list_name` that resolves to a `completed` / `cancelled` type is
   * rejected as contradictory. Setting `reopen: true` against a card
   * already in `open/` is a 400.
   */
  reopen?: true;
  /**
   * DX-586 — move the card into a per-repo named list. The server
   * resolves the list's `ListType` via `lists.yaml`, computes the
   * ladder position, and applies the rightward / leftward / lateral
   * semantics described in DX-575 epic body. Always stamps `list_name`
   * on the card. Special cases:
   *
   *  - dest `ListType === "blocked"` REQUIRES `blocked: {reason}` in the
   *    same patch (INTO-blocked dialog). Otherwise the server returns
   *    400.
   *  - dest `ListType === "in_progress"` auto-stamps the `dispatch`
   *    record with the authed username (encoded in `dispatch.host`),
   *    `kind: "work"`, `pid: 0`. No client input needed.
   *  - Lateral move (dest's type matches current derived type) only
   *    changes `list_name`; no triggers are touched.
   *
   * 404 when the list name is unknown in `<repo>/.danxbot/lists.yaml`.
   */
  list_name?: string;
  /**
   * Operator priority knob (DX-521). Finite number in the open
   * interval `(0, 6)` — `validatePatchShape` rejects out-of-range,
   * non-finite, and non-numeric values with `400 Invalid priority`.
   * Out-of-clamp-range values that still pass the open-interval check
   * (e.g. `0.001`) round-trip through `parseIssue` on the next read
   * and silently clamp to `[PRIORITY_MIN, PRIORITY_MAX]`. The
   * dashboard's tier menu commits the midpoint of each tier
   * (`PRIORITY_TIERS[i].defaultValue`); typed numeric overrides land
   * verbatim.
   */
  priority?: number;
  /**
   * Full array replace of `conflict_on[]` (DX-309). Validated entry by
   * entry — every entry must be `{id: "<PREFIX>-N", reason: "<non-empty>"}`.
   * Empty array clears all conflicts (audit + active alike). The dashboard
   * drawer's per-entry "Clear" button sends a filtered copy of the prior
   * list with the cleared entry removed.
   */
  conflict_on?: ConflictOnEntry[];
  /**
   * Self-block lifecycle trigger (DX-309 + DX-586).
   *
   *  - `null` — explicit unblock confirmation (OUT-of-blocked dialog
   *    submit). The server clears `blocked` and applies the dest list's
   *    ladder semantics. Always allowed.
   *  - `{reason: string}` — INTO-blocked dialog submit. ONLY valid
   *    paired with a `list_name` whose type is `blocked`; the server
   *    stamps `blocked: {at: now, reason}` and skips the rest of the
   *    ladder sweep. Standalone `blocked: {reason}` without a
   *    `list_name` of type `blocked` is rejected as inconsistent.
   *  - `undefined` — default ladder semantics apply (board drag without
   *    the confirm dialog auto-clears `blocked` on a leftward move).
   */
  blocked?: BlockedPatchInput;
}

const PATCHABLE_FIELDS = new Set<keyof IssuePatch>([
  "type",
  "title",
  "description",
  "ac",
  "comments_append",
  "requires_human",
  "reopen",
  "priority",
  "conflict_on",
  "blocked",
  "list_name",
]);

/**
 * `ListType`s whose default lists can be the dest of a `reopen` move.
 * Reopen explicitly excludes the terminal-state types — pairing reopen
 * with a `list_name` of `completed` / `cancelled` type is contradictory
 * (the source is already terminal in `closed/`, the reopen verb means
 * "move back to a non-terminal state").
 */
const REOPEN_ALLOWED_LIST_TYPES: ReadonlySet<ListType> = new Set<ListType>([
  "archived",
  "review",
  "ready",
  "blocked",
  "in_progress",
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

export async function withPerIdLock<T>(
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

/**
 * Per-repo create mutex. Distinct from the per-id PATCH mutex above —
 * `createIssue` does not know the id until `nextIssueId` returns, so
 * the lock keyed by `repoLocalPath` (one chain per connected repo) is
 * what serializes the read-then-write of the id counter. Without this,
 * two concurrent operator clicks read the same `max(N)` from disk, both
 * write `<PREFIX>-N+1`, and the second `rename(2)` clobbers the first
 * card. Code review C1 (DX-350).
 *
 * Lock granularity matches the create operation's natural shape: the
 * dashboard hosts one POST endpoint per repo, so two operators creating
 * on *different* repos do not serialize against each other (each repo
 * has its own id counter and its own `<repoLocalPath>` map key).
 */
const inFlightCreate = new Map<string, Promise<void>>();

export async function withPerRepoCreateLock<T>(
  repoLocalPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(repoLocalPath);
  const prev = inFlightCreate.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => {
    release = res;
  });
  inFlightCreate.set(key, next);
  try {
    // Mirror the PATCH-path's prior-rejection swallow so one bad create
    // does not poison every subsequent create on the same repo. The
    // prior caller already saw its own rejection.
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (inFlightCreate.get(key) === next) {
      inFlightCreate.delete(key);
    }
  }
}

/**
 * Atomic temp+rename write for a fully-serialized issue YAML.
 *
 * Extracted from `applyValidatedPatch` + `createIssue` (code-review C1
 * for DX-350). The `.tmp` suffix sits in the SAME directory as the
 * destination so `rename(2)` is atomic on every supported fs. chokidar's
 * `awaitWriteFinish` debounces the resulting add/change event, so the
 * mirror sees a single stable write rather than a tmp-then-rename pair.
 *
 * On any write/rename failure: best-effort `unlink(tmp)` so a partial
 * write does not leave stale `.tmp` residue, then throw a 500
 * `IssuePatchError` carrying the underlying message. The destination is
 * untouched on a `rename` failure (the source still holds the prior
 * content on the PATCH path; the create path has nothing to leave
 * behind).
 *
 * Caller MUST have already validated the serialized YAML round-trips
 * through `parseIssue`; this helper is pure disk I/O.
 */
export function writeIssueYamlAtomic(
  targetPath: string,
  serialized: string,
  idForError: string,
): void {
  const tmpPath = `${targetPath}.tmp`;
  mkdirSync(dirname(tmpPath), { recursive: true });
  try {
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore — tmp may not exist if writeFileSync threw */
    }
    throw new IssuePatchError(500, {
      error: `Failed to write ${idForError}: ${(err as Error).message}`,
    });
  }
}

export class IssuePatchError extends Error {
  constructor(
    public status: number,
    public body: { error: string; [key: string]: unknown },
  ) {
    super(body.error);
    this.name = "IssuePatchError";
  }
}

export interface ResolvedSource {
  state: "open" | "closed";
  path: string;
}

/**
 * Read + parse the on-disk YAML for `id` under the caller-held per-id
 * mutex. Throws `IssuePatchError` for not-found (404) / malformed (500)
 * — the two read-path failure modes shared between the PATCH and the
 * cascade write paths.
 *
 * Caller MUST hold the per-id mutex (via `withPerIdLock`). The helper
 * does not acquire the lock itself.
 */
export function readIssueUnderLock(
  repoLocalPath: string,
  id: string,
  expectedPrefix: string,
): { source: ResolvedSource; current: Issue } {
  const source = locateIssueFile(repoLocalPath, id);
  if (!source) {
    throw new IssuePatchError(404, {
      error: `Issue "${id}" not found in open/ or closed/`,
    });
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
  return { source, current };
}

/**
 * Serialize `next`, round-trip-validate, atomically write to the
 * derived target path, and unlink the source path if the YAML moved
 * (open ↔ closed on a terminal-status transition). Returns the target
 * path + state + mtime so the caller can publish the SSE upsert.
 *
 * The round-trip parse guards every write site — any patch / cascade /
 * future writer that produces an invariant-violating YAML (e.g.
 * `status: Blocked` without `blocked`) 400s BEFORE the disk write.
 *
 * Caller MUST hold the per-id mutex (via `withPerIdLock`). The helper
 * does not acquire the lock itself.
 */
export interface PersistIssueResult {
  targetPath: string;
  targetState: "open" | "closed";
  mtimeMs: number;
}

export function persistMutatedIssue(
  repoLocalPath: string,
  id: string,
  source: ResolvedSource,
  next: Issue,
  expectedPrefix: string,
): PersistIssueResult {
  const targetState: "open" | "closed" =
    next.status === "Done" || next.status === "Cancelled" ? "closed" : "open";
  const targetPath = issuePath(repoLocalPath, id, targetState);

  const serialized = serializeIssue(next);
  try {
    parseIssue(serialized, { expectedPrefix });
  } catch (err) {
    throw new IssuePatchError(400, {
      error: `Patch produced invalid YAML: ${(err as Error).message}`,
    });
  }

  ensureIssuesDirs(repoLocalPath);
  writeIssueYamlAtomic(targetPath, serialized, id);

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

  const mtimeMs = statSync(targetPath).mtimeMs;
  return { targetPath, targetState, mtimeMs };
}

export function locateIssueFile(
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

  if ("type" in raw) {
    const v = raw.type;
    if (typeof v !== "string" || !ISSUE_TYPES.includes(v as IssueType)) {
      throw new IssuePatchError(400, {
        error: `type must be one of [${ISSUE_TYPES.join(", ")}]`,
      });
    }
    patch.type = v as IssueType;
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
  if ("priority" in raw) {
    const v = raw.priority;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 6) {
      throw new IssuePatchError(400, {
        error: "priority must be a finite number in (0, 6)",
      });
    }
    patch.priority = v;
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
  if ("list_name" in raw) {
    const v = raw.list_name;
    if (typeof v !== "string" || v.length === 0) {
      throw new IssuePatchError(400, {
        error: "list_name must be a non-empty string",
      });
    }
    patch.list_name = v;
  }
  if ("blocked" in raw) {
    const v = raw.blocked;
    if (v === null) {
      patch.blocked = null;
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const r = v as Record<string, unknown>;
      if (typeof r.reason !== "string" || r.reason.length === 0) {
        throw new IssuePatchError(400, {
          error: "blocked.reason must be a non-empty string",
        });
      }
      patch.blocked = { reason: r.reason };
    } else {
      throw new IssuePatchError(400, {
        error: 'blocked must be null OR an object {reason: string}',
      });
    }
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
  const { source, current } = readIssueUnderLock(
    repoLocalPath,
    id,
    expectedPrefix,
  );

  // Reopen pre-flight: only valid against a closed source. The
  // dest-list-type compatibility check happens AFTER list resolution
  // below (a `list_name` resolving to `completed` / `cancelled` types
  // is rejected as contradictory with the reopen verb).
  if (patch.reopen) {
    if (source.state !== "closed") {
      throw new IssuePatchError(400, {
        error: `reopen requires source to be in closed/; ${id} is in ${source.state}/`,
      });
    }
  }

  const nowIso = new Date().toISOString();
  let next: Issue = {
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

  if (patch.type !== undefined) next.type = patch.type;
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
  if (patch.priority !== undefined) {
    next.priority = patch.priority;
  }
  if (patch.conflict_on !== undefined) {
    next.conflict_on = patch.conflict_on.map((e) => ({ ...e }));
  }

  // List-move semantics (DX-586). Resolve `list_name` → `List` via
  // `lists.yaml`, then dispatch to `applyListMove` for the ladder
  // semantics. Reopen without an explicit `list_name` defaults to the
  // `ready`-type default list.
  const explicitListMove = patch.list_name !== undefined;
  const reopenMove = patch.reopen === true && !explicitListMove;
  if (explicitListMove || reopenMove) {
    const listsFile = readLists(repoLocalPath);
    const destList: List | undefined = explicitListMove
      ? listsFile.lists.find((l) => l.name === patch.list_name)
      : listsFile.lists.find((l) => l.type === "ready" && l.is_default_for_type);
    if (!destList) {
      if (explicitListMove) {
        throw new IssuePatchError(404, {
          error: `list_name "${patch.list_name}" not found in <repo>/.danxbot/lists.yaml`,
        });
      }
      throw new IssuePatchError(500, {
        error: `No default list for type "ready" in <repo>/.danxbot/lists.yaml — file corrupt`,
      });
    }
    if (patch.reopen && !REOPEN_ALLOWED_LIST_TYPES.has(destList.type)) {
      throw new IssuePatchError(400, {
        error: `reopen incompatible with list_name "${destList.name}" (type "${destList.type}") — pick a list whose type is one of [${[...REOPEN_ALLOWED_LIST_TYPES].join(", ")}]`,
      });
    }
    try {
      const moveResult = applyListMove({
        current: next,
        destListType: destList.type,
        destListName: destList.name,
        blockedPatch: patch.blocked,
        authUsername,
        nowIso,
        uuid: randomUUID,
      });
      next = moveResult.next;
    } catch (err) {
      if (err instanceof ListMoveError) {
        throw new IssuePatchError(err.status, { error: err.message });
      }
      throw err;
    }
  } else if (patch.blocked !== undefined) {
    // No `list_name` in the patch — the `blocked` field is a paired
    // field with `list_name`; standalone updates are rejected so the
    // status⟺blocked YAML invariant (`status === "Blocked" ⟺
    // blocked !== null`) can never be violated by a partial patch.
    // The dashboard's Clear-Block button (`DispatchGatesSection`)
    // always pairs `blocked: null` with `list_name: <ready-default>`;
    // the dialogs in `IssuesPage` + `DrawerHeader` always pair
    // `{reason}` / `null` with a `list_name` of the matching type.
    // A future client that wants to standalone-clear must update its
    // wire format.
    if (patch.blocked === null) {
      throw new IssuePatchError(400, {
        error: `blocked: null must accompany a list_name move (pair with list_name to land the card off the Blocked list)`,
      });
    }
    throw new IssuePatchError(400, {
      error: `blocked.reason may only accompany a move into a "blocked"-type list (pair with list_name)`,
    });
  }

  const persisted = persistMutatedIssue(
    repoLocalPath,
    id,
    source,
    next,
    expectedPrefix,
  );

  return {
    issue: next,
    sourceState: source.state,
    targetState: persisted.targetState,
    sourcePath: source.path,
    targetPath: persisted.targetPath,
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
): Promise<{ issue: Issue; item: import("./issues-reader.js").IssueListItem }> {
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
  const mtimeMs = statSync(result.targetPath).mtimeMs;
  const item = await publishIssueUpsert(repoName, result.issue, mtimeMs);
  return { issue: result.issue, item };
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
    const result = await applyIssuePatch(
      repo.name,
      repo.localPath,
      id,
      body,
      auth.user.username,
    );
    json(res, 200, { issue: result.issue, item: result.item });
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

/**
 * Soft-delete a card by moving its YAML out of the watched
 * `<repo>/.danxbot/issues/{open,closed}/` tree into a sibling trash dir
 * at `<repoLocalPath>/.danxbot/trash/`. Chokidar's `unlink` event flips
 * the DB row to `is_deleted=true` (issues-mirror tombstone path); the
 * SPA's `issue:updated` `removed: true` SSE payload drops the row from
 * every subscriber. The on-disk file survives in `<repo>/.danxbot/trash/`
 * until the operator clears the dir or the next git cleanup pass — host-
 * visible via the bind mount, so an operator can recover a wrongly-deleted
 * card directly via `ls <repo>/.danxbot/trash/<id>.yml*` on the host (no
 * `docker exec` required).
 *
 * Why same-filesystem trash: `renameSync` is implemented via the POSIX
 * `rename(2)` syscall, which raises `EXDEV` across mounts. Inside a docker
 * container, `/tmp` lives on overlayfs/tmpfs while `.danxbot/issues/` is
 * a bind mount of a host directory; the prior `os.tmpdir()` location was
 * silently broken on every container target. The new location shares a
 * filesystem with the source YAML by construction. As defense-in-depth
 * against future cross-device misconfigurations, `moveAcrossDevices`
 * falls back to `copyFileSync` + `unlinkSync` on `EXDEV`.
 *
 * Cascade semantics: when `cascade=true`, the BFS walks `children[]`
 * recursively (same shape as `buildIssueSubtreePayload` in
 * `issue-import.ts`) and moves every descendant YAML alongside the
 * root. Children-missing-on-disk are skipped silently — a half-deleted
 * subtree is a normal mid-state, not a failure mode. When `cascade=
 * false`, only the root YAML moves; descendants are left orphaned (the
 * caller already opted out of cascade).
 *
 * Per-id mutex held for the duration so a concurrent PATCH on the same
 * card can't read mid-move. Cross-repo `<repo>::<id>` keying means two
 * operators deleting different cards on different repos never serialize
 * against each other.
 */
export interface DeleteIssueResult {
  removed: string[];
}

function trashPathFor(repoLocalPath: string, id: string): string {
  return resolve(repoLocalPath, ".danxbot", "trash", `${id}.yml`);
}

/**
 * Move `source` → `dest` across filesystems. Tries the cheap atomic
 * `renameSync` first; on `EXDEV` (cross-device link not permitted) falls
 * back to `copyFileSync` + `unlinkSync`. Other errors propagate. The
 * fallback is not atomic — a crash between copy + unlink leaves the file
 * at both paths; the next delete operation overwrites the trash copy
 * (or the timestamp-suffix path in `moveYamlToTrash` resolves it).
 *
 * The `renameImpl` parameter is a test seam — ESM spy restrictions prevent
 * mocking the `node:fs` `renameSync` binding directly, so the EXDEV branch
 * is exercised by passing a throwing stub from the unit suite. Production
 * callers leave it defaulted.
 */
export function moveAcrossDevices(
  source: string,
  dest: string,
  renameImpl: (from: string, to: string) => void = renameSync,
): void {
  try {
    renameImpl(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(source, dest);
    unlinkSync(source);
  }
}

function collectDescendants(
  repoLocalPath: string,
  rootId: string,
  expectedPrefix: string,
): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const source = locateIssueFile(repoLocalPath, id);
    if (!source) continue;
    let issue: Issue;
    try {
      const text = readFileSync(source.path, "utf-8");
      issue = parseIssue(text, { expectedPrefix });
    } catch {
      // Malformed descendant — skip its children but still delete its
      // file (queued above). Operator can repair from the trash copy.
      continue;
    }
    for (const childId of issue.children) {
      if (!visited.has(childId)) queue.push(childId);
    }
  }
  return order;
}

function moveYamlToTrash(
  sourcePath: string,
  repoLocalPath: string,
  id: string,
): void {
  const dest = trashPathFor(repoLocalPath, id);
  mkdirSync(dirname(dest), { recursive: true });
  // Stamp the trash filename with a timestamp suffix so a second delete
  // of the same id (recreate → re-delete cycle) does not clobber the
  // first trashed copy. The operator's "undelete by hand" play remains
  // tractable — `ls <repo>/.danxbot/trash/<id>.yml*` lists every prior
  // version.
  const target = existsSync(dest)
    ? `${dest}.${new Date().toISOString().replace(/[:.]/g, "-")}`
    : dest;
  moveAcrossDevices(sourcePath, target);
}

/**
 * Public core entry point for delete. Cascade defaults to `true` —
 * callers that want a single-card delete must pass `cascade: false`
 * explicitly. The handler's body shape gates this.
 */
export async function deleteIssue(
  repoName: string,
  repoLocalPath: string,
  id: string,
  cascade: boolean,
): Promise<DeleteIssueResult> {
  const expectedPrefix = loadIssuePrefix(repoLocalPath);
  // Resolve every id we plan to delete BEFORE acquiring the per-id
  // mutex so we don't read the root issue twice. The mutex below covers
  // the actual file moves; descendants can rotate concurrently but
  // chokidar reconciles the order eventually.
  const rootSource = locateIssueFile(repoLocalPath, id);
  if (!rootSource) {
    throw new IssuePatchError(404, { error: `Issue "${id}" not found` });
  }
  const targets = cascade
    ? collectDescendants(repoLocalPath, id, expectedPrefix)
    : [id];

  const removed: string[] = [];
  for (const targetId of targets) {
    // Per-id lock so a concurrent PATCH on this card can't race the
    // move. Skip missing files silently (cascade walk may include a
    // descendant whose YAML disappeared mid-walk).
    await withPerIdLock(repoLocalPath, targetId, async () => {
      const source = locateIssueFile(repoLocalPath, targetId);
      if (!source) return;
      try {
        moveYamlToTrash(source.path, repoLocalPath, targetId);
        removed.push(targetId);
      } catch (err) {
        throw new IssuePatchError(500, {
          error: `Failed to delete ${targetId}: ${(err as Error).message}`,
        });
      }
    });
    await publishIssueRemoved(repoName, targetId);
  }
  return { removed };
}

/**
 * `DELETE /api/issues/:id?repo=<name>&cascade=true|false` — auth-gated
 * dashboard delete surface. Same auth band as PATCH/POST. The handler
 * runs `requireUser` itself ahead of the blanket `/api/*` gate.
 */
export async function handleDeleteIssue(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  repoQuery: string | null,
  cascadeQuery: string | null,
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
  // Default cascade=true — the UI dialog already shows the descendant
  // count and asks for explicit consent before sending; an unset query
  // param means "the operator confirmed the cascade in the dialog."
  // Explicit `cascade=false` opts out for power users hitting the API
  // directly.
  const cascade = cascadeQuery === null ? true : cascadeQuery !== "false";
  try {
    const result = await deleteIssue(repo.name, repo.localPath, id, cascade);
    json(res, 200, result);
  } catch (err) {
    if (err instanceof IssuePatchError) {
      json(res, err.status, err.body);
      return;
    }
    log.error(`handleDeleteIssue(${repo.name}, ${id}) failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to delete issue",
    });
  }
}

/**
 * Body shape for `POST /api/issues` — the human-driven create surface.
 * Submit from the dashboard's Create Card dialog (DX-350). Mirrors the
 * agent-side `mcp__danx-issue__danx_issue_create` path but bypasses the
 * draft-YAML hop: the dashboard never has a draft on disk to point at,
 * and the human creating the card has authority comparable to the agent
 * who would have called the MCP tool.
 *
 * `title` and `description` are non-empty strings; `status` is one of
 * `Review` | `ToDo` (the operator's two valid starting points); `type` is
 * any `IssueType`. Anything else returns 400 BEFORE any disk write.
 */
export interface IssueCreateInput {
  title: string;
  description: string;
  status: IssueStatus;
  type: IssueType;
  /**
   * Optional operator-chosen priority (DX-544). Finite number; clamped on
   * write into `[PRIORITY_MIN, PRIORITY_MAX]`. Omitted → writer falls back
   * to `PRIORITY_DEFAULT`.
   */
  priority?: number;
}

/**
 * Sentinel `blocked.reason` prefix stamped on every newly-created card
 * (DX-544). The poller's `isAnyKindBlocked` filter excludes cards with
 * non-null `blocked`, so the work-agent dispatch cannot claim the card
 * before the flesh-out agent rewrites the description. The `danx-flesh-out`
 * skill recognizes this exact prefix as the eligibility signal and clears
 * `blocked: null` + restores the encoded starting status as its final
 * YAML edit before `danxbot_complete`.
 *
 * The operator's chosen starting status (Review or ToDo) is encoded into
 * the reason as the trailing ` start as <status>` token so the flesh-out
 * agent can parse it back out without an out-of-band channel.
 */
export const FLESH_OUT_BLOCK_PREFIX = "Awaiting flesh-out";

export function buildFleshOutBlockReason(startAs: IssueStatus): string {
  return `${FLESH_OUT_BLOCK_PREFIX} — start as ${startAs}`;
}

function validateCreateShape(body: unknown): IssueCreateInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IssuePatchError(400, { error: "Body must be a JSON object" });
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    throw new IssuePatchError(400, {
      error: "title must be a non-empty string",
    });
  }
  if (
    typeof raw.description !== "string" ||
    raw.description.trim().length === 0
  ) {
    throw new IssuePatchError(400, {
      error: "description must be a non-empty string",
    });
  }
  if (
    typeof raw.status !== "string" ||
    !CREATE_ALLOWED_STATUSES.has(raw.status as IssueStatus)
  ) {
    throw new IssuePatchError(400, {
      error: `status must be one of [${[...CREATE_ALLOWED_STATUSES].join(", ")}]`,
    });
  }
  if (
    typeof raw.type !== "string" ||
    !ISSUE_TYPES.includes(raw.type as IssueType)
  ) {
    throw new IssuePatchError(400, {
      error: `type must be one of [${ISSUE_TYPES.join(", ")}]`,
    });
  }
  let priority: number | undefined;
  if ("priority" in raw && raw.priority !== undefined) {
    const v = raw.priority;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new IssuePatchError(400, {
        error: "priority must be a finite number",
      });
    }
    priority = v;
  }
  return {
    title: raw.title,
    description: raw.description,
    status: raw.status as IssueStatus,
    type: raw.type as IssueType,
    ...(priority !== undefined ? { priority } : {}),
  };
}

/**
 * Allocate the next `<PREFIX>-N`, build a canonical `Issue`, write
 * `<repo>/.danxbot/issues/open/<id>.yml` atomically, and publish the
 * `issue:created` + `issue:updated` SSE topics. The watcher mirror
 * (`src/db/issues-mirror.ts`) catches the write event and upserts into
 * Postgres; the poller's per-tick mirror handles the Trello push async
 * — Trello is background infra and stays off the human's critical path
 * (same contract as the agent-facing create flow post-DX-203).
 *
 * Returns the parsed `Issue` so the route handler can echo it in the
 * 200 response body (the SPA round-trips this into its local store
 * before the SSE event arrives, eliminating the visual delay).
 */
export async function createIssue(
  repoName: string,
  repoLocalPath: string,
  rawBody: unknown,
): Promise<{ issue: Issue; item: import("./issues-reader.js").IssueListItem }> {
  const input = validateCreateShape(rawBody);
  const expectedPrefix = loadIssuePrefix(repoLocalPath);
  const issuesRoot = resolve(repoLocalPath, ".danxbot", "issues");
  return withPerRepoCreateLock(repoLocalPath, async () => {
    // Lock acquired — allocate the next id, build, validate, write,
    // publish. The lock serializes the read-then-write of the id counter
    // so two concurrent operator clicks land distinct ids; without it
    // both reads would see the same `max(N)` and both writes would race
    // for `<PREFIX>-N+1` (code-review C1).
    const newId = await nextIssueId(issuesRoot, expectedPrefix);
    // DX-544 — close the create-flow race: every newly-created card lands
    // with `status: "Blocked"` + a sentinel `blocked` record so the poller's
    // `isAnyKindBlocked` filter cannot dispatch a work-agent before the
    // flesh-out agent rewrites the description. The operator's chosen
    // starting status is encoded into the sentinel reason; the
    // `danxbot:danx-flesh-out` skill parses it back out and restores
    // `status` (plus clears `blocked: null`) as its final YAML edit.
    const draft = createEmptyIssue({
      id: newId,
      title: input.title,
      description: input.description,
      status: "Blocked",
      type: input.type,
      priority: input.priority,
      blocked: {
        reason: buildFleshOutBlockReason(input.status),
        at: new Date().toISOString(),
      },
    });

    // Round-trip through the strict parser BEFORE writing so any
    // createEmptyIssue / interface drift fails loud HERE instead of
    // writing a malformed YAML the watcher would then mirror as
    // `_malformed: true`.
    const serialized = serializeIssue(draft);
    let issue: Issue;
    try {
      issue = parseIssue(serialized, { expectedPrefix });
    } catch (err) {
      throw new IssuePatchError(500, {
        error: `createIssue produced invalid YAML: ${(err as Error).message}`,
      });
    }

    ensureIssuesDirs(repoLocalPath);
    const targetPath = issuePath(repoLocalPath, issue.id, "open");
    writeIssueYamlAtomic(targetPath, serialized, issue.id);

    const mtimeMs = statSync(targetPath).mtimeMs;
    const item = await publishIssueUpsert(repoName, issue, mtimeMs);
    return { issue, item };
  });
}

/**
 * `POST /api/issues?repo=<name>` — human-driven create surface (DX-350).
 *
 * Auth: per-user bearer (NOT the dispatch token). Matched ahead of the
 * blanket `/api/*` gate so the handler's own `requireUser` produces the
 * 401, mirroring the PATCH counterpart.
 *
 * Side-effect ordering: validate → allocate id → write YAML → publish SSE
 * → return parsed Issue. Any validation failure short-circuits BEFORE any
 * disk write, so a flood of bad requests cannot grow the id counter.
 */
export async function handlePostIssue(
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
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  try {
    const result = await createIssue(repo.name, repo.localPath, body);
    json(res, 200, { issue: result.issue, item: result.item });
  } catch (err) {
    if (err instanceof IssuePatchError) {
      json(res, err.status, err.body);
      return;
    }
    log.error(`handlePostIssue(${repo.name}) failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to create issue",
    });
  }
}
