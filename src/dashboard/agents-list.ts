/**
 * Read-side Agents tab routes — list + single-repo snapshot — plus the
 * snapshot building blocks shared with the mutation handlers in
 * `agents-toggles.ts`, `agents-crud.ts`, and `agents-avatar.ts`.
 *
 * Routes:
 *   GET /api/agents          → handleListAgents (per-repo aggregation)
 *   GET /api/agents/:repo    → handleGetAgent   (single repo refresh)
 *
 * The mutation handlers re-aggregate via `buildSnapshot` +
 * `publishAgentSnapshot` after every write so SSE clients see fresh
 * state without polling.
 *
 * The routes NEVER read `.env` files or secrets — the settings file is
 * the only per-repo source of truth consulted here. Worker reachability
 * is probed via `http.request` with a 2s timeout; unreachable workers
 * return `{worker: {reachable: false, ...}}` rather than 500-ing the
 * whole page.
 */

import type { ServerResponse } from "http";
import { request as httpRequest } from "node:http";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import {
  countDispatchesByRepo,
  type RepoDispatchCounts,
} from "./dispatches-db.js";
import { readSettings, type Settings } from "../settings-file.js";
import { readFlag, type CriticalFailurePayload } from "../critical-failure.js";
import { eventBus } from "./event-bus.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";

const log = createLogger("agents-list");

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
  /**
   * Live `issue_prefix` value read from
   * `<repo>/.danxbot/config/config.yml#issue_prefix`. DX-103 — surfaced
   * to the SPA so the Agents tab can render an editable field. Read on
   * every snapshot rather than persisted via `settings.display.*` so a
   * `PUT /api/agents/:repo/issue-prefix` call's effect is visible on the
   * very next `/api/agents` poll without waiting for the worker to
   * re-run `syncSettingsFileOnBoot`. `null` when the loader throws
   * (config.yml missing / corrupt) — UI can render a "—" placeholder
   * rather than failing the entire snapshot.
   */
  issuePrefix: string | null;
}

const EMPTY_COUNTS: RepoDispatchCounts = {
  total: { total: 0, slack: 0, trello: 0, api: 0 },
  last24h: { total: 0, slack: 0, trello: 0, api: 0 },
  today: { total: 0, slack: 0, trello: 0, api: 0 },
};

export function emptyCounts(): RepoDispatchCounts {
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
export async function buildSnapshot(
  repo: RepoConfig,
  counts: RepoDispatchCounts,
  resolveHost: (name: string) => string,
): Promise<AgentSnapshot> {
  const settings = readSettings(repo.localPath);
  const worker = await probeWorkerHealth(resolveHost(repo.name), repo.workerPort);
  // Read the flag from the bind-mounted repo dir — same pattern as
  // settings. The dashboard has read access but NEVER writes the flag
  // (only the worker writes; only the DELETE endpoint clears via the
  // worker's own `clearFlag`).
  const criticalFailure = readFlag(repo.localPath);
  // DX-103: live read of `issue_prefix` from config.yml on every
  // snapshot. Loader throws on missing — swallow to null so a misconfigured
  // repo still renders the rest of the agent card.
  let issuePrefix: string | null = null;
  try {
    issuePrefix = loadIssuePrefix(repo.localPath);
  } catch (err) {
    log.warn(
      `loadIssuePrefix(${repo.name}) failed; rendering snapshot with issuePrefix=null`,
      err,
    );
  }

  return {
    name: repo.name,
    url: repo.url,
    settings,
    counts,
    worker,
    criticalFailure,
    issuePrefix,
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
 * Publish a fresh repo snapshot on the `agent:updated` SSE topic so
 * other dashboard clients see the agents-map mutation without polling.
 * Mirrors the pattern in `handlePatchToggle` / `handlePutIssuePrefix`.
 *
 * Best-effort: a failure here logs but does not roll back the
 * persisted mutation. The next REST hydrate (manual refresh, repo
 * switch, visibility flip) reconciles drift.
 */
export async function publishAgentSnapshot(
  repo: RepoConfig,
  resolveHost: (name: string) => string,
): Promise<void> {
  try {
    const counts = await countDispatchesByRepo().catch(
      () => ({}) as Record<string, RepoDispatchCounts>,
    );
    const snapshot = await buildSnapshot(
      repo,
      counts[repo.name] ?? emptyCounts(),
      resolveHost,
    );
    eventBus.publish({ topic: "agent:updated", data: snapshot });
  } catch (err) {
    log.warn(`publishAgentSnapshot(${repo.name}) failed`, err);
  }
}

