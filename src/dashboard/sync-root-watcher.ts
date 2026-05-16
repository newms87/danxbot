/**
 * DX-558 — chokidar bridge from the worker's per-repo
 * `<repoRoot>/.danxbot/sync-root-state.json` file onto the dashboard's
 * in-process eventBus.
 *
 * Pattern mirrors `agents-watcher.ts` (settings.json) and
 * `issues-watcher.ts` (issue YAMLs): the worker process owns the
 * write path; the dashboard process chokidars to surface state
 * changes through `/api/stream` without polling.
 *
 *   - `add` / `change` → read JSON → `repo-root-sync:error` event.
 *   - `unlink` → `repo-root-sync:clear` event.
 *
 * Per-repo handles live in a module-level set so `shutdown.ts` /
 * server-stop can drain them on SIGTERM.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import { eventBus } from "./event-bus.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";
import { isRepoRootSyncError, type RepoRootSyncError } from "../worker/sync-root.js";

const log = createLogger("sync-root-watcher");

export interface SyncRootWatcherHandle {
  /** Stop every per-repo watcher. */
  stop(): Promise<void>;
  /** Read the current state file (if present) for a repo. Used by the dashboard's hydrate route. */
  readState(repoName: string): RepoRootSyncError | null;
  /** Test-only: synthesise a chokidar event without touching disk. */
  simulate(repoName: string, event: "add" | "change" | "unlink"): void;
}

const activeHandles = new Set<SyncRootWatcherHandle>();

export function stopAllSyncRootWatchers(): Promise<void> {
  const stops = [...activeHandles].map((h) =>
    h.stop().catch((err) => log.error("Failed to stop sync-root watcher", err)),
  );
  activeHandles.clear();
  return Promise.allSettled(stops).then(() => undefined);
}

export interface StartSyncRootWatcherOptions {
  /** Test-only — skip chokidar so `simulate()` drives events. */
  disableWatcher?: boolean;
}

interface PerRepoState {
  repo: RepoConfig;
  path: string;
  watcher: FSWatcher | null;
}

function stateFilePath(localPath: string): string {
  return resolve(localPath, ".danxbot", "sync-root-state.json");
}

function readStateFile(path: string): RepoRootSyncError | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRepoRootSyncError(parsed)) {
      log.warn(`Malformed sync-root state file at ${path}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function startSyncRootWatcher(
  repos: RepoConfig[],
  options: StartSyncRootWatcherOptions = {},
): Promise<SyncRootWatcherHandle> {
  const disable = options.disableWatcher === true;
  const states = new Map<string, PerRepoState>();
  let stopped = false;

  for (const repo of repos) {
    states.set(repo.name, {
      repo,
      path: stateFilePath(repo.localPath),
      watcher: null,
    });
  }

  function publishError(repoName: string, error: RepoRootSyncError): void {
    eventBus.publish({
      topic: "repo-root-sync:error",
      data: { repoName, error },
    });
  }

  function publishClear(repoName: string): void {
    eventBus.publish({
      topic: "repo-root-sync:clear",
      data: { repoName },
    });
  }

  function onChange(state: PerRepoState): void {
    if (stopped) return;
    const parsed = readStateFile(state.path);
    if (parsed) publishError(state.repo.name, parsed);
  }

  function onUnlink(state: PerRepoState): void {
    if (stopped) return;
    publishClear(state.repo.name);
  }

  async function startChokidarFor(state: PerRepoState): Promise<void> {
    if (disable) return;
    const w = chokidar.watch(state.path, {
      ignoreInitial: true,
      // Worker writes via `writeFileSync` (atomic-ish on POSIX). The
      // file is small (single JSON object); a 25ms stability window
      // is plenty to collapse a write + subsequent fsync into one event.
      awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 10 },
      persistent: true,
    });
    state.watcher = w;
    w.on("add", () => onChange(state));
    w.on("change", () => onChange(state));
    w.on("unlink", () => onUnlink(state));
    w.on("error", (err) => log.error(`[${state.repo.name}] chokidar error`, err));
    return new Promise<void>((res) => w.once("ready", () => res()));
  }

  await Promise.all([...states.values()].map((s) => startChokidarFor(s)));

  const handle: SyncRootWatcherHandle = {
    readState(repoName) {
      const state = states.get(repoName);
      if (!state) return null;
      return readStateFile(state.path);
    },
    simulate(repoName, event) {
      const state = states.get(repoName);
      if (!state) throw new Error(`Unknown repo "${repoName}"`);
      if (event === "unlink") onUnlink(state);
      else onChange(state);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const state of states.values()) {
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
