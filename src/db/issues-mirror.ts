/**
 * DB mirror for `<repo>/.danxbot/issues/{open,closed}/*.yml` (epic DX-545,
 * post-phase-4 contract).
 *
 * Two write paths reach the `issues` table:
 *
 *   1. Writer-owned synchronous upsert — `writeIssue`
 *      (`src/poller/yaml-lifecycle.ts`) calls `upsertIssueRowNow` BEFORE
 *      `writeFileSync`. By the time the writer's promise resolves, the
 *      DB row is current. DB-backed `loadLocal` returns fresh state
 *      immediately for callers in the same process.
 *   2. Chokidar watcher backstop — covers external writers (operator
 *      hand-edits, `git pull`, agents in dispatched workspaces) and
 *      catches anything path (1) might have skipped. Own-writes from
 *      path (1) hit the canonical-no-op short-circuit (`existing.
 *      content_hash === contentHash`) and skip the upsert + history
 *      row, so the watcher path stays consistent with no duplicate
 *      writes.
 *
 * Both paths share the canonical content-hash dedup: a no-op write that
 * produces the same canonical bytes generates no new history row.
 *
 * Failure model: any uncaught error from the upsert / history transaction
 * writes `<repo>/.danxbot/CRITICAL_FAILURE` via the existing helper. The
 * mirror keeps running so the next operator-fixed write recovers, but the
 * poller halts on its next tick. Active dispatches finish naturally.
 *
 * Boot scan + 10-min reconcile cover anything chokidar misses (worker
 * restart, NFS-style watch race, deploy gap). Boot scan blocks
 * `startIssuesMirror`'s returned Promise so callers see a consistent DB
 * before they start serving reads.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { createPatch } from "rfc6902";
import { parse as parseYamlText } from "yaml";
import type { Pool, PoolClient } from "pg";
import { canonicalize, sha256 } from "./canonicalize.js";
import { writeFlag } from "../critical-failure.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import { createLogger } from "../logger.js";
import { setRepoName, clearRepoName } from "../poller/repo-name.js";

const log = createLogger("issues-mirror");

const DEFAULT_RECONCILE_MS = 600_000;
const DEFAULT_AWAIT_WRITE_FINISH = {
  // 5s debounce — wait until the file size has been stable for this
  // long before emitting add/change. Smooths over the create-then-edit
  // burst from `danx_issue_create` (allocates `<PREFIX>-N`, writes
  // skeleton, agent then fills body) + the open↔closed move flurry
  // (write closed/, unlink open/, optional retag). Without this, the
  // mirror catches mid-write JSONB with empty `id` / `external_id` and
  // produces ghost rows that crash dashboard `/api/issues`.
  stabilityThreshold: 5000,
  pollInterval: 100,
} as const;

export type EventSource = "watcher" | "boot-scan" | "reconcile" | "writer";

export interface UpsertArgs {
  repoName: string;
  id: string;
  data: Record<string, unknown>;
  contentHash: string;
  prevData: Record<string, unknown> | null;
  prevHash: string | null;
  source: EventSource;
}

export interface TombstoneArgs {
  repoName: string;
  id: string;
  existingData: Record<string, unknown>;
  existingHash: string;
  source: EventSource;
}

export interface IssuesMirrorDb {
  selectExisting(
    repoName: string,
    id: string,
  ): Promise<{ data: Record<string, unknown>; content_hash: string } | null>;

  upsertWithHistory(args: UpsertArgs): Promise<void>;

  tombstone(args: TombstoneArgs): Promise<void>;

  listIds(
    repoName: string,
  ): Promise<Array<{ id: string; content_hash: string }>>;
}

export interface SimulateOpts {
  event: "add" | "change" | "unlink";
  path: string;
}

export interface IssuesMirror {
  readonly repoName: string;
  readonly repoLocalPath: string;

  simulateWatcherEvent(opts: SimulateOpts): Promise<void>;

  /** Trigger the same logic the periodic timer runs. Tests + ops only. */
  reconcileNow(): Promise<void>;

  stop(): Promise<void>;
}

export interface StartIssuesMirrorOptions {
  /** Period for the open/-only reconcile timer; default 600_000ms. */
  reconcileIntervalMs?: number;
  /** Inject a custom DB layer (unit tests). Production: omitted, built from pool. */
  db?: IssuesMirrorDb;
  /** Inject a Pool (integration tests). Production: getPool(). */
  pool?: Pool;
  /**
   * Disable chokidar entirely. Unit tests drive events via
   * `simulateWatcherEvent`; this flag exists so the constructor does not
   * touch the filesystem watcher in those scenarios.
   */
  disableWatcher?: boolean;
  /**
   * Called once per watcher-sourced filesystem event (`add` / `change`),
   * AFTER the DB row reflects the new content. Phase 1 of the
   * Event-Driven Worker epic (DX-215 / DX-216) wires this to
   * `reconcileIssue(repo, id, "watcher")`. Invoked even when the upsert
   * was a no-op (content unchanged), so every fs event reaches reconcile;
   * the precondition the parenthetical hand-off makes is "the DB row is
   * in place," not "an upsert ran on this tick".
   *
   * Errors thrown from the callback are caught + logged here and routed
   * through `recordSystemError({source: "reconcile"})` so a reconcile
   * crash never kills the watcher. Callers MUST NOT silently swallow
   * errors inside the callback — surfacing failures is the entire
   * reason the wiring point catches.
   */
  onWatcherUpsert?: (id: string) => Promise<void>;
  /**
   * Override chokidar's `awaitWriteFinish` debounce. Production callers
   * MUST omit — `DEFAULT_AWAIT_WRITE_FINISH` (5s threshold) smooths the
   * mid-write JSONB race documented above. Test fixtures pass tight
   * values (e.g. `{stabilityThreshold: 50, pollInterval: 25}`) so the
   * watcher fires inside vitest's default 5000ms test budget — without
   * this knob the integration suite ties with the test timeout and
   * times out 7/9 tests on every host (DX-223).
   */
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
}

export interface RepoContextLike {
  name: string;
  localPath: string;
}

const mirrorRegistry = new Map<string, IssuesMirror>();

export function getMirrorByLocalPath(
  repoLocalPath: string,
): IssuesMirror | undefined {
  return mirrorRegistry.get(resolve(repoLocalPath));
}

/**
 * Writer-side DB registry (DX-547, Phase 2 of the DB-mirror writer-ownership
 * epic DX-545). Maps a repo's local path to the `IssuesMirrorDb` layer the
 * synchronous `upsertIssueRowNow` should use. Registered by
 * `startIssuesMirror` at boot — every production writer call goes through
 * this map. Test fixtures register a `FakeDb`; unit tests that never boot
 * the mirror skip registration and `upsertIssueRowNow` returns a no-op so
 * the file-only legacy path (pre-DX-547) keeps working without touching pg.
 */
const writerDbRegistry = new Map<string, IssuesMirrorDb>();

export function registerWriterDb(
  repoLocalPath: string,
  db: IssuesMirrorDb,
): void {
  writerDbRegistry.set(resolve(repoLocalPath), db);
}

export function unregisterWriterDb(repoLocalPath: string): void {
  writerDbRegistry.delete(resolve(repoLocalPath));
}

export function getWriterDb(repoLocalPath: string): IssuesMirrorDb | undefined {
  return writerDbRegistry.get(resolve(repoLocalPath));
}

export interface UpsertIssueRowNowArgs {
  repoName: string;
  repoLocalPath: string;
  id: string;
  data: Record<string, unknown>;
  contentHash: string;
  source: "writer";
}

/**
 * Synchronous DB upsert for the YAML writer (DX-547 Phase 2). Called by
 * `writeIssue` BEFORE `writeFileSync` so the DB row is the source of "did
 * this land" and the file write is the propagation channel to external
 * readers (dispatched agents). Internally:
 *
 *  1. Look up the writer DB for this repo. No registration (pure unit
 *     tests, dashboard-mode boot before mirror starts) → no-op return.
 *     Production callers always run after the mirror's `startIssuesMirror`
 *     so the lookup hits.
 *  2. `selectExisting` to compute prev_hash + canonical no-op short-
 *     circuit (existing.content_hash === contentHash → skip upsert + skip
 *     history row, return immediately).
 *  3. `upsertWithHistory` to write the row + an `issue_history` entry
 *     carrying `source: "writer"`.
 *  4. On uncaught failure: route through `writeFlag` (CRITICAL_FAILURE)
 *     the same way the mirror's per-event reportFailure does, then
 *     rethrow so the caller's promise rejects. The poller halts on its
 *     next tick.
 *
 * Does NOT fire `onWatcherUpsert` — that callback is the reconcile chain
 * trigger and is wired to chokidar's path, not the writer's. The chokidar
 * watcher will fire later (5s debounce), find the hash already matches,
 * and run the existing skip-match branch — which DOES fire
 * `onWatcherUpsert` for reconcile fanout. So reconcile still runs exactly
 * once per writer save (after the file write propagates).
 */
export async function upsertIssueRowNow(
  args: UpsertIssueRowNowArgs,
): Promise<void> {
  const db = getWriterDb(args.repoLocalPath);
  if (!db) return;
  let existing:
    | { data: Record<string, unknown>; content_hash: string }
    | null;
  try {
    existing = await db.selectExisting(args.repoName, args.id);
  } catch (err) {
    reportWriterFailure(
      args.repoLocalPath,
      args.repoName,
      `select existing for ${args.id}`,
      err,
    );
    throw err;
  }
  if (existing && existing.content_hash === args.contentHash) {
    // Canonical no-op: identical hash means the row already reflects this
    // write. Skip the upsert + history row so a re-save of unchanged
    // bytes does not pollute `issue_history` with redundant patches.
    return;
  }
  try {
    await db.upsertWithHistory({
      repoName: args.repoName,
      id: args.id,
      data: args.data,
      contentHash: args.contentHash,
      prevData: existing?.data ?? null,
      prevHash: existing?.content_hash ?? null,
      source: "writer",
    });
  } catch (err) {
    reportWriterFailure(
      args.repoLocalPath,
      args.repoName,
      `upsert ${args.id}`,
      err,
    );
    throw err;
  }
}

function reportWriterFailure(
  repoLocalPath: string,
  repoName: string,
  reason: string,
  err: unknown,
): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  log.error(`[${repoName}] writer DB write failure: ${reason}`, err);
  try {
    writeFlag(repoLocalPath, {
      source: "issues-db-mirror",
      dispatchId: "issues-db-mirror",
      reason: `Issues mirror writer DB write failed: ${reason}`,
      detail,
    });
  } catch (writeErr) {
    log.error(
      `[${repoName}] writer CRITICAL_FAILURE flag write also failed`,
      writeErr,
    );
  }
}

/**
 * Whether ANY mirror is currently active. Used by writeIssue's legacy-
 * path detection — a unit-test environment without a worker has zero
 * mirrors; production has one per loaded repo.
 */
export function hasAnyMirror(): boolean {
  return mirrorRegistry.size > 0;
}

function pendingKey(repoName: string, id: string, contentHash: string): string {
  return `${repoName} ${id} ${contentHash}`;
}

function deriveIdFromPath(path: string): string {
  return basename(path).replace(/\.yml$/, "");
}

function issuesDir(repoLocalPath: string): string {
  return resolve(repoLocalPath, ".danxbot", "issues");
}

interface ReadResult {
  id: string;
  data: Record<string, unknown>;
}

function readAndParse(path: string): ReadResult | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYamlText(text);
  } catch (err) {
    log.warn(
      `Parse error in ${path}: ${(err as Error).message} — storing as malformed`,
    );
    const stem = deriveIdFromPath(path);
    return {
      id: stem,
      // Stamp `id` into the jsonb so the generated column on the `issues`
      // table picks up a value — the (repo_name, id) PK rejects NULL ids,
      // and an unparseable YAML otherwise has no `id` field. The stem is
      // the only signal we have for which card the file represents.
      data: { id: stem, _malformed: true, raw: text },
    };
  }
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    log.warn(`Non-object YAML in ${path} — storing as malformed`);
    const stem = deriveIdFromPath(path);
    return {
      id: stem,
      data: { id: stem, _malformed: true, raw: text },
    };
  }
  const obj = parsed as Record<string, unknown>;
  const idFromYaml =
    typeof obj.id === "string" && obj.id ? obj.id : null;
  const resolvedId = idFromYaml ?? deriveIdFromPath(path);
  // Stamp `data.id` from the resolved id when the YAML's own `id` field
  // is empty/missing/wrong-type. The DB's generated column reads
  // `data->>'id'` — if the JSONB id is empty, the row appears as a ghost
  // (empty generated column) and the dashboard reader's strict check
  // throws on it, crashing the entire `/api/issues` list. Filename stem
  // is authoritative for the row identity, so make the JSONB match.
  if (obj.id !== resolvedId) {
    obj.id = resolvedId;
  }
  return { id: resolvedId, data: obj };
}

/**
 * Project the YAML's `triage.expires_at` string into a value the
 * `triage_expires_at` timestamptz column accepts. Returns:
 *   - the original ISO 8601 string when it parses (PG handles the cast)
 *   - `null` when the string is empty (never-triaged sentinel)
 *   - `null` when the string is unparseable (fail-open: the row falls
 *     into the "never-triaged" bucket and re-triage will rewrite it)
 *
 * Phase 4 (DX-155) added this projection so `listTriageDueYamls` can
 * filter on the indexed `triage_expires_at` column. The migration
 * declared the column as a regular timestamptz (not GENERATED) because
 * `text::timestamptz` is STABLE in PG — the writer is responsible for
 * populating it.
 */
function extractTriageExpiresAt(data: Record<string, unknown>): string | null {
  const triage = data.triage as { expires_at?: unknown } | undefined;
  if (!triage || typeof triage !== "object") return null;
  const raw = triage.expires_at;
  if (typeof raw !== "string" || raw === "") return null;
  if (!Number.isFinite(Date.parse(raw))) return null;
  return raw;
}

async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow ROLLBACK failure so the original error surfaces. PG
      // typically aborts the transaction itself when a query throws,
      // making the explicit ROLLBACK best-effort.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Production DB-layer factory. Wraps a pg Pool with the per-event
 * upsert/tombstone transactions Phase 3 needs. Unit tests skip this
 * entirely by passing their own `IssuesMirrorDb` to `startIssuesMirror`.
 */
export function createPgIssuesMirrorDb(pool: Pool): IssuesMirrorDb {
  return {
    async selectExisting(repoName, id) {
      const result = await pool.query<{
        data: Record<string, unknown>;
        content_hash: string;
      }>(
        `SELECT data, content_hash FROM issues WHERE repo_name = $1 AND id = $2`,
        [repoName, id],
      );
      return result.rows[0] ?? null;
    },

    async upsertWithHistory(args) {
      const patch = createPatch(args.prevData ?? {}, args.data);
      const triageExpiresAt = extractTriageExpiresAt(args.data);
      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at, triage_expires_at)
           VALUES ($1, $2::jsonb, $3, now(), $4)
           ON CONFLICT (repo_name, id) DO UPDATE
             SET data = EXCLUDED.data,
                 content_hash = EXCLUDED.content_hash,
                 mirror_updated_at = now(),
                 triage_expires_at = EXCLUDED.triage_expires_at`,
          [
            args.repoName,
            JSON.stringify(args.data),
            args.contentHash,
            triageExpiresAt,
          ],
        );
        await client.query(
          `INSERT INTO issue_history
             (repo_name, issue_id, "source", patch, prev_hash, next_hash)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            args.repoName,
            args.id,
            args.source,
            JSON.stringify(patch),
            args.prevHash,
            args.contentHash,
          ],
        );
      });
    },

    async tombstone(args) {
      const patch = createPatch(args.existingData, {});
      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO issue_history
             (repo_name, issue_id, "source", patch, prev_hash, next_hash)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            args.repoName,
            args.id,
            args.source,
            JSON.stringify(patch),
            args.existingHash,
            "",
          ],
        );
        await client.query(
          `DELETE FROM issues WHERE repo_name = $1 AND id = $2`,
          [args.repoName, args.id],
        );
      });
    },

    async listIds(repoName) {
      const result = await pool.query<{ id: string; content_hash: string }>(
        `SELECT id, content_hash FROM issues WHERE repo_name = $1`,
        [repoName],
      );
      return result.rows;
    },
  };
}

/**
 * Boot the mirror for a single repo. Returns a handle once the boot scan
 * has fully populated the DB. The chokidar watcher and the 10-minute
 * reconcile timer run for the lifetime of the handle.
 */
export async function startIssuesMirror(
  ctx: RepoContextLike,
  options: StartIssuesMirrorOptions = {},
): Promise<IssuesMirror> {
  const repoName = ctx.name;
  const repoLocalPath = ctx.localPath;
  const reconcileIntervalMs =
    options.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;

  if (!options.db && !options.pool) {
    throw new Error(
      "startIssuesMirror: must supply either { db } (mock layer) or { pool } " +
        "(pg Pool the production factory wraps). Pure module — no implicit getPool() import.",
    );
  }
  const db: IssuesMirrorDb =
    options.db ?? createPgIssuesMirrorDb(options.pool!);

  let watcher: FSWatcher | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  // Track in-flight processing promises so `stop()` can drain them
  // before tearing down the watcher. Without this, an upsert running
  // concurrently with `stop()` would mutate the DB AFTER the mirror
  // believes it has shut down — at best harmless, at worst masking a
  // regression.
  const inFlight = new Set<Promise<unknown>>();
  function trackInFlight<T>(p: Promise<T>): Promise<T> {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    return p;
  }

  function reportFailure(reason: string, err: unknown): void {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    log.error(`[${repoName}] DB write failure: ${reason}`, err);
    try {
      writeFlag(repoLocalPath, {
        source: "issues-db-mirror",
        dispatchId: "issues-db-mirror",
        reason: `Issues mirror DB write failed: ${reason}`,
        detail,
      });
    } catch (writeErr) {
      log.error(
        `[${repoName}] CRITICAL_FAILURE write also failed`,
        writeErr,
      );
    }
  }

  /**
   * Single-file mirror step shared by `processFileEvent`, `bootScan`,
   * and `periodicReconcile`. Reads + hashes + dedup-skips + upserts, in
   * that order. Returns the parsed id on success (so the boot scan can
   * mark it as "seen on disk") or null when the file was missing / a DB
   * read failed (already routed through CRITICAL_FAILURE).
   */
  async function mirrorOne(
    path: string,
    source: EventSource,
  ): Promise<string | null> {
    const parsed = readAndParse(path);
    if (!parsed) return null; // ENOENT race — unlink will catch up
    const contentHash = sha256(canonicalize(parsed.data));
    let existing:
      | { data: Record<string, unknown>; content_hash: string }
      | null;
    try {
      existing = await db.selectExisting(repoName, parsed.id);
    } catch (err) {
      reportFailure(`select existing for ${parsed.id}`, err);
      return null;
    }
    if (existing && existing.content_hash === contentHash) {
      // Same content — DB already reflects this hash. Skip the upsert +
      // history insert. Post phase 2, the writer pre-populates the DB
      // row before the file write — so for own-writes this branch is
      // the dominant case. The skip-match log lets the operator confirm
      // the external-vs-own write distribution from a worker log scan.
      log.debug(
        `[${repoName}] mirrored ${parsed.id} (source=${source}, action=skip-match)`,
      );
      // The DB row is in place (from a prior tick). The fs event still
      // reached us, so reconcile MUST fire — its fanout is independent
      // of whether THIS tick wrote a row.
      await fireOnWatcherUpsert(parsed.id, source);
      return parsed.id;
    }
    try {
      await db.upsertWithHistory({
        repoName,
        id: parsed.id,
        data: parsed.data,
        contentHash,
        prevData: existing?.data ?? null,
        prevHash: existing?.content_hash ?? null,
        source,
      });
    } catch (err) {
      reportFailure(`upsert ${parsed.id}`, err);
      return null;
    }
    log.debug(
      `[${repoName}] mirrored ${parsed.id} (source=${source}, action=upsert)`,
    );
    await fireOnWatcherUpsert(parsed.id, source);
    return parsed.id;
  }

  /**
   * Phase 1 of the Event-Driven Worker epic (DX-215 / DX-216): notify the
   * reconcile chokepoint that a watcher-sourced filesystem event landed
   * for `id`. Boot-scan / reconcile / unlink sources do NOT fire — Phase 1
   * only wires the live watcher path. Errors are routed through
   * `recordSystemError` so a reconcile crash cannot kill the watcher.
   */
  async function fireOnWatcherUpsert(
    id: string,
    source: EventSource,
  ): Promise<void> {
    if (source !== "watcher") return;
    if (!options.onWatcherUpsert) return;
    try {
      await options.onWatcherUpsert(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[${repoName}] reconcile callback failed for ${id}: ${message}`,
        err,
      );
      try {
        recordSystemError({
          source: "reconcile",
          severity: "error",
          repo: repoName,
          message: `Reconcile failed for ${id}: ${message}`,
        });
      } catch (recordErr) {
        // Defense in depth: even the error-recording path must not throw
        // through to the chokidar handler. Log and move on.
        log.error(
          `[${repoName}] recordSystemError itself failed for ${id}`,
          recordErr,
        );
      }
    }
  }

  /**
   * Single-id tombstone step shared by `processUnlink` and the boot
   * scan's missing-yaml branch. Re-fetches the row so the patch payload
   * is built from the latest data, then DELETEs the row.
   */
  async function tombstoneOne(
    id: string,
    source: EventSource,
  ): Promise<void> {
    let existing:
      | { data: Record<string, unknown>; content_hash: string }
      | null;
    try {
      existing = await db.selectExisting(repoName, id);
    } catch (err) {
      reportFailure(`select existing for tombstone ${id}`, err);
      return;
    }
    if (!existing) return;
    try {
      await db.tombstone({
        repoName,
        id,
        existingData: existing.data,
        existingHash: existing.content_hash,
        source,
      });
    } catch (err) {
      reportFailure(`tombstone ${id}`, err);
      return;
    }
    log.debug(`[${repoName}] tombstoned ${id} (source=${source})`);
  }

  async function processFileEvent(
    _event: "add" | "change",
    path: string,
    source: EventSource,
  ): Promise<void> {
    await mirrorOne(path, source);
  }

  async function processUnlink(path: string): Promise<void> {
    // Move-aware: when an agent renames open/<id>.yml ↔ closed/<id>.yml,
    // chokidar emits `add` + `unlink` for the two paths in unspecified
    // order. A blind tombstone here races and wipes the just-inserted
    // sibling row. If the sibling dir still has the YAML on disk,
    // treat the unlink as a move and let the sibling's `add`/`change`
    // own the DB state instead.
    const id = deriveIdFromPath(path);
    const base = issuesDir(repoLocalPath);
    const sibling = path.includes(`${sep}open${sep}`)
      ? resolve(base, "closed", `${id}.yml`)
      : resolve(base, "open", `${id}.yml`);
    if (existsSync(sibling)) {
      await mirrorOne(sibling, "watcher");
      return;
    }
    await tombstoneOne(id, "watcher");
  }

  function listYamlPaths(roots: Array<"open" | "closed">): string[] {
    const base = issuesDir(repoLocalPath);
    const paths: string[] = [];
    for (const root of roots) {
      const dir = resolve(base, root);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".yml")) continue;
        paths.push(resolve(dir, entry));
      }
    }
    return paths;
  }

  async function bootScan(): Promise<void> {
    const paths = listYamlPaths(["open", "closed"]);
    const seenIds = new Set<string>();
    for (const path of paths) {
      const id = await mirrorOne(path, "boot-scan");
      if (id !== null) seenIds.add(id);
    }
    // Tombstone DB rows whose YAML disappeared during the scan window.
    let dbIds: Array<{ id: string; content_hash: string }>;
    try {
      dbIds = await db.listIds(repoName);
    } catch (err) {
      reportFailure(`boot scan listIds`, err);
      return;
    }
    for (const row of dbIds) {
      if (seenIds.has(row.id)) continue;
      await tombstoneOne(row.id, "boot-scan");
    }
    log.info(
      `[${repoName}] boot scan complete: ${seenIds.size} on disk, ${dbIds.length} in DB`,
    );
  }

  async function periodicReconcile(): Promise<void> {
    // Only `open/` is rescanned — closed YAMLs rarely change and
    // chokidar covers runtime mutations.
    const paths = listYamlPaths(["open"]);
    for (const path of paths) {
      await mirrorOne(path, "reconcile");
    }
  }

  async function startWatcher(): Promise<void> {
    if (options.disableWatcher) return;
    const base = issuesDir(repoLocalPath);
    const open = resolve(base, "open");
    const closed = resolve(base, "closed");
    const w = chokidar.watch([open, closed], {
      ignoreInitial: true,
      awaitWriteFinish: { ...(options.awaitWriteFinish ?? DEFAULT_AWAIT_WRITE_FINISH) },
      persistent: true,
    });
    watcher = w;
    w.on("add", (path) => {
      if (!path.endsWith(".yml")) return;
      void trackInFlight(processFileEvent("add", path, "watcher"));
    });
    w.on("change", (path) => {
      if (!path.endsWith(".yml")) return;
      void trackInFlight(processFileEvent("change", path, "watcher"));
    });
    w.on("unlink", (path) => {
      if (!path.endsWith(".yml")) return;
      void trackInFlight(processUnlink(path));
    });
    w.on("error", (err) => {
      log.error(`[${repoName}] chokidar error`, err);
    });
    // Block startIssuesMirror's returned Promise until the watcher's
    // initial subtree scan finishes — chokidar buffers file events
    // emitted before `ready`, so a writer racing the watcher boot would
    // see lost events without this gate.
    await new Promise<void>((res) => {
      w.once("ready", () => res());
    });
  }

  function startReconcileTimer(): void {
    if (reconcileIntervalMs <= 0) return;
    reconcileTimer = setInterval(() => {
      void periodicReconcile();
    }, reconcileIntervalMs);
    if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();
  }

  // Boot scan first — block the returned Promise until DB is consistent.
  await bootScan();

  await startWatcher();
  startReconcileTimer();

  const mirror: IssuesMirror = {
    repoName,
    repoLocalPath,

    async simulateWatcherEvent({ event, path }) {
      if (event === "unlink") {
        await processUnlink(path);
      } else {
        await processFileEvent(event, path, "watcher");
      }
    },

    async reconcileNow() {
      await periodicReconcile();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      // Drain in-flight processing so the mirror's DB writes complete
      // (or fail loudly via CRITICAL_FAILURE) before we tear down. Use
      // `allSettled` so a single failure doesn't block the rest of
      // cleanup.
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      mirrorRegistry.delete(resolve(repoLocalPath));
      unregisterWriterDb(repoLocalPath);
      clearRepoName(repoLocalPath);
    },
  };

  mirrorRegistry.set(resolve(repoLocalPath), mirror);
  // DX-547 Phase 2: register the same DB layer for `upsertIssueRowNow`
  // so the writer path can upsert synchronously without going through a
  // mirror handle. Also register the repo name so writer's path → name
  // lookup matches the mirror's name (production also does this at
  // worker boot; mirroring it here keeps unit-test setups simple).
  // Both unregistered on stop().
  registerWriterDb(repoLocalPath, db);
  setRepoName(repoLocalPath, repoName);
  return mirror;
}
