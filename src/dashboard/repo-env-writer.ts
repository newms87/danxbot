/**
 * Atomic per-repo `.env` writer — DX-303 Phase 2 of the Trello config
 * dashboard surface. Lets the operator rotate `DANX_TRELLO_API_KEY` /
 * `DANX_TRELLO_API_TOKEN` (and any other DANX_* secret in the future)
 * from `PATCH /api/agents/:repo/trello-credentials` without SSHing into
 * the host and hand-editing the env file.
 *
 * Contract:
 *  - Reads `<repo>/.danxbot/.env`. Missing file throws — the dashboard
 *    never auto-creates one (operators bootstrap via `./install.sh`).
 *  - Parses line-by-line. Preserves blank lines, comments (`#`), and
 *    unrelated `KEY=value` pairs verbatim — only the specified keys are
 *    rewritten in place; absent keys are appended at the end.
 *  - Values are written raw (no auto-quoting). The route layer rejects
 *    newlines / null bytes / whitespace-only values so the writer can
 *    treat its input as already-sanitized.
 *  - Atomic temp+rename in the same directory; preserves the existing
 *    file mode (operators run `chmod 0600` on .env routinely).
 *  - Per-file in-process queue keyed by absolute path so two concurrent
 *    PATCH calls against the same repo don't race each other (same
 *    pattern as `settings-file.ts#inProcessQueues`).
 *
 * The chokidar watcher on `<repo>/.danxbot/.env` (see
 * `src/index.ts#startWorkerMode`) sees the rename as a `change` event
 * and logs a "restart required" warning — full live-reload of the
 * `repoContexts[0]` reference would require swapping the cached
 * `RepoContext` across ~20 downstream consumers (mirror, dispatcher,
 * MCP injection, reattach). The PATCH route surfaces `restartRequired:
 * true` to the operator instead, which is the AC-permitted shortcut
 * for credential rotation (a rare operation that already implies
 * deploy / restart awareness).
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import chokidar from "chokidar";
import { createLogger } from "../logger.js";

const log = createLogger("repo-env-writer");

/**
 * Resolve the absolute path to a connected repo's `.env`. Exported so
 * callers (tests, the watcher in `startWorkerMode`) can refer to the
 * same path without duplicating the join.
 */
export function repoEnvFilePath(repoLocalPath: string): string {
  return resolve(repoLocalPath, ".danxbot/.env");
}

export interface WriteRepoEnvVarsArgs {
  repoLocalPath: string;
  /** `key -> new value` map. Empty map is a no-op. */
  updates: Record<string, string>;
  /** Identity string for the audit log (`"dashboard:<username>"` from the route). */
  writtenBy: string;
}

/**
 * Update one or more `KEY=value` pairs in `<repo>/.danxbot/.env`,
 * preserving everything else verbatim. Returns the list of keys that
 * were actually mutated on disk (which is identical to
 * `Object.keys(updates)` once the call resolves, but returning it makes
 * the route's `{updated: [...]}` response a direct passthrough).
 *
 * Concurrency: per-file in-process promise chain so two near-
 * simultaneous PATCH calls serialize before either of them reads the
 * on-disk state — without this, both reads see the same baseline and
 * the second write clobbers the first's edit.
 */
export async function writeRepoEnvVars(
  args: WriteRepoEnvVarsArgs,
): Promise<string[]> {
  return enqueueWrite(args.repoLocalPath, () => runWrite(args));
}

const inProcessQueues = new Map<string, Promise<unknown>>();

/**
 * Indirect reference to `renameSync` so the atomic-failure invariant
 * (`runWrite` cleans up the temp file when the rename leg throws) is
 * unit-testable. ESM seals `node:fs` exports against `vi.spyOn`, so a
 * mutable internal shim is the cheapest test-injection point. Production
 * always uses the real `renameSync`; tests swap via `_setRenameImplForTesting`.
 */
let renameImpl: typeof renameSync = renameSync;

/** Test-only: swap the rename implementation. Always reset to `null` in
 * the test's `afterEach` (or via `_resetForTesting`). */
export function _setRenameImplForTesting(
  impl: typeof renameSync | null,
): void {
  renameImpl = impl ?? renameSync;
}

function enqueueWrite<T>(
  repoLocalPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = repoEnvFilePath(repoLocalPath);
  const prev = (inProcessQueues.get(key) ?? Promise.resolve()) as Promise<unknown>;
  // Chain on prev regardless of fate — the next write must run even if
  // the previous rejected. Same pattern as settings-file.ts: store
  // `next` in the map and only evict if no later writer has replaced
  // us.
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

async function runWrite(args: WriteRepoEnvVarsArgs): Promise<string[]> {
  const { repoLocalPath, updates, writtenBy } = args;
  const path = repoEnvFilePath(repoLocalPath);

  if (!existsSync(path)) {
    throw new Error(
      `Repo .env not found at ${path}. Operators bootstrap this file via ./install.sh; the dashboard never auto-creates one.`,
    );
  }

  const keysToUpdate = Object.keys(updates);
  if (keysToUpdate.length === 0) return [];

  const original = readFileSync(path, "utf-8");
  const mode = statSync(path).mode;

  const rewritten = rewriteEnvBody(original, updates);

  // Skip the disk write when nothing actually changed — keeps the
  // chokidar watcher quiet on no-op PATCHes (operators clicking save
  // without changing the field) and avoids an unnecessary rename race
  // against the watcher's `awaitWriteFinish` debounce.
  if (rewritten === original) {
    log.info(
      `[repo-env-writer] no-op write for ${path} (by ${writtenBy}) — values already match`,
    );
    return keysToUpdate;
  }

  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, rewritten, { encoding: "utf-8", mode });
  // CRITICAL: the temp file contains the new plaintext secret. If
  // `renameSync` throws (EACCES, EXDEV across filesystems, the dir
  // going RO mid-write) we MUST clean up the orphan so a rotated
  // secret doesn't linger on disk in `<repo>/.danxbot/.env.tmp.PID.TS`.
  // The unlink is best-effort — if it also fails the original write
  // error is the more useful diagnostic to surface.
  try {
    renameImpl(tmp, path);
  } catch (renameErr) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; original error wins */
    }
    throw renameErr;
  }

  log.info(
    `[repo-env-writer] wrote ${keysToUpdate.length} key(s) to ${path} (by ${writtenBy})`,
  );

  return keysToUpdate;
}

/**
 * Pure in-memory rewrite of `.env` content. Exported only for tests in
 * principle — kept as a non-exported helper to keep the module surface
 * tight. Behavior:
 *
 *  - For each line of the form `KEY=...` (matched at the start of the
 *    line, not inside a comment), if `KEY` is in `updates`, replace the
 *    line with `KEY=<new value>`. Mark the key as "handled".
 *  - Any key in `updates` that wasn't matched is appended at the end of
 *    the file, one per line. A trailing newline is added if the
 *    original file didn't end with one — otherwise the appended block
 *    would land glued onto the last existing line.
 *  - Lines starting with `#` (after optional leading whitespace) and
 *    blank lines pass through unchanged.
 */
function rewriteEnvBody(
  original: string,
  updates: Record<string, string>,
): string {
  const handled = new Set<string>();
  const lines = original.split("\n");

  const rewrittenLines = lines.map((line) => {
    // Skip blank / comment lines without inspecting them for KEY=.
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return line;

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) return line;

    // The key portion is everything up to the `=`, trimmed. We don't
    // tolerate inline trailing comments on assignment lines (rare in
    // practice; .env parsers vary) — the existing parser in
    // `src/env-file.ts` also doesn't strip them, so write-side matches
    // read-side.
    const key = line.slice(0, eqIdx).trim();
    if (!(key in updates)) return line;
    if (handled.has(key)) return line; // first occurrence wins

    handled.add(key);
    return `${key}=${updates[key]}`;
  });

  let body = rewrittenLines.join("\n");

  const toAppend = Object.entries(updates).filter(([k]) => !handled.has(k));
  if (toAppend.length > 0) {
    // Ensure the existing content ends with a newline so the appended
    // block doesn't fuse with the prior line.
    if (body.length > 0 && !body.endsWith("\n")) {
      body += "\n";
    }
    body += toAppend.map(([k, v]) => `${k}=${v}`).join("\n");
    // Trailing newline so a re-read keeps the file shape conventional.
    body += "\n";
  }

  return body;
}

/**
 * Per-repo `unwatch` handles registered by `watchRepoEnvFile`. The
 * shutdown path drains every handle via `unwatchAllRepoEnvFiles` so
 * chokidar watchers don't outlive the worker on SIGTERM. Mirrors the
 * scheduler-side pattern around settings.json watchers.
 */
const envWatchHandles = new Map<string, () => Promise<void>>();

/**
 * Chokidar-watch `<repo>/.danxbot/.env` and invoke `onChange` whenever
 * the file is rewritten (e.g. by a PATCH `/api/agents/:repo/trello-
 * credentials` call or a hand-edit from the operator). Mirrors the
 * shape of `settings-file.ts#watchSettingsFile`.
 *
 * Live-reload caveat: the cached `repoContexts[0]` reference held by
 * `startWorkerMode` is captured at boot and threaded into ~20
 * downstream consumers (issues mirror, dispatch path, MCP injection,
 * reattach, orphan reaper, etc.). Swapping that reference in place
 * would require invalidating every cached copy — a parallel refactor
 * the AC for DX-303 explicitly allows skipping. The watcher's
 * `onChange` is therefore expected to log a "restart required"
 * warning rather than attempt the swap; the PATCH route response
 * already signals `restartRequired: true` so the operator knows to
 * cycle the worker. Production-grade live-reload can ship as a
 * follow-up card once the consumer-side fan-out is stable.
 *
 * The returned handle is also tracked in `envWatchHandles` so the
 * shutdown path can drain every watcher without the caller having to
 * stash its handle. Re-registering the same `localPath` replaces the
 * prior watcher (closing it first) — protects against a future
 * re-watch path adding a leak by accident.
 */
export function watchRepoEnvFile(args: {
  localPath: string;
  onChange: (localPath: string) => void;
}): { unwatch: () => Promise<void> } {
  const { localPath, onChange } = args;

  // Replace any prior watcher for this repo so a re-registration path
  // doesn't accumulate. Caller intent here is "the env file changes
  // get observed once per repo" — duplicate watchers would fire
  // onChange twice and stack on shutdown.
  const prior = envWatchHandles.get(localPath);
  if (prior) {
    prior().catch((err) =>
      log.warn(`[repo-env-watch] ${localPath}: prior unwatch failed`, err),
    );
  }

  const envPath = repoEnvFilePath(localPath);
  const watcher = chokidar.watch(envPath, {
    // The atomic temp+rename in `runWrite` produces a rename event
    // that lands as a `change`; 200ms is the same debounce shape
    // `watchSettingsFile` uses for fan-in.
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
    ignoreInitial: true,
  });

  const fire = (path: string, eventName: string) => {
    try {
      onChange(localPath);
    } catch (err) {
      log.error(
        `[repo-env-watch] ${localPath}: onChange threw for ${eventName} ${path}`,
        err,
      );
    }
  };

  watcher.on("change", (p) => fire(p, "change"));
  watcher.on("add", (p) => fire(p, "add"));
  watcher.on("error", (err) => {
    log.error(`[repo-env-watch] ${localPath}: chokidar emitted error`, err);
  });

  const unwatch = async (): Promise<void> => {
    if (envWatchHandles.get(localPath) === unwatch) {
      envWatchHandles.delete(localPath);
    }
    await watcher.close();
  };
  envWatchHandles.set(localPath, unwatch);

  return { unwatch };
}

/**
 * Drain every active `.env` watcher. Called from the shutdown path so
 * chokidar handles don't outlive the process. Best-effort — per-watcher
 * close failures are logged and swallowed because the worker is exiting.
 */
export async function unwatchAllRepoEnvFiles(): Promise<void> {
  const handles = Array.from(envWatchHandles.values());
  envWatchHandles.clear();
  await Promise.allSettled(handles.map((unwatch) => unwatch()));
}

/** Reset module state for testing. Do not call in production. */
export function _resetForTesting(): void {
  inProcessQueues.clear();
  envWatchHandles.clear();
  renameImpl = renameSync;
}
