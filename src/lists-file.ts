/**
 * DX-583 — Per-repo list taxonomy file at `<repo>/.danxbot/lists.yaml`.
 *
 * Phase 3 of DX-575 (Computed card state). The list taxonomy itself is
 * operator-owned and lives in a committed YAML file. Each list has a
 * stable id (never reused), a human-friendly display name, a semantic
 * `type` enum, an integer `order`, and an `is_default_for_type` flag —
 * exactly one default per type. The validator enforces the
 * **≥1-list-per-type invariant** on every write (POST, PATCH, DELETE)
 * so the type-to-default lookup the workers do in Phase 4 can never
 * land a null default.
 *
 * Ownership:
 * - Operator owns the file. Dashboard CRUD routes mutate via
 *   `writeLists`. Boot-time `ensureListsFile` seeds the file on first
 *   boot (or when missing) so new repos start with the canonical
 *   7-list taxonomy.
 * - Workers READ via `readLists` / `getDefaultListForType`. Reads
 *   degrade to the default seed on parse failure so a corrupt file
 *   never wedges dispatch.
 *
 * Contracts:
 * - Atomic temp+rename writes serialized by the lock file at
 *   `<repo>/.danxbot/.lists.lock` AND an in-process promise chain
 *   keyed by file path (mirror of `settings-file.ts` pattern).
 * - `validateLists` runs before every write — invalid input rejected
 *   with a `ListsValidationError` that carries the per-entry diagnostic
 *   the route layer surfaces as 400 `{errors[]}`.
 * - Stable ids: callers must pass an `id` that does not collide with
 *   any prior list (deleted or not). `writeLists` enforces this against
 *   a soft tombstone of historically-known ids tracked in the file's
 *   `tombstone_ids[]` block. Deletes record the id in the tombstone so
 *   future creates can never reuse it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "./logger.js";

const log = createLogger("lists-file");

/**
 * Semantic enum every list belongs to. Workers map a card's derived
 * status onto a list type via `getDefaultListForType`. Adding a new
 * type is a breaking schema change — every connected repo must reseed
 * the file with a corresponding default list (Phase 1's loader auto-
 * derives `list_name` from `status`, so a missing type leaves cards
 * unmapped).
 */
export type ListType =
  | "archived"
  | "review"
  | "ready"
  | "blocked"
  | "in_progress"
  | "completed"
  | "cancelled";

export const LIST_TYPES: readonly ListType[] = [
  "archived",
  "review",
  "ready",
  "blocked",
  "in_progress",
  "completed",
  "cancelled",
] as const;

const LIST_TYPES_SET: ReadonlySet<string> = new Set<string>(LIST_TYPES);

export interface List {
  id: string;
  name: string;
  type: ListType;
  order: number;
  is_default_for_type: boolean;
  color: string;
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

const NEUTRAL_LIST_COLOR = "#94a3b8";

export interface ListsFile {
  lists: List[];
  /**
   * Soft tombstone of every list id that has ever existed on this repo.
   * Tracked so a future create cannot reuse a deleted id. Append-only;
   * never pruned. The whole file is operator-visible so an operator
   * can audit + manually edit if they truly need to recycle an id.
   */
  tombstone_ids: string[];
}

export class ListsValidationError extends Error {
  public readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.name = "ListsValidationError";
    this.errors = errors;
  }
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export function listsFilePath(localPath: string): string {
  return resolve(localPath, ".danxbot/lists.yaml");
}

export function listsLockPath(localPath: string): string {
  return resolve(localPath, ".danxbot/.lists.lock");
}

/**
 * Canonical 7-list seed. Each repo's first `ensureListsFile` call
 * lands these with fresh UUIDs; subsequent boots re-read the seeded
 * ids verbatim so worker-side references stay stable.
 */
export interface SeedDeps {
  uuid?: () => string;
}

interface SeedSpec {
  type: ListType;
  name: string;
  order: number;
  color: string;
}

const SEED_SPECS: readonly SeedSpec[] = [
  { type: "archived",    name: "Backlog",     order: 0, color: "#64748b" },
  { type: "review",      name: "Review",      order: 1, color: "#3b82f6" },
  { type: "ready",       name: "To Do",       order: 2, color: "#22d3ee" },
  { type: "blocked",     name: "Blocked",     order: 3, color: "#ef4444" },
  { type: "in_progress", name: "In Progress", order: 4, color: "#f59e0b" },
  { type: "completed",   name: "Done",        order: 5, color: "#22c55e" },
  { type: "cancelled",   name: "Cancelled",   order: 6, color: "#71717a" },
] as const;

export function defaultLists(deps: SeedDeps = {}): ListsFile {
  const uuid = deps.uuid ?? randomUUID;
  return {
    lists: SEED_SPECS.map((s) => ({
      id: uuid(),
      name: s.name,
      type: s.type,
      order: s.order,
      is_default_for_type: true,
      color: s.color,
    })),
    tombstone_ids: [],
  };
}

/**
 * Read the file. Never throws — on parse / IO failure logs and returns
 * a fresh seed so workers continue to dispatch. The dashboard route
 * layer surfaces a 500 on its own when an explicit operator action
 * fails; this read-side path is the hot-path workers use on every tick.
 */
export function readLists(localPath: string): ListsFile {
  const path = listsFilePath(localPath);
  if (!existsSync(path)) return defaultLists();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as Partial<ListsFile> | null;
    return normalize(parsed);
  } catch (err) {
    log.error(`Failed to parse ${path} — degrading to seed`, err);
    return defaultLists();
  }
}

function normalize(raw: Partial<ListsFile> | null | undefined): ListsFile {
  if (!raw || typeof raw !== "object") return defaultLists();
  const rawLists = Array.isArray(raw.lists) ? raw.lists : [];
  // Deterministic color backfill for legacy files that pre-date the
  // `color` field (DX-601). A pre-bump file shape passes every other
  // invariant; we map type → seeded color so reads stay non-throwing
  // and the next operator write re-persists the backfilled shape.
  // Non-default entries fall back to the type's seed color too — a
  // user-created "Triage" list seeded from a "Review" parent gets the
  // review hue, matching applyCreateList's inheritance path.
  const seedColorByType = new Map<ListType, string>(
    SEED_SPECS.map((s) => [s.type, s.color] as const),
  );
  const backfilled = rawLists
    .map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const e = entry as unknown as Record<string, unknown>;
      if (typeof e.color === "string" && e.color.length > 0) return entry;
      const fallback = LIST_TYPES_SET.has(e.type as string)
        ? seedColorByType.get(e.type as ListType) ?? NEUTRAL_LIST_COLOR
        : NEUTRAL_LIST_COLOR;
      return { ...e, color: fallback };
    });
  const lists = backfilled.filter(isValidListShape);
  const tombstone_ids = Array.isArray(raw.tombstone_ids)
    ? raw.tombstone_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  // Read-side never throws on invariant violations — that surface is
  // the write path. Read returns the on-disk state as-is so a manual
  // edit can produce a momentarily-invalid file that the next dashboard
  // write surfaces as a 400.
  return { lists, tombstone_ids };
}

function isValidListShape(raw: unknown): raw is List {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id.length > 0 &&
    typeof r.name === "string" && r.name.length > 0 &&
    typeof r.type === "string" && LIST_TYPES_SET.has(r.type) &&
    typeof r.order === "number" && Number.isFinite(r.order) &&
    typeof r.is_default_for_type === "boolean" &&
    isValidHexColor(r.color)
  );
}

/**
 * Throws `ListsValidationError` with every diagnostic gathered if any
 * invariant fails. Invariants:
 *  - Every entry has the required fields with the right types.
 *  - Ids are non-empty + unique within `lists[]`.
 *  - Ids never appear in `tombstone_ids[]` (deleted ids stay dead).
 *  - Every `type` is one of `LIST_TYPES`.
 *  - For every type, EXACTLY ONE entry has `is_default_for_type: true`.
 *  - For every type, at least one entry exists (the ≥1-per-type rule).
 */
export function validateLists(file: ListsFile): void {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const tombstone = new Set(file.tombstone_ids);

  for (let i = 0; i < file.lists.length; i++) {
    const l = file.lists[i];
    if (!isValidListShape(l)) {
      // Pinpoint the failing field for the operator — bad color is the
      // common case so call it out separately from a fully-malformed entry.
      const lr = l as unknown as Record<string, unknown> | null;
      if (
        lr &&
        typeof lr === "object" &&
        typeof lr.id === "string" && (lr.id as string).length > 0 &&
        typeof lr.name === "string" && (lr.name as string).length > 0 &&
        typeof lr.type === "string" && LIST_TYPES_SET.has(lr.type as string) &&
        typeof lr.order === "number" && Number.isFinite(lr.order) &&
        typeof lr.is_default_for_type === "boolean" &&
        !isValidHexColor(lr.color)
      ) {
        errors.push(
          `lists[${i}].color must be a hex color like "#abc" or "#aabbcc" (got ${JSON.stringify(lr.color)})`,
        );
      } else {
        errors.push(`lists[${i}] missing required field or wrong type`);
      }
      continue;
    }
    if (seenIds.has(l.id)) {
      errors.push(`lists[${i}].id "${l.id}" duplicates an earlier entry`);
    }
    seenIds.add(l.id);
    if (tombstone.has(l.id)) {
      errors.push(`lists[${i}].id "${l.id}" was previously deleted — ids never reused`);
    }
    if (l.order < 0) {
      errors.push(`lists[${i}].order must be ≥ 0 (got ${l.order})`);
    }
  }

  const byType = new Map<ListType, List[]>();
  for (const l of file.lists) {
    if (!LIST_TYPES_SET.has(l.type)) continue;
    let bucket = byType.get(l.type);
    if (!bucket) {
      bucket = [];
      byType.set(l.type, bucket);
    }
    bucket.push(l);
  }

  for (const type of LIST_TYPES) {
    const bucket = byType.get(type) ?? [];
    if (bucket.length === 0) {
      errors.push(`No list defined for type "${type}" — every type requires ≥1 list`);
      continue;
    }
    const defaults = bucket.filter((l) => l.is_default_for_type);
    if (defaults.length === 0) {
      errors.push(`Type "${type}" has no list with is_default_for_type=true`);
    } else if (defaults.length > 1) {
      errors.push(
        `Type "${type}" has ${defaults.length} defaults — exactly one required: [${defaults
          .map((l) => l.name)
          .join(", ")}]`,
      );
    }
  }

  if (errors.length > 0) throw new ListsValidationError(errors);
}

/**
 * Hot-path lookup: given a type, return its default list. Throws if
 * the file is missing a default for the type (which can only happen
 * via a manual file edit — `writeLists` rejects writes that would
 * violate the invariant). Workers calling this can treat the throw
 * as a real bug; the read-side normalize wrapper above prevents
 * normal hot-path corruption.
 */
export function getDefaultListForType(
  localPath: string,
  type: ListType,
): List {
  const file = readLists(localPath);
  const match = file.lists.find(
    (l) => l.type === type && l.is_default_for_type,
  );
  if (!match) {
    throw new Error(
      `No default list for type "${type}" in ${listsFilePath(localPath)} — file may be missing or corrupt`,
    );
  }
  return match;
}

/**
 * Boot-time + setup-time seeder. Creates the file with the canonical
 * 7-list seed if missing. Idempotent: if the file already exists it
 * is left untouched (operator overrides survive every restart). Same
 * model as `syncSettingsFileOnBoot` for `settings.json`.
 */
export async function ensureListsFile(
  localPath: string,
  deps: SeedDeps = {},
): Promise<void> {
  const path = listsFilePath(localPath);
  if (existsSync(path)) return;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const seed = defaultLists(deps);
  await writeListsRaw(localPath, seed);
}

const inProcessQueues = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(
  localPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = listsFilePath(localPath);
  const prev = (inProcessQueues.get(key) ?? Promise.resolve()) as Promise<unknown>;
  const next = prev.then(run, run);
  inProcessQueues.set(key, next);
  next
    .finally(() => {
      if (inProcessQueues.get(key) === next) {
        inProcessQueues.delete(key);
      }
    })
    .catch(() => undefined);
  return next;
}

/**
 * Atomic + validated write. Caller passes the full target state of
 * the file. `validateLists` is invoked under the lock so concurrent
 * writers cannot smuggle an invariant violation past a stale read.
 * The route layer's CRUD helpers (`createList`, `updateList`,
 * `deleteList`) are the typical entry points; raw `writeLists`
 * exists for `ensureListsFile` + tests.
 */
export async function writeLists(
  localPath: string,
  file: ListsFile,
): Promise<ListsFile> {
  return enqueueWrite(localPath, async () => {
    const release = await acquireFileLock(listsLockPath(localPath));
    try {
      validateLists(file);
      await writeListsRawUnsafe(localPath, file);
      return file;
    } finally {
      await release();
    }
  });
}

/**
 * Non-validating raw write — for `ensureListsFile` seed only, where
 * `defaultLists()` is the constructor for the value and is trusted by
 * construction. Still acquires the lock + uses atomic temp+rename.
 */
async function writeListsRaw(
  localPath: string,
  file: ListsFile,
): Promise<void> {
  await enqueueWrite(localPath, async () => {
    const release = await acquireFileLock(listsLockPath(localPath));
    try {
      await writeListsRawUnsafe(localPath, file);
    } finally {
      await release();
    }
  });
}

async function writeListsRawUnsafe(
  localPath: string,
  file: ListsFile,
): Promise<void> {
  const path = listsFilePath(localPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = stringifyYaml(file, { lineWidth: 0 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/**
 * Atomic per-file lock. `fs.open(path, "wx")` fails with EEXIST when
 * the file already exists; retry with exponential backoff up to
 * LOCK_TIMEOUT_MS. Stale locks older than LOCK_STALE_MS are stolen.
 * Mirror of `settings-file.ts#acquireFileLock`.
 */
async function acquireFileLock(lockFile: string): Promise<() => Promise<void>> {
  const dir = dirname(lockFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  while (true) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.write(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return async () => {
        try {
          unlinkSync(lockFile);
        } catch {
          /* best-effort */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const stat = statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          log.warn(
            `Stealing stale lists lock at ${lockFile} (age ${Math.round(
              (Date.now() - stat.mtimeMs) / 1000,
            )}s)`,
          );
          try {
            unlinkSync(lockFile);
          } catch {
            /* ignore */
          }
          continue;
        }
      } catch {
        /* stat failed — race; retry */
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timeout acquiring lists lock at ${lockFile} after ${LOCK_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/**
 * Mutation helpers — pure functions over `ListsFile` that the route
 * layer composes with `readLists` + `writeLists`. Each returns the
 * post-mutation file; the caller passes it through `writeLists` to
 * persist (which re-runs `validateLists` under the lock).
 */
export interface CreateListInput {
  name: string;
  type: ListType;
  order?: number;
  is_default_for_type?: boolean;
  color?: string;
}

/**
 * Update surface. `type` is intentionally NOT patchable: a cross-type
 * move would either orphan the source type (last-of-type violation) or
 * land two defaults on the destination type — both invariant breaks
 * that the unique-default + ≥1-per-type rules would then reject under
 * the lock with a confusing 400. Operator workflow for a real type
 * migration is "create a new list of the target type, reassign the
 * cards via PATCH /api/issues, delete the old list."
 */
export interface UpdateListInput {
  name?: string;
  order?: number;
  is_default_for_type?: boolean;
  color?: string;
}

/**
 * Append a new list. Generates a fresh id; if `is_default_for_type` is
 * true, demotes the existing default of the same type so the
 * exactly-one-default invariant stays satisfied.
 *
 * Pre-validation: shape-checks `input` and throws a synchronous
 * `ListsValidationError` on malformed input so the dashboard route
 * surfaces 400 before any lock is acquired.
 */
export interface CreateListResult {
  file: ListsFile;
  created: List;
}

export function applyCreateList(
  file: ListsFile,
  input: CreateListInput,
  deps: SeedDeps = {},
): CreateListResult {
  const uuid = deps.uuid ?? randomUUID;
  validateCreateInput(input);
  const id = uuid();
  const order =
    typeof input.order === "number" && Number.isFinite(input.order)
      ? input.order
      : nextOrderForType(file, input.type);
  const promotingDefault = input.is_default_for_type === true;
  // Auto-promote when this is the first list of a previously-empty
  // type so the exactly-one-default invariant holds without the
  // caller having to remember the flag.
  const noExistingDefault = !file.lists.some(
    (l) => l.type === input.type && l.is_default_for_type,
  );
  const becomesDefault = promotingDefault || noExistingDefault;
  const lists = file.lists.map((l) =>
    becomesDefault && l.type === input.type && l.is_default_for_type
      ? { ...l, is_default_for_type: false }
      : l,
  );
  // Inherit color from the existing default-of-type when the caller
  // does not supply one, so a "+ Add list" affordance can leave it
  // empty and still produce a visually-coherent row. Falls back to
  // a neutral gray when the type is freshly empty.
  const inheritedColor =
    file.lists.find((l) => l.type === input.type && l.is_default_for_type)?.color ??
    NEUTRAL_LIST_COLOR;
  const created: List = {
    id,
    name: input.name,
    type: input.type,
    order,
    is_default_for_type: becomesDefault,
    color: input.color ?? inheritedColor,
  };
  lists.push(created);
  return { file: { ...file, lists }, created };
}

function nextOrderForType(file: ListsFile, type: ListType): number {
  const max = file.lists
    .filter((l) => l.type === type)
    .reduce((acc, l) => Math.max(acc, l.order), -1);
  return max + 1;
}

function validateCreateInput(input: CreateListInput): void {
  const errors: string[] = [];
  if (typeof input.name !== "string" || input.name.length === 0) {
    errors.push("name must be a non-empty string");
  }
  if (typeof input.type !== "string" || !LIST_TYPES_SET.has(input.type)) {
    errors.push(`type must be one of [${LIST_TYPES.join(", ")}]`);
  }
  if (input.order !== undefined) {
    if (typeof input.order !== "number" || !Number.isFinite(input.order)) {
      errors.push("order must be a finite number");
    } else if (input.order < 0) {
      errors.push("order must be ≥ 0");
    }
  }
  if (input.is_default_for_type !== undefined && typeof input.is_default_for_type !== "boolean") {
    errors.push("is_default_for_type must be a boolean");
  }
  if (input.color !== undefined && !isValidHexColor(input.color)) {
    errors.push(`color must be a hex color like "#abc" or "#aabbcc"`);
  }
  if (errors.length > 0) throw new ListsValidationError(errors);
}

/**
 * Patch an existing list. Throws `ListsValidationError` if the id is
 * unknown or the patch shape is bad. Promoting a list to default
 * demotes the prior default of its type so the invariant holds.
 */
export function applyUpdateList(
  file: ListsFile,
  id: string,
  patch: UpdateListInput,
): ListsFile {
  validateUpdateInput(patch);
  const target = file.lists.find((l) => l.id === id);
  if (!target) {
    throw new ListsValidationError([`No list with id "${id}"`]);
  }
  const promotingDefault = patch.is_default_for_type === true;
  const demotingDefault =
    patch.is_default_for_type === false && target.is_default_for_type;

  // Disallow demoting the last default for a type — would violate
  // the "exactly one default per type" invariant. Operator must
  // promote a different list of the same type in the same patch
  // (a future PATCH could accept multi-field, but the simpler rule
  // is: demote is rejected when it would leave the type without a
  // default).
  if (demotingDefault) {
    throw new ListsValidationError([
      `Cannot set is_default_for_type=false on the only default for type "${target.type}" — promote another list of this type first`,
    ]);
  }

  const lists = file.lists.map((l) => {
    if (l.id === id) {
      return {
        ...l,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.order !== undefined ? { order: patch.order } : {}),
        ...(patch.is_default_for_type !== undefined
          ? { is_default_for_type: patch.is_default_for_type }
          : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
      };
    }
    // Demote any other default-of-target-type when promoting this one.
    if (promotingDefault && l.type === target.type && l.is_default_for_type) {
      return { ...l, is_default_for_type: false };
    }
    return l;
  });

  return { ...file, lists };
}

function validateUpdateInput(patch: UpdateListInput): void {
  const errors: string[] = [];
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.length === 0) {
      errors.push("name must be a non-empty string");
    }
  }
  if (patch.order !== undefined) {
    if (typeof patch.order !== "number" || !Number.isFinite(patch.order)) {
      errors.push("order must be a finite number");
    } else if (patch.order < 0) {
      errors.push("order must be ≥ 0");
    }
  }
  if (patch.is_default_for_type !== undefined && typeof patch.is_default_for_type !== "boolean") {
    errors.push("is_default_for_type must be a boolean");
  }
  if (patch.color !== undefined && !isValidHexColor(patch.color)) {
    errors.push(`color must be a hex color like "#abc" or "#aabbcc"`);
  }
  if (Object.keys(patch).length === 0) {
    errors.push("Empty patch");
  }
  if (errors.length > 0) throw new ListsValidationError(errors);
}

export interface DeleteListResult {
  file: ListsFile;
  deleted: List;
  /** The list that newly-orphaned cards reassign to. */
  reassignTo: List;
}

/**
 * Delete a list by id. Refuses last-of-type with a
 * `ListsValidationError`. When the deleted list was the default for
 * its type, promotes the next remaining list of the same type
 * (lowest `order`, tie-break by id) to default so the invariant holds.
 * Appends the deleted id to `tombstone_ids`.
 *
 * Returns the post-mutation file plus the `reassignTo` list — the
 * route layer uses `reassignTo` to update affected card YAMLs that
 * carried `list_name == deleted.name`.
 */
export function applyDeleteList(
  file: ListsFile,
  id: string,
): DeleteListResult {
  const target = file.lists.find((l) => l.id === id);
  if (!target) {
    throw new ListsValidationError([`No list with id "${id}"`]);
  }
  const siblings = file.lists.filter(
    (l) => l.type === target.type && l.id !== id,
  );
  if (siblings.length === 0) {
    throw new ListsValidationError([
      `Cannot delete "${target.name}" — it is the last list of type "${target.type}". Create another list of this type first.`,
    ]);
  }

  // Pick the reassignment target: existing default of the type if the
  // deleted list wasn't itself the default, otherwise the lowest-order
  // sibling (tie-break by id). The resulting list becomes the new
  // default if needed.
  const existingDefault = siblings.find((l) => l.is_default_for_type);
  const reassignTo =
    existingDefault ??
    [...siblings].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];

  const lists = file.lists
    .filter((l) => l.id !== id)
    .map((l) =>
      // Promote the reassignment target to default when the deleted
      // entry was the type's default and no other default exists.
      target.is_default_for_type && !existingDefault && l.id === reassignTo.id
        ? { ...l, is_default_for_type: true }
        : l,
    );

  return {
    file: {
      lists,
      tombstone_ids: [...file.tombstone_ids, id],
    },
    deleted: target,
    reassignTo,
  };
}

/**
 * Test-only — clear the in-process queue so a previous test's
 * unresolved write doesn't leak into the next.
 */
export function _resetForTesting(): void {
  inProcessQueues.clear();
}
