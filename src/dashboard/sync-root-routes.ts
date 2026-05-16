/**
 * DX-558 — dashboard routes for the root-clone sync feature.
 *
 *   - `GET  /api/sync-root` — list current error states across every
 *     configured repo. Drives the SPA composable's hydrate path so
 *     a fresh page load shows the banner without waiting for an SSE
 *     transition. Reads from disk via the watcher handle, not from
 *     any in-process map (the dashboard process has none — the
 *     worker owns the in-memory truth).
 *   - `POST /api/sync-root/:repo` — operator-driven retry. Proxies
 *     to the worker's `POST /api/sync-root` route, which runs the
 *     sync immediately and returns the new state.
 *
 * Auth: user-bearer required on both. The dispatch-token band is NOT
 * accepted — these are operator UX hooks, not bot↔repo wiring.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { requireUser } from "./auth-middleware.js";
import { proxyToWorkerWithFallback } from "./dispatch-proxy.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import type { RepoRootSyncError } from "../worker/sync-root.js";
import type { SyncRootWatcherHandle } from "./sync-root-watcher.js";

export interface SyncRootRouteDeps {
  /** Configured repos. */
  repos: { name: string }[];
  /** Watcher handle that exposes `readState(repoName)`. */
  watcher: SyncRootWatcherHandle;
  /** Reused dispatch-proxy deps for the worker forward. */
  proxy: DispatchProxyDeps;
  /** Repo-name → workerPort lookup (for the proxy forward path). */
  resolveWorkerPort: (repoName: string) => number | null;
}

export interface SyncRootStateEntry {
  repoName: string;
  error: RepoRootSyncError;
}

/** GET /api/sync-root — returns every repo currently in error state. */
export async function handleListSyncRootStates(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SyncRootRouteDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  const entries: SyncRootStateEntry[] = [];
  for (const repo of deps.repos) {
    const state = deps.watcher.readState(repo.name);
    if (state) entries.push({ repoName: repo.name, error: state });
  }
  json(res, 200, { states: entries });
}

/** POST /api/sync-root/:repo — proxy operator retry to the worker. */
export async function handleSyncRootRetryProxy(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: SyncRootRouteDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  const repo = deps.proxy.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }
  const port = deps.resolveWorkerPort(repoName);
  if (!port) {
    json(res, 500, { error: `Worker port for repo "${repoName}" is unresolved` });
    return;
  }
  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName,
      primaryHost: deps.proxy.resolveHost(repoName),
      port,
      path: "/api/sync-root",
      method: "POST",
    },
    null,
  );
}
