/**
 * Dashboard API routes for the Agents tab.
 *
 * Three routes, all registered on the shared dashboard HTTP server:
 *
 *   GET   /api/agents                     — per-repo aggregation
 *   GET   /api/agents/:repo               — single repo (for refresh after toggle)
 *   PATCH /api/agents/:repo/toggles       — mutate override (user bearer auth)
 *
 * The GET routes are open (parity with `/api/dispatches`). PATCH is
 * gated by a per-user bearer token issued from `/api/auth/login` —
 * `DANXBOT_DISPATCH_TOKEN` is NOT accepted here (that's the bot↔repo
 * credential, scoped to `/api/launch` and friends via `dispatch-proxy.ts`).
 * See `.claude/rules/agent-dispatch.md` for the full separation.
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
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import {
  countDispatchesByRepo,
  type RepoDispatchCounts,
} from "./dispatches-db.js";
import {
  DASHBOARD_PREFIX,
  FEATURES,
  readSettings,
  writeSettings,
  type Feature,
  type Settings,
} from "../settings-file.js";
import { readFlag, type CriticalFailurePayload } from "../critical-failure.js";
import { proxyToWorker } from "./dispatch-proxy.js";
import { eventBus } from "./event-bus.js";

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
  /**
   * Contents of `<repo>/.danxbot/CRITICAL_FAILURE` when the poller has
   * halted on a critical-failure flag — either agent-signaled via the
   * `danxbot_complete({status:"critical_failure"})` MCP tool, or
   * worker-signaled by the post-dispatch "card didn't move out of
   * ToDo" backup check. Null when the flag is absent (poller running
   * normally). Dashboard renders a red banner when non-null. See
   * `.claude/rules/agent-dispatch.md` "Critical failure flag".
   */
  criticalFailure: CriticalFailurePayload | null;
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
  // Read the flag from the bind-mounted repo dir — same pattern as
  // settings. The dashboard has read access but NEVER writes the flag
  // (only the worker writes; only the DELETE endpoint below clears via
  // the worker's own `clearFlag`).
  const criticalFailure = readFlag(repo.localPath);

  return {
    name: repo.name,
    url: repo.url,
    settings,
    counts,
    worker,
    criticalFailure,
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
 * PATCH /api/agents/:repo/toggles — user-bearer auth required. Mutates
 * only `overrides.<feature>` in `settings.json`; never touches `display`
 * or writes secrets. Records the operator's username in `meta.updatedBy`
 * as `dashboard:<username>` so audits show who flipped the toggle.
 * Returns the refreshed snapshot in the response body so the SPA can
 * commit the optimistic update without a second fetch.
 *
 * The dispatch token (`DANXBOT_DISPATCH_TOKEN`) is NOT accepted — that
 * credential is bot↔repo and stays on the dispatch-proxy routes. See
 * `.claude/rules/agent-dispatch.md` for why this split matters.
 */
export async function handlePatchToggle(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
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

  const rawFeature = body["feature"];
  const enabled = body["enabled"];

  if (
    typeof rawFeature !== "string" ||
    !(FEATURES as readonly string[]).includes(rawFeature)
  ) {
    json(res, 400, {
      error: `feature must be one of: ${FEATURES.join(", ")}`,
    });
    return;
  }
  const feature = rawFeature as Feature;

  if (enabled !== true && enabled !== false && enabled !== null) {
    json(res, 400, {
      error: "enabled must be true, false, or null",
    });
    return;
  }

  try {
    await writeSettings(repo.localPath, {
      overrides: { [feature]: { enabled } },
      writtenBy: `${DASHBOARD_PREFIX}${auth.user.username}`,
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
    // Publish agent:updated so SSE clients see the toggle without polling.
    eventBus.publish({ topic: "agent:updated", data: snapshot });
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

/**
 * DELETE /api/agents/:repo/critical-failure — user-bearer auth required.
 * Forwards to the worker's `DELETE /api/poller/critical-failure`, which
 * calls `clearFlag(repo.localPath)`. The dashboard never writes or
 * deletes the flag file directly — only the worker touches it, so the
 * ownership contract stays "one writer per file" as designed.
 *
 * Auth: per-user bearer (same as PATCH toggle). Dashboard users clear
 * flags; bots/external dispatchers do not. `DANXBOT_DISPATCH_TOKEN` is
 * intentionally NOT accepted here.
 *
 * Returns the refreshed agent snapshot in the response body (after the
 * worker clears the flag) so the SPA can commit the banner-dismissal
 * without a second fetch. Failure modes: 401 (no auth), 404 (unknown
 * repo), 502 (worker unreachable), 500 (unexpected dashboard error).
 */
export async function handleClearAgentCriticalFailure(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }
  if (!repo.workerPort) {
    json(res, 500, {
      error: `Repo "${repoName}" has no workerPort configured on this dashboard`,
    });
    return;
  }

  await proxyToWorker(
    req,
    res,
    {
      host: deps.resolveHost(repo.name),
      port: repo.workerPort,
      path: "/api/poller/critical-failure",
      method: "DELETE",
    },
    null,
  );

  // Note: we don't re-read the snapshot here because `proxyToWorker`
  // has already written the response (the worker's body). The SPA
  // refetches `/api/agents/:repo` after a successful DELETE — a second
  // round-trip, but it keeps the clear endpoint a pure forwarder.
}
