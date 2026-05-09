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
  type AgentRecordWithName,
  type Feature,
  type Settings,
} from "../settings-file.js";
import { readFlag, type CriticalFailurePayload } from "../critical-failure.js";
import { proxyToWorkerWithFallback } from "./dispatch-proxy.js";
import { eventBus } from "./event-bus.js";
import { ISSUE_PREFIX_SHAPE } from "../issue-tracker/yaml.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import { runMigration } from "../../scripts/migrate-issue-prefix.js";

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
  const worker = await probeWorkerHealth(resolveHost(repo.name), repo.workerPort);
  // Read the flag from the bind-mounted repo dir — same pattern as
  // settings. The dashboard has read access but NEVER writes the flag
  // (only the worker writes; only the DELETE endpoint below clears via
  // the worker's own `clearFlag`).
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
 * Roster shape returned by `GET /api/agents?repo=<name>` (DX-159 Phase 1).
 *
 * Phase 1 ships the schema + per-repo Settings/Agents UI restructure.
 * The roster is intentionally always-empty until DX-160 lands the CRUD
 * UI + dispatch wiring; the field is populated here so the SPA's typed
 * fetch wrapper can begin consuming the final shape today.
 */
export interface AgentRosterResponse {
  agents: AgentRecordWithName[];
  settings: { conflictCheckEnabled: boolean };
}

/**
 * GET /api/agents?repo=<name> — agent roster for a single repo plus
 * `agentDefaults.conflictCheckEnabled`. The router dispatches here when
 * the `?repo=` query is present; the unparameterized variant continues
 * to call `handleListAgents` for the per-repo aggregation list. Same
 * path, two shapes, distinct consumers — see `.claude/rules/dashboard.md`.
 */
export async function handleGetRoster(
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
    const settings = readSettings(repo.localPath);
    const agentsMap = settings.agents ?? {};
    const agents: AgentRecordWithName[] = Object.entries(agentsMap).map(
      ([name, record]) => ({ name, ...record }),
    );
    const conflictCheckEnabled =
      settings.agentDefaults?.conflictCheckEnabled ?? true;
    const body: AgentRosterResponse = {
      agents,
      settings: { conflictCheckEnabled },
    };
    json(res, 200, body);
  } catch (err) {
    log.error(`handleGetRoster(${repoName}) failed`, err);
    json(res, 500, { error: "Failed to load agent roster" });
  }
}

/**
 * PATCH /api/agents-settings?repo=<name> — operator toggles the
 * conflict-check default for a repo. Auth: per-user bearer (mirrors
 * `handlePatchToggle`). The dispatch token is intentionally NOT
 * accepted here; only dashboard users mutate settings.
 *
 * Body: `{conflictCheckEnabled: boolean}`. Anything else 400s. The
 * handler writes via `writeSettings` (which preserves overrides +
 * agents + display) and returns the refreshed `agentDefaults` block.
 */
export async function handlePatchAgentDefaults(
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

  const enabled = body["conflictCheckEnabled"];
  if (enabled !== true && enabled !== false) {
    json(res, 400, { error: "conflictCheckEnabled must be true or false" });
    return;
  }

  try {
    await writeSettings(repo.localPath, {
      agentDefaults: { conflictCheckEnabled: enabled },
      writtenBy: `${DASHBOARD_PREFIX}${auth.user.username}`,
    });
    const refreshed = readSettings(repo.localPath);
    json(res, 200, {
      settings: {
        conflictCheckEnabled:
          refreshed.agentDefaults?.conflictCheckEnabled ?? true,
      },
    });
  } catch (err) {
    log.error(
      `handlePatchAgentDefaults(${repoName}, ${enabled}) failed`,
      err,
    );
    json(res, 500, {
      error:
        err instanceof Error ? err.message : "Failed to update agentDefaults",
    });
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

  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: repo.name,
      primaryHost: deps.resolveHost(repo.name),
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

/**
 * Probe the worker's `/api/jobs` endpoint to determine whether any
 * dispatch is currently active for the named repo. Used as the 409
 * gate for `PUT /api/agents/:repo/issue-prefix` so we never run the
 * file-renaming migration while an agent holds a YAML lock. Returns
 * `false` on any probe failure (worker down / timeout / parse error)
 * — a stuck worker should not block prefix migration; the migration
 * is itself filesystem-only and the worker will reload on its next
 * restart anyway.
 */
async function workerHasActiveDispatch(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = httpRequest(
      {
        host,
        port,
        path: "/api/jobs",
        method: "GET",
        timeout: 2_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolveProbe(false);
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
            const activeStates = new Set([
              "running",
              "queued",
              "starting",
              "spawning",
            ]);
            const active = jobs.some((j: { status?: unknown }) => {
              const status =
                typeof j?.status === "string" ? j.status : "running";
              return activeStates.has(status);
            });
            resolveProbe(active);
          } catch {
            resolveProbe(false);
          }
        });
      },
    );
    req.on("error", () => resolveProbe(false));
    req.on("timeout", () => {
      req.destroy();
      resolveProbe(false);
    });
    req.end();
  });
}

/**
 * `PUT /api/agents/:repo/issue-prefix` — Phase 4 of DX-99. Operator-
 * driven flip of a connected repo's `issue_prefix` field plus the
 * full file-rename + content-rewrite migration via `runMigration`.
 *
 * Body: `{prefix: string}` — must match `ISSUE_PREFIX_SHAPE`
 * (`/^[A-Z]{2,4}$/`).
 *
 * Response: `{prefix, migratedFiles}`. `migratedFiles` is the count
 * across both `open/` and `closed/` (renames + content rewrites
 * collapsed to one number per the AC contract).
 *
 * Auth: per-user bearer (`requireUser`). Mirrors `handlePatchToggle`.
 *
 * Errors:
 * - 400 — bad regex on `prefix`, missing body, or new prefix equals
 *   current prefix (no-op rejected to keep the SSE side-effect honest).
 * - 401 — no/invalid bearer.
 * - 404 — unknown repo.
 * - 409 — an active dispatch holds a YAML lock for this repo. The
 *   migration would race the agent's write. Operator must wait or
 *   cancel the dispatch via `/api/cancel/<jobId>` first.
 * - 500 — migration encountered an error and rolled back. Body carries
 *   the per-repo `errors[]` from `runMigration` for diagnosis.
 *
 * Side effects on success:
 * - `<repo>/.danxbot/config/config.yml#issue_prefix` is rewritten via
 *   `setConfigPrefix` (called inside `runMigration`).
 * - Every YAML under `<repo>/.danxbot/issues/{open,closed}/` is renamed
 *   from `<old>-N.yml` to `<new>-N.yml` and its content rewritten.
 * - `eventBus.publish({topic: "agent:updated", ...})` fires so the SPA
 *   can refresh the Issues tab with the new prefix's chips.
 *
 * Note: the dashboard process and the worker process both cache
 * `RepoContext.issuePrefix` at startup. After this route succeeds the
 * file system is consistent, but the worker keeps the OLD prefix in
 * memory until its container restarts. The Issues tab refreshes via
 * SSE — issue lookups go through the new YAML filenames + the new
 * config.yml, so the SPA renders correctly without a worker bounce.
 * Agents dispatched between the prefix flip and the next worker
 * restart will see the new prefix on every fresh `loadIssuePrefix`
 * call (which is invoked at dispatch time, not cached at boot for
 * the dispatched-agent path).
 */
export async function handlePutIssuePrefix(
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

  const rawPrefix = body["prefix"];
  if (typeof rawPrefix !== "string" || !ISSUE_PREFIX_SHAPE.test(rawPrefix)) {
    json(res, 400, {
      error: `prefix must match ${ISSUE_PREFIX_SHAPE} (2-4 uppercase ASCII letters)`,
    });
    return;
  }
  const newPrefix = rawPrefix;

  let currentPrefix: string;
  try {
    currentPrefix = loadIssuePrefix(repo.localPath);
  } catch (err) {
    json(res, 500, {
      error:
        err instanceof Error
          ? `Failed to read current issue_prefix: ${err.message}`
          : "Failed to read current issue_prefix",
    });
    return;
  }

  if (currentPrefix === newPrefix) {
    json(res, 400, {
      error: `prefix is already "${newPrefix}" — no-op rejected`,
    });
    return;
  }

  const host = deps.resolveHost(repo.name);
  const active = await workerHasActiveDispatch(host, repo.workerPort);
  if (active) {
    json(res, 409, {
      error:
        "Active dispatch holds a YAML lock for this repo; wait for it to complete or cancel via /api/cancel/<jobId>",
    });
    return;
  }

  let migrationResult;
  try {
    migrationResult = runMigration({
      repos: [
        {
          repoRoot: repo.localPath,
          oldPrefix: currentPrefix,
          newPrefix,
        },
      ],
      log: (msg) => log.info(`[issue-prefix:${repo.name}] ${msg}`),
    });
  } catch (err) {
    log.error(
      `handlePutIssuePrefix(${repo.name}): runMigration threw`,
      err,
    );
    json(res, 500, {
      error:
        err instanceof Error
          ? `Migration threw: ${err.message}`
          : "Migration threw",
    });
    return;
  }

  const repoResult = migrationResult.perRepo[0];
  if (!repoResult || repoResult.errors.length > 0 || repoResult.rolledBack) {
    log.error(
      `handlePutIssuePrefix(${repo.name}): migration rolled back`,
      repoResult,
    );
    json(res, 500, {
      error: "Migration failed and was rolled back",
      details: repoResult?.errors ?? ["unknown migration error"],
      rolledBack: repoResult?.rolledBack ?? false,
    });
    return;
  }

  const migratedFiles = repoResult.filesRenamed + repoResult.filesRewritten;

  // Broadcast so the Issues tab + Agents tab refresh without a poll.
  eventBus.publish({
    topic: "issue-prefix:changed",
    data: {
      repo: repo.name,
      oldPrefix: currentPrefix,
      newPrefix,
      migratedFiles,
    },
  });

  json(res, 200, { prefix: newPrefix, migratedFiles });
}
