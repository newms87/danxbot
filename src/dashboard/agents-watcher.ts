/**
 * DX-369 (Phase 6 of DX-363) — chokidar-backed `agent:updated` SSE feed
 * for settings.json mutations the dashboard process did not perform
 * itself.
 *
 * The dashboard's mutation handlers (`handlePatchToggle`,
 * `handlePostAgent`, `handlePatchAgent`, `handleDeleteAgent`,
 * `handlePutIssuePrefix`) already call `publishAgentSnapshot` directly
 * after writing — those paths reach the SSE bus synchronously. The
 * paths that DO NOT pass through a dashboard handler need this watcher
 * to fan out:
 *
 *   1. Worker-side strike accumulator (`src/agent/strikes.ts`) stamps
 *      `broken` + bumps `strikes.count` on a strike-3 transition.
 *      Without this watcher the SPA banner would only appear on the
 *      next manual refresh or visibility-resume hydrate.
 *   2. Worker-side evaluator-dispatcher (`src/agent/evaluator-dispatcher.ts`)
 *      walks `broken.evaluator_status` through running → completed/failed.
 *   3. Worker's `/api/clear-broken` + `/api/re-run-evaluator` routes
 *      (the dashboard proxies forward to these — the actual write
 *      happens under the worker's `mutateAgents` lock).
 *
 * Pattern mirrors `issues-watcher.ts` (the chokidar feed for issue
 * YAMLs). Per-repo watcher, debounced `change` events trigger
 * `publishAgentSnapshot(repo, resolveHost)` so every connected
 * dashboard tab sees the new state.
 *
 * Path watched per repo: `<repo>/.danxbot/settings.json`. The dashboard
 * process already RW-binds each repo's `.danxbot/` dir via
 * `docker-compose.override.yml`, so reading is free.
 *
 * NOT a polling fallback — purely a push-on-change wire. DX-227's
 * "no polling from the SPA" rule is preserved: this watcher is the
 * server-side event source the SPA's existing `useStream` SSE
 * subscriber already listens to.
 */

import { resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import { publishAgentSnapshot } from "./agents-list.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";

const log = createLogger("agents-watcher");

export interface AgentsWatcherDeps {
  /** Resolve a repo name to its worker hostname (passed through to publishAgentSnapshot). */
  resolveHost: (repoName: string) => string;
}

export interface AgentsWatcherHandle {
  /** Stop every per-repo watcher; flush pending debounces with no publish. */
  stop(): Promise<void>;
  /** Test-only: synthesise a change event for a repo. */
  simulate(repoName: string): Promise<void>;
}

/**
 * Module-level registry — `shutdown.ts` calls `stopAllAgentsWatchers()`
 * on SIGTERM. Mirrors `issues-watcher.ts`'s pattern: the dashboard
 * process holds the chokidar handle that `startDashboard()` opens; we
 * need to drain it so pending debounce timers + watcher FDs do not
 * outlive the process.
 */
const activeHandles = new Set<AgentsWatcherHandle>();

export function stopAllAgentsWatchers(): Promise<void> {
  const stops = [...activeHandles].map((h) =>
    h.stop().catch((err) => {
      log.error("Failed to stop agents watcher", err);
    }),
  );
  activeHandles.clear();
  return Promise.allSettled(stops).then(() => undefined);
}

export interface StartAgentsWatcherOptions {
  /** Per-repo debounce window (ms). Default 100 — small enough that the
   *  SPA sees the new state in <200ms, large enough to coalesce a write
   *  burst (mutateAgents's read-modify-write does one settings.json
   *  write per call, but a quick second call from a peer process is
   *  the common case worth absorbing).
   */
  debounceMs?: number;
  /** Test-only — skip the chokidar tree so simulate() drives events. */
  disableWatcher?: boolean;
}

interface PerRepoState {
  repo: RepoConfig;
  watcher: FSWatcher | null;
  pendingTimer: NodeJS.Timeout | null;
}

function settingsPath(localPath: string): string {
  return resolve(localPath, ".danxbot", "settings.json");
}

export async function startAgentsWatcher(
  repos: RepoConfig[],
  deps: AgentsWatcherDeps,
  options: StartAgentsWatcherOptions = {},
): Promise<AgentsWatcherHandle> {
  const debounceMs = options.debounceMs ?? 100;
  const disable = options.disableWatcher === true;

  const states = new Map<string, PerRepoState>();
  let stopped = false;

  for (const repo of repos) {
    states.set(repo.name, { repo, watcher: null, pendingTimer: null });
  }

  function publish(state: PerRepoState): void {
    if (stopped) return;
    // Swallow rejection — a failing publish must NOT crash the dashboard
    // process or leak an unhandled rejection. Operators see the warn
    // line; the next settings.json mutation re-fires the publish.
    void Promise.resolve(
      publishAgentSnapshot(state.repo, deps.resolveHost),
    ).catch((err) =>
      log.warn(`[${state.repo.name}] publishAgentSnapshot failed`, err),
    );
  }

  function schedule(state: PerRepoState): void {
    if (stopped) return;
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    if (debounceMs <= 0) {
      publish(state);
      return;
    }
    const timer = setTimeout(() => {
      state.pendingTimer = null;
      publish(state);
    }, debounceMs);
    if (typeof timer.unref === "function") timer.unref();
    state.pendingTimer = timer;
  }

  function startChokidarFor(state: PerRepoState): Promise<void> {
    if (disable) return Promise.resolve();
    const path = settingsPath(state.repo.localPath);
    const w = chokidar.watch(path, {
      ignoreInitial: true,
      // 50ms — settings.json writes are atomic via `writeSettings`'s
      // temp+rename, but the rename emits both `add` (new file) and
      // `change` (kernel-level inode swap) in some chokidar polling
      // modes. The watcher-level stability + the per-state debouncer
      // collapse those into one publish.
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      persistent: true,
    });
    state.watcher = w;
    w.on("add", () => schedule(state));
    w.on("change", () => schedule(state));
    w.on("error", (err) => {
      log.error(`[${state.repo.name}] chokidar error`, err);
    });
    return new Promise<void>((res) => {
      w.once("ready", () => res());
    });
  }

  await Promise.all([...states.values()].map((s) => startChokidarFor(s)));

  const handle: AgentsWatcherHandle = {
    async simulate(repoName) {
      const state = states.get(repoName);
      if (!state) {
        throw new Error(`Unknown repo "${repoName}"`);
      }
      if (stopped) return;
      schedule(state);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const state of states.values()) {
        if (state.pendingTimer) {
          clearTimeout(state.pendingTimer);
          state.pendingTimer = null;
        }
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
