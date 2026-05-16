/**
 * DX-609 — Per-repo Trello list mapping at
 * `<repo>/.danxbot/trello-list-map.yaml`.
 *
 * Phase 8b.1 of DX-575 (Computed card state). Operator-configured map
 * from danxbot list ids (the stable ids from `lists.yaml`) to Trello
 * list ids on the configured board. The outbound push consults this
 * map to decide which Trello list a card belongs on; the dashboard
 * Settings UI (Phase 8b.3) is the only writer.
 *
 * Per epic decision: the map is NEVER auto-derived from list-name
 * match — operator opts in explicitly via the Settings UI in 8b.3.
 * The file ships seeded with an empty map; cards on unmapped lists
 * are skipped at push time with a one-line warning (not agent-blocking).
 *
 * Module structure mirrors `src/lists-file.ts` — atomic temp+rename
 * writes, file lock at `<repo>/.danxbot/.trello-list-map.lock`,
 * in-process promise chain keyed by file path, lock TTL identical.
 * `TrelloListMapValidationError` parallels `ListsValidationError` so
 * the 8b.2 route layer can convert per-entry diagnostics into a 400.
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
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "./logger.js";

const log = createLogger("trello-list-map");

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/**
 * Persisted shape. Keys are danxbot list ids (the stable ids from
 * `lists.yaml`); values are Trello list ids on the board configured
 * for the repo. Unmapped danxbot lists are simply absent from the
 * object — no sentinel value.
 */
export interface TrelloListMap {
  list_id_to_trello_list_id: Record<string, string>;
}

export class TrelloListMapValidationError extends Error {
  public readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.name = "TrelloListMapValidationError";
    this.errors = errors;
  }
}

export function trelloListMapFilePath(localPath: string): string {
  return resolve(localPath, ".danxbot/trello-list-map.yaml");
}

export function trelloListMapLockPath(localPath: string): string {
  return resolve(localPath, ".danxbot/.trello-list-map.lock");
}

export function emptyTrelloListMap(): TrelloListMap {
  return { list_id_to_trello_list_id: {} };
}

/**
 * Read the file. Never throws — on parse / IO failure logs and returns
 * an empty map so consumers continue. Matches `readLists` semantics:
 * read-side is the hot path workers hit on every outbound push tick;
 * the write path is where invariant violations surface.
 */
export function readTrelloListMap(localPath: string): TrelloListMap {
  const path = trelloListMapFilePath(localPath);
  if (!existsSync(path)) return emptyTrelloListMap();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as Partial<TrelloListMap> | null;
    return normalize(parsed);
  } catch (err) {
    log.error(`Failed to parse ${path} — degrading to empty map`, err);
    return emptyTrelloListMap();
  }
}

function normalize(raw: Partial<TrelloListMap> | null | undefined): TrelloListMap {
  if (!raw || typeof raw !== "object") return emptyTrelloListMap();
  const rawMap = (raw as { list_id_to_trello_list_id?: unknown }).list_id_to_trello_list_id;
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return emptyTrelloListMap();
  }
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMap as Record<string, unknown>)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0) {
      map[k] = v;
    }
  }
  return { list_id_to_trello_list_id: map };
}

/**
 * Validate a candidate map against the set of known danxbot list ids.
 * Throws `TrelloListMapValidationError` carrying per-entry diagnostics
 * if any invariant fails. Invariants:
 *  - Shape is `{ list_id_to_trello_list_id: Record<string, string> }`.
 *  - Every key + value is a non-empty string.
 *  - Every key is a known danxbot list id (present in `knownDanxbotListIds`).
 *
 * `knownDanxbotListIds` is supplied by the caller (route layer reads
 * `lists.yaml` once) so this function stays pure — easy to test with
 * fixture inputs, no filesystem coupling.
 */
export function validateTrelloListMap(
  map: TrelloListMap,
  knownDanxbotListIds: ReadonlySet<string>,
): void {
  const errors: string[] = [];
  if (!map || typeof map !== "object") {
    throw new TrelloListMapValidationError(["map must be an object"]);
  }
  const inner = map.list_id_to_trello_list_id;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    throw new TrelloListMapValidationError([
      "list_id_to_trello_list_id must be an object",
    ]);
  }
  for (const [k, v] of Object.entries(inner)) {
    if (typeof k !== "string" || k.length === 0) {
      errors.push(`key ${JSON.stringify(k)} must be a non-empty string`);
      continue;
    }
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`list_id_to_trello_list_id[${JSON.stringify(k)}] must be a non-empty string (got ${JSON.stringify(v)})`);
      continue;
    }
    if (!knownDanxbotListIds.has(k)) {
      errors.push(`list_id_to_trello_list_id[${JSON.stringify(k)}] references unknown danxbot list id "${k}"`);
    }
  }
  if (errors.length > 0) throw new TrelloListMapValidationError(errors);
}

/**
 * Boot-time + setup-time seeder. Creates the file with an empty map
 * if missing. Idempotent: if the file already exists it is left
 * untouched (operator edits via the Settings UI in 8b.3 survive every
 * restart). Mirrors `ensureListsFile`.
 */
export async function ensureTrelloListMapFile(localPath: string): Promise<void> {
  const path = trelloListMapFilePath(localPath);
  if (existsSync(path)) return;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeTrelloListMapRaw(localPath, emptyTrelloListMap());
}

const inProcessQueues = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(
  localPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = trelloListMapFilePath(localPath);
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
 * the file plus the set of known danxbot list ids (read once from
 * `lists.yaml`). `validateTrelloListMap` runs under the lock so
 * concurrent writers cannot smuggle an invariant violation past a
 * stale read.
 */
export async function writeTrelloListMap(
  localPath: string,
  map: TrelloListMap,
  knownDanxbotListIds: ReadonlySet<string>,
): Promise<TrelloListMap> {
  return enqueueWrite(localPath, async () => {
    const release = await acquireFileLock(trelloListMapLockPath(localPath));
    try {
      validateTrelloListMap(map, knownDanxbotListIds);
      await writeTrelloListMapUnsafe(localPath, map);
      return map;
    } finally {
      await release();
    }
  });
}

/**
 * Non-validating raw write — for `ensureTrelloListMapFile` seed only,
 * where `emptyTrelloListMap()` is the constructor for the value and
 * is trusted by construction. Still acquires the lock + uses atomic
 * temp+rename.
 */
async function writeTrelloListMapRaw(
  localPath: string,
  map: TrelloListMap,
): Promise<void> {
  await enqueueWrite(localPath, async () => {
    const release = await acquireFileLock(trelloListMapLockPath(localPath));
    try {
      await writeTrelloListMapUnsafe(localPath, map);
    } finally {
      await release();
    }
  });
}

async function writeTrelloListMapUnsafe(
  localPath: string,
  map: TrelloListMap,
): Promise<void> {
  const path = trelloListMapFilePath(localPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = stringifyYaml(map, { lineWidth: 0 });
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
 * Mirror of `lists-file.ts#acquireFileLock`.
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
            `Stealing stale trello-list-map lock at ${lockFile} (age ${Math.round(
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
          `Timeout acquiring trello-list-map lock at ${lockFile} after ${LOCK_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/**
 * Classifier surface. Each danxbot list either:
 *  - `mapped` — entry exists AND the referenced trello list is on the board.
 *  - `unmapped` — no entry in the map.
 *  - `orphaned` — entry exists but the referenced trello list is NOT on the board
 *    (operator deleted / renamed it in Trello; map points at a dead id).
 *
 * Settings UI (8b.3) renders mapped → no badge, unmapped → amber,
 * orphaned → red. Outbound push (8b.2) skips cards on unmapped /
 * orphaned lists with a one-line dashboard warning.
 */
export type TrelloListMapStatus = "mapped" | "unmapped" | "orphaned";

export interface ClassifiedTrelloMapping {
  status: TrelloListMapStatus;
  trello_list_id?: string;
  trello_list_name?: string;
}

export interface DanxbotListSummary {
  id: string;
}

export interface TrelloListSummary {
  id: string;
  name: string;
}

/**
 * Classify every danxbot list against the configured map + currently-
 * known trello lists. Returned object is keyed by danxbot list id;
 * every passed danxbot list appears exactly once in the result.
 */
export function classifyTrelloListMapping(
  danxbotLists: readonly DanxbotListSummary[],
  trelloLists: readonly TrelloListSummary[],
  map: TrelloListMap,
): Record<string, ClassifiedTrelloMapping> {
  const trelloById = new Map<string, TrelloListSummary>();
  for (const t of trelloLists) {
    trelloById.set(t.id, t);
  }
  const inner = map.list_id_to_trello_list_id;
  const out: Record<string, ClassifiedTrelloMapping> = {};
  for (const l of danxbotLists) {
    const trelloId = inner[l.id];
    if (typeof trelloId !== "string" || trelloId.length === 0) {
      out[l.id] = { status: "unmapped" };
      continue;
    }
    const trello = trelloById.get(trelloId);
    if (!trello) {
      out[l.id] = { status: "orphaned", trello_list_id: trelloId };
      continue;
    }
    out[l.id] = {
      status: "mapped",
      trello_list_id: trello.id,
      trello_list_name: trello.name,
    };
  }
  return out;
}

/**
 * Test-only — clear the in-process queue so a previous test's
 * unresolved write doesn't leak into the next.
 */
export function _resetForTesting(): void {
  inProcessQueues.clear();
}
