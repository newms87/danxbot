/**
 * Dashboard API routes for the Agents tab.
 *
 * Three routes, all registered on the shared dashboard HTTP server:
 *
 *   GET   /api/agents                     — per-repo aggregation
 *   GET   /api/agents/:repo               — single repo (for refresh after toggle)
 *   PATCH /api/agents/:repo/toggles       — mutate override (bearer auth)
 *
 * The GET routes are open (parity with `/api/dispatches`). PATCH reuses
 * the same `DANXBOT_DISPATCH_TOKEN` + `checkAuth` pair as the dispatch
 * proxy so there is ONE bearer token for the dashboard, not a new one.
 *
 * The routes NEVER read `.env` files or secrets — the settings file is
 * the only per-repo source of truth consulted here. Worker-reachability
 * is probed via `http.request` with a 2s timeout; unreachable workers
 * return `{worker: {reachable: false, ...}}` rather than 500-ing the
 * whole page.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { request as httpRequest } from "node:http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";
import {
  checkAuth,
  type DispatchProxyDeps,
} from "./dispatch-proxy.js";
import {
  countDispatchesByRepo,
  type RepoDispatchCounts,
} from "./dispatches-db.js";
import {
  FEATURES,
  readSettings,
  writeSettings,
  type Feature,
  type Settings,
} from "../settings-file.js";

const log = createLogger("agents-routes");

/** Timeout for the `/health` probe on each worker. Keep tight — the
 * dashboard page waits on the slowest worker, so a stuck node shouldn't
 * block the rest. */
const WORKER_HEALTH_TIMEOUT_MS = 2_000;

export interface WorkerHealth {
  reachable: boolean;
  lastSeenMs: number | null;
  error?: string;
}

export interface AgentSnapshot {
  name: string;
  url: string;
  settings: Settings;
  counts: RepoDispatchCounts;
  worker: WorkerHealth;
}

const EMPTY_COUNTS: RepoDispatchCounts = {
  total: { total: 0, slack: 0, trello: 0, api: 0 },
  last24h: { total: 0, slack: 0, trello: 0, api: 0 },
  today: { total: 0, slack: 0, trello: 0, api: 0 },
};

function emptyCounts(): RepoDispatchCounts {
  return {
    total: { ...EMPTY_COUNTS.total },
    last24h: { ...EMPTY_COUNTS.last24h },
    today: { ...EMPTY_COUNTS.today },
  };
}

/**
 * Probe a worker's /health endpoint. Returns `{reachable: false}` on any
 * failure — timeout, connection refused, DNS error — so the page always
 * renders even when a worker is down. Never throws.
 */
export function probeWorkerHealth(
  host: string,
  port: number,
): Promise<WorkerHealth> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (result: WorkerHealth) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpRequest(
      {
        host,
        port,
        path: "/health",
        method: "GET",
        timeout: WORKER_HEALTH_TIMEOUT_MS,
      },
      (res) => {
        // Drain + discard the body so the socket can be pooled.
        res.resume();
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        done({
          reachable: ok,
          lastSeenMs: ok ? start : null,
          ...(ok ? {} : { error: `status ${res.statusCode ?? "unknown"}` }),
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("health probe timeout"));
    });
    req.on("error", (err) => {
      done({ reachable: false, lastSeenMs: null, error: err.message });
    });

    req.end();
  });
}

/**
 * Build the snapshot for a single repo: settings (read-on-disk, never
 * throws), dispatch counts (pre-fetched by the caller — passed in to
 * avoid N+1 SQL for the list endpoint), and worker health (probed now).
 */
async function buildSnapshot(
  repo: RepoConfig,
  counts: RepoDispatchCounts,
  resolveHost: (name: string) => string,
): Promise<AgentSnapshot> {
  const settings = readSettings(repo.localPath);
  const worker = repo.workerPort
    ? await probeWorkerHealth(resolveHost(repo.name), repo.workerPort)
    : { reachable: false, lastSeenMs: null, error: "no workerPort configured" };

  return {
    name: repo.name,
    url: repo.url,
    settings,
    counts,
    worker,
  };
}

/**
 * GET /api/agents — every configured repo, ordered by REPOS env var.
 * Worker health probes run in parallel so the total wait is bounded by
 * WORKER_HEALTH_TIMEOUT_MS, not N×timeout.
 */
export async function handleListAgents(
  res: ServerResponse,
  deps: DispatchProxyDeps,
): Promise<void> {
  try {
    const countsByRepo = await countDispatchesByRepo().catch((err) => {
      log.warn("Failed to query dispatch counts — rendering with zeros", err);
      return {} as Record<string, RepoDispatchCounts>;
    });

    const snapshots = await Promise.all(
      deps.repos.map((repo) =>
        buildSnapshot(
          repo,
          countsByRepo[repo.name] ?? emptyCounts(),
          deps.resolveHost,
        ),
      ),
    );
    json(res, 200, snapshots);
  } catch (err) {
    log.error("handleListAgents failed", err);
    json(res, 500, { error: "Failed to list agents" });
  }
}

/**
 * GET /api/agents/:repo — single-repo snapshot. Used by the SPA to
 * refresh one card after a toggle round-trip without re-fetching the
 * whole list.
 */
export async function handleGetAgent(
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }
  try {
    const countsByRepo = await countDispatchesByRepo().catch((err) => {
      log.warn(
        `Failed to query dispatch counts for ${repoName} — rendering with zeros`,
        err,
      );
      return {} as Record<string, RepoDispatchCounts>;
    });
    const snapshot = await buildSnapshot(
      repo,
      countsByRepo[repo.name] ?? emptyCounts(),
      deps.resolveHost,
    );
    json(res, 200, snapshot);
  } catch (err) {
    log.error(`handleGetAgent(${repoName}) failed`, err);
    json(res, 500, { error: "Failed to load agent" });
  }
}

/**
 * PATCH /api/agents/:repo/toggles — bearer-auth required. Mutates only
 * `overrides.<feature>` in `settings.json`; never touches `display` or
 * writes secrets. Returns the refreshed snapshot in the response body so
 * the SPA can commit the optimistic update without a second fetch.
 */
export async function handlePatchToggle(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = checkAuth(req, deps.token);
  if (!auth.ok) {
    if (auth.reason === "server_missing_token") {
      json(res, 500, {
        error:
          "DANXBOT_DISPATCH_TOKEN is not configured on this dashboard — toggles are disabled",
      });
    } else {
      json(res, 401, { error: "Unauthorized" });
    }
    return;
  }

  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const feature = body["feature"];
  const enabled = body["enabled"];

  if (typeof feature !== "string" || !(FEATURES as readonly string[]).includes(feature)) {
    json(res, 400, {
      error: `feature must be one of: ${FEATURES.join(", ")}`,
    });
    return;
  }
  if (enabled !== true && enabled !== false && enabled !== null) {
    json(res, 400, {
      error: "enabled must be true, false, or null",
    });
    return;
  }

  try {
    await writeSettings(repo.localPath, {
      overrides: { [feature as Feature]: { enabled } },
      writtenBy: "dashboard",
    });
    // Re-aggregate the single repo so the SPA gets fresh counts + worker
    // health alongside the new settings.
    const countsByRepo = await countDispatchesByRepo().catch((err) => {
      log.warn(
        `Failed to query dispatch counts post-toggle for ${repoName}`,
        err,
      );
      return {} as Record<string, RepoDispatchCounts>;
    });
    const snapshot = await buildSnapshot(
      repo,
      countsByRepo[repo.name] ?? emptyCounts(),
      deps.resolveHost,
    );
    json(res, 200, snapshot);
  } catch (err) {
    log.error(
      `handlePatchToggle(${repoName}, ${feature}, ${enabled}) failed`,
      err,
    );
    json(res, 500, {
      error: err instanceof Error ? err.message : "Failed to update toggle",
    });
  }
}
