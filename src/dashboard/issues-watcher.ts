/**
 * DX-226 Phase 1 — chokidar-backed `issue:updated` SSE feed.
 *
 * The dashboard process already RW-binds every connected repo's
 * `.danxbot/issues/` directory via `docker-compose.override.yml`. A
 * second per-repo chokidar (the first lives in `src/db/issues-mirror.ts`
 * inside the worker container) gives the dashboard process its own
 * real-time signal so the Issues tab no longer polls every 30s — every
 * YAML write reaches the SPA in under one debounce window.
 *
 * Why a second watcher instead of subscribing to the worker's mirror?
 *   - Workers and the dashboard are different containers. Cross-container
 *     event delivery means Postgres LISTEN/NOTIFY or a new HTTP channel.
 *     The dashboard already has RW access to the FS so chokidar is the
 *     cheapest fan-in.
 *   - The mirror's `awaitWriteFinish` is 5s — far too slow for the
 *     interactive "edit YAML → see board update" UX target (<1s).
 *
 * Producer contract:
 *   - On `add` / `change`: read YAML, parse via `parseIssue`, publish
 *     `issue:updated` with `{ repoName, id, issue }`. Malformed YAML
 *     is skipped (the mirror's CRITICAL_FAILURE flag is the primary
 *     alert surface; a transient mid-write doesn't need to flicker the
 *     SPA).
 *   - On `unlink`: move-aware. If the sibling path (`open/<id>.yml` ↔
 *     `closed/<id>.yml`) exists, the unlink is the back half of a
 *     status flip — skip the publish since the `add` event on the
 *     sibling owns the SPA's new state. If no sibling exists, publish
 *     `issue:updated` with `{ repoName, id, removed: true }`.
 *
 * Debounce: per-file 50ms timer (default). Two close `change` events
 * collapse into one publish carrying the last-read content. Tests pass
 * `debounceMs: 0` for synchronous assertions.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import { eventBus, type BusEvent } from "./event-bus.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import { createLogger } from "../logger.js";
import {
  publishIssueRemoved,
  publishIssueUpsert,
} from "./publish-issue-update.js";

const log = createLogger("issues-watcher");

export interface IssuesWatcherRepo {
  name: string;
  localPath: string;
}

export interface IssuesWatcherHandle {
  /** Stop every per-repo watcher; flush pending debounces with no publish. */
  stop(): Promise<void>;
  /** Test-only: drive an event without chokidar. */
  simulate(
    repoName: string,
    event: "add" | "change" | "unlink",
    path: string,
  ): Promise<void>;
}

export interface StartIssuesWatcherOptions {
  /** Per-file debounce window (ms). Default 50. */
  debounceMs?: number;
  /**
   * Skip the real chokidar tree. Tests pass `true` and drive
   * events synchronously via `simulate(...)`. Production callers
   * MUST omit so the actual filesystem is watched.
   */
  disableWatcher?: boolean;
}

export interface EventPublisherLike {
  publish(event: BusEvent): void;
}

interface PerRepoState {
  name: string;
  localPath: string;
  prefix: string;
  watcher: FSWatcher | null;
  pending: Map<string, NodeJS.Timeout>;
}

function issuesRoot(localPath: string): string {
  return resolve(localPath, ".danxbot", "issues");
}

function deriveIdFromPath(path: string): string {
  return basename(path).replace(/\.yml$/, "");
}

function isOpenPath(path: string): boolean {
  return path.includes(`${sep}open${sep}`);
}

function siblingPath(path: string): string {
  const id = deriveIdFromPath(path);
  // Walk up two segments (`open/<id>.yml` or `closed/<id>.yml`) to the
  // parent `.danxbot/issues/` dir, then descend into the other dir.
  const parts = path.split(sep);
  parts.splice(-2, 2);
  const base = parts.join(sep);
  const otherDir = isOpenPath(path) ? "closed" : "open";
  return resolve(base, otherDir, `${id}.yml`);
}

/** Module-level registry — shutdown.ts calls `stopAllIssuesWatchers()` on SIGTERM. */
const activeHandles = new Set<IssuesWatcherHandle>();

export function stopAllIssuesWatchers(): Promise<void> {
  const stops = [...activeHandles].map((h) =>
    h.stop().catch((err) => {
      log.error("Failed to stop issues watcher", err);
    }),
  );
  activeHandles.clear();
  return Promise.allSettled(stops).then(() => undefined);
}

/**
 * Boot one chokidar instance per repo and wire publish-on-write.
 * Returns a single handle covering every repo; `stop()` drains them
 * all + clears every pending debounce.
 */
export async function startIssuesWatcher(
  repos: IssuesWatcherRepo[],
  bus: EventPublisherLike = eventBus,
  options: StartIssuesWatcherOptions = {},
): Promise<IssuesWatcherHandle> {
  const debounceMs = options.debounceMs ?? 50;
  const disable = options.disableWatcher === true;

  const states = new Map<string, PerRepoState>();
  let stopped = false;

  for (const repo of repos) {
    let prefix: string;
    try {
      prefix = loadIssuePrefix(repo.localPath);
    } catch (err) {
      // No `.danxbot/config/config.yml` → repo isn't set up yet; skip
      // silently. The dashboard re-evaluates on next boot.
      log.warn(
        `[${repo.name}] loadIssuePrefix failed; issues watcher disabled for this repo: ${(err as Error).message}`,
      );
      continue;
    }
    const state: PerRepoState = {
      name: repo.name,
      localPath: repo.localPath,
      prefix,
      watcher: null,
      pending: new Map(),
    };
    states.set(repo.name, state);
  }

  function clearPendingForPath(state: PerRepoState, path: string): void {
    const timer = state.pending.get(path);
    if (timer) {
      clearTimeout(timer);
      state.pending.delete(path);
    }
  }

  async function publishUpsert(state: PerRepoState, path: string): Promise<void> {
    if (stopped) return;
    let text: string;
    let mtimeMs: number;
    try {
      text = readFileSync(path, "utf-8");
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log.error(`[${state.name}] read ${path}`, err);
      return;
    }
    let issue;
    try {
      issue = parseIssue(text, { expectedPrefix: state.prefix });
    } catch (err) {
      // Malformed YAML — log and skip. The watcher catches every
      // post-`awaitWriteFinish` event, so a transient parse failure
      // typically resolves on the next user edit; flickering the SPA
      // with a `removed` placeholder is worse than nothing.
      log.debug(
        `[${state.name}] parse ${path}: ${(err as Error).message} — skipping publish`,
      );
      return;
    }
    try {
      // Route through the canonical publisher — projects to IssueListItem
      // + fans out to dependent cards.
      await publishIssueUpsert(state.name, issue, mtimeMs, bus);
    } catch (err) {
      log.error(`[${state.name}] publishIssueUpsert ${issue.id}`, err);
    }
  }

  function scheduleUpsert(state: PerRepoState, path: string): Promise<void> {
    if (stopped) return Promise.resolve();
    clearPendingForPath(state, path);
    if (debounceMs <= 0) {
      return publishUpsert(state, path);
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        state.pending.delete(path);
        publishUpsert(state, path).finally(() => resolve());
      }, debounceMs);
      if (typeof timer.unref === "function") timer.unref();
      state.pending.set(path, timer);
    });
  }

  async function publishRemoved(state: PerRepoState, path: string): Promise<void> {
    if (stopped) return;
    // Move-aware: if the sibling path exists, the unlink is the back
    // half of an `open/` ↔ `closed/` status flip. The sibling's `add`
    // event already owns (or will own) the SPA's row — emitting
    // `removed: true` here would drop the row in the brief window
    // before the SPA's reducer applies the sibling's upsert.
    //
    // Atomic `rename(2)` (the worker's write path) keeps the sibling
    // visible to `existsSync` at unlink time, so this check
    // suppresses correctly. A non-atomic move (e.g. `git pull` that
    // deletes + recreates) may leave a gap where the sibling is gone
    // when the unlink fires; in that case the SPA flickers for up to
    // one `awaitWriteFinish` window until the eventual `add` reasserts
    // the row. Acceptable trade-off for the common atomic-rename case.
    if (existsSync(siblingPath(path))) return;
    const id = deriveIdFromPath(path);
    try {
      await publishIssueRemoved(state.name, id, bus);
    } catch (err) {
      log.error(`[${state.name}] publishIssueRemoved ${id}`, err);
    }
  }

  function handleUnlink(state: PerRepoState, path: string): Promise<void> {
    // Cancel any pending upsert for the same path — it would read a
    // gone file and ENOENT-skip anyway, but cleaning the map keeps
    // `stop()` snappy.
    clearPendingForPath(state, path);
    return publishRemoved(state, path);
  }

  function startChokidarFor(state: PerRepoState): Promise<void> {
    if (disable) return Promise.resolve();
    const base = issuesRoot(state.localPath);
    const open = resolve(base, "open");
    const closed = resolve(base, "closed");
    const w = chokidar.watch([open, closed], {
      ignoreInitial: true,
      // 200ms — fast enough to keep the SPA's "<1s edit-to-UI"
      // contract on rapid agent saves, slow enough to coalesce
      // multi-step writes. Distinct from `issues-mirror.ts`' 5s
      // value: the mirror writes a DB row whose generated columns
      // crash on mid-write JSONB; this watcher just parses and
      // publishes, with `parseIssue` already swallowing malformed
      // YAML below. The 50ms `debounceMs` adds a second
      // per-file coalescing layer on top of this.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      persistent: true,
    });
    state.watcher = w;
    w.on("add", (path) => {
      if (!path.endsWith(".yml")) return;
      void scheduleUpsert(state, path);
    });
    w.on("change", (path) => {
      if (!path.endsWith(".yml")) return;
      void scheduleUpsert(state, path);
    });
    w.on("unlink", (path) => {
      if (!path.endsWith(".yml")) return;
      void handleUnlink(state, path);
    });
    w.on("error", (err) => {
      log.error(`[${state.name}] chokidar error`, err);
    });
    return new Promise<void>((res) => {
      w.once("ready", () => res());
    });
  }

  await Promise.all([...states.values()].map((s) => startChokidarFor(s)));

  const handle: IssuesWatcherHandle = {
    async simulate(repoName, event, path) {
      const state = states.get(repoName);
      if (!state) {
        throw new Error(`Unknown repo "${repoName}"`);
      }
      if (stopped) return;
      // Tests await the full publish chain so assertions on `events`
      // hold immediately after the call returns. Debounced path resolves
      // its timer Promise once the trailing publish finishes.
      if (event === "unlink") {
        await handleUnlink(state, path);
      } else {
        await scheduleUpsert(state, path);
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const state of states.values()) {
        for (const timer of state.pending.values()) {
          clearTimeout(timer);
        }
        state.pending.clear();
        if (state.watcher) {
          await state.watcher.close();
          state.watcher = null;
        }
      }
      activeHandles.delete(handle);
    },
  };

  activeHandles.add(handle);
  return handle;
}
