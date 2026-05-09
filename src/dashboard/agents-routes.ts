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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve as resolvePath } from "node:path";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import {
  countDispatchesByRepo,
  findNonTerminalDispatches,
  type RepoDispatchCounts,
} from "./dispatches-db.js";
import {
  AGENT_CAPABILITIES,
  AGENT_NAME_SHAPE,
  AGENTS_MAX,
  DASHBOARD_PREFIX,
  FEATURES,
  SCHEDULE_WINDOW_SHAPE,
  isValidIanaTimeZone,
  mutateAgents,
  readSettings,
  writeSettings,
  type AgentCapability,
  type AgentRecord,
  type AgentRecordWithName,
  type AgentSchedule,
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

// ============================================================
// DX-160 — Agent CRUD (POST/PATCH/DELETE) + avatar upload/serve
// ============================================================

/**
 * Per-agent on-disk asset directory: `<repo.localPath>/.danxbot/agents/<name>/`.
 * The `<name>` segment is always a name that already passed
 * `AGENT_NAME_SHAPE` validation (URL/branch/path-safe), so traversal is
 * structurally impossible — but `assertWithinAgentsRoot` defends against
 * a future regression that lets a non-validated name reach this helper.
 */
function agentDir(repo: RepoConfig, name: string): string {
  return resolvePath(repo.localPath, ".danxbot", "agents", name);
}

/**
 * Avatars live alongside per-agent state at
 * `<repo.localPath>/.danxbot/agents/<name>/avatar.<ext>`. The file extension
 * mirrors the request's MIME type (png/jpeg/webp); only one avatar per
 * agent — uploading a new image overwrites the previous file even when
 * the extension differs (the new file is written first, the previous-ext
 * file is unlinked second). The `.danxbot/agents/` subtree is gitignored.
 */
const ALLOWED_AVATAR_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
]);

const AVATAR_EXTS: readonly string[] = ["png", "jpg", "jpeg", "webp"] as const;

const AVATAR_MAX_BYTES = 1_000_000; // 1 MB hard cap (AC #11)

const AVATAR_MIME_FROM_EXT: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

/**
 * Defense-in-depth: prove a candidate path resolves WITHIN the repo's
 * `.danxbot/agents/` subtree before any filesystem mutation. Returns
 * `null` when safe; an error message string otherwise. Names that pass
 * `AGENT_NAME_SHAPE` already preclude traversal — this guard exists so
 * a future bug that lets an unvalidated name reach the FS layer fails
 * loudly rather than escaping to an arbitrary path.
 */
function assertWithinAgentsRoot(
  repo: RepoConfig,
  candidate: string,
): string | null {
  const root = resolvePath(repo.localPath, ".danxbot", "agents");
  const abs = resolvePath(candidate);
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    return `path "${candidate}" escapes .danxbot/agents/ root`;
  }
  return null;
}

/**
 * Read the input body, run shape validation common to POST + PATCH (bio,
 * capabilities, schedule, enabled, avatar_path). Returns either a
 * `{record}` (every field client supplied, normalized) or `{errors[]}`.
 *
 * Phase 2's CRUD handlers are explicit about validation — `normalize()`
 * in `settings-file.ts` is forgiving (drops invalid fields silently) so
 * a malformed disk file degrades to defaults rather than crashing the
 * worker. HTTP requests get the opposite contract: every malformed
 * field surfaces a 400 with a specific error message so the SPA's edit
 * drawer can highlight the bad input.
 */
interface AgentValidationFields {
  bio?: string;
  capabilities?: AgentCapability[];
  schedule?: AgentSchedule;
  enabled?: boolean;
}

/**
 * Hot-path file `settings.json` is read on every Slack message, every
 * poller tick, and every `/api/launch` (`isFeatureEnabled`). Cap bio
 * length so an oversized bio can't degrade those paths. 4 KB is plenty
 * for a human-readable persona; longer values 400 with a clear error.
 */
const BIO_MAX_BYTES = 4_000;

function validateAgentFields(
  body: Record<string, unknown>,
  opts: { requireAll: boolean },
): { fields: AgentValidationFields } | { errors: string[] } {
  const errors: string[] = [];
  const fields: AgentValidationFields = {};

  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key);

  // `avatar_path` is reserved for `handlePostAvatar` to stamp server-side.
  // Accepting it from a PATCH/POST body would let a client set a stale
  // path or, worse, point at another agent's file. Defense in depth: the
  // GET handler's `assertWithinAgentsRoot` guard already prevents the
  // serve-side leak, but we want the data on disk to stay clean too.
  if (has("avatar_path")) {
    errors.push("avatar_path is read-only — upload via POST /avatar");
  }

  if (has("bio")) {
    if (typeof body.bio !== "string") errors.push("bio must be a string");
    else if (body.bio.length > BIO_MAX_BYTES)
      errors.push(`bio is too long — max ${BIO_MAX_BYTES} characters`);
    else fields.bio = body.bio;
  } else if (opts.requireAll) {
    errors.push("bio is required");
  }

  if (has("enabled")) {
    if (typeof body.enabled !== "boolean")
      errors.push("enabled must be a boolean");
    else fields.enabled = body.enabled;
  } else if (opts.requireAll) {
    errors.push("enabled is required");
  }

  if (has("capabilities")) {
    const cap = body.capabilities;
    if (!Array.isArray(cap) || cap.length === 0) {
      errors.push("capabilities must be a non-empty array");
    } else {
      const known = new Set<string>(AGENT_CAPABILITIES);
      const filtered: AgentCapability[] = [];
      let bad = false;
      for (const c of cap) {
        if (typeof c !== "string" || !known.has(c)) {
          errors.push(
            `capabilities[*] must each be one of: ${AGENT_CAPABILITIES.join(", ")}`,
          );
          bad = true;
          break;
        }
        filtered.push(c as AgentCapability);
      }
      if (!bad) fields.capabilities = Array.from(new Set(filtered));
    }
  } else if (opts.requireAll) {
    errors.push("capabilities is required");
  }

  if (has("schedule")) {
    const sched = validateScheduleShape(body.schedule);
    if ("error" in sched) errors.push(sched.error);
    else fields.schedule = sched.schedule;
  } else if (opts.requireAll) {
    errors.push("schedule is required");
  }

  if (errors.length > 0) return { errors };
  return { fields };
}

function validateScheduleShape(
  raw: unknown,
): { schedule: AgentSchedule } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "schedule must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (!isValidIanaTimeZone(r.tz)) {
    return {
      error: `schedule.tz must be a recognized IANA time zone — got ${typeof r.tz === "string" ? `"${r.tz}"` : typeof r.tz}`,
    };
  }
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const out: AgentSchedule = {
    tz: r.tz,
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
  for (const day of days) {
    const v = r[day];
    if (v === undefined) continue; // missing day → empty array (already initialized)
    if (!Array.isArray(v)) {
      return { error: `schedule.${day} must be an array of HH:MM-HH:MM strings` };
    }
    for (const w of v) {
      if (typeof w !== "string" || !SCHEDULE_WINDOW_SHAPE.test(w)) {
        return {
          error: `schedule.${day} contains an invalid window — each entry must match HH:MM-HH:MM (24h)`,
        };
      }
    }
    out[day] = v as string[];
  }
  return { schedule: out };
}

/**
 * Look up the repo + auth pair common to every mutation route. Centralizes
 * the 401/404 response so the handler bodies focus on business logic.
 * Returns the repo + the username on success; `null` after writing the
 * 401/404 itself.
 */
async function authAndResolveRepo(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  deps: DispatchProxyDeps,
): Promise<{ repo: RepoConfig; username: string } | null> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  if (!repoName) {
    json(res, 400, { error: "Missing required query param: repo" });
    return null;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return null;
  }
  return { repo, username: auth.user.username };
}

function namedRecord(name: string, record: AgentRecord): AgentRecordWithName {
  return { name, ...record };
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
async function publishAgentSnapshot(
  repo: RepoConfig,
  resolveHost: (name: string) => string,
): Promise<void> {
  try {
    const counts = await countDispatchesByRepo().catch(() => ({}) as Record<string, RepoDispatchCounts>);
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

/**
 * Helper used by the create/update mutators inside `mutateAgents`. The
 * mutator runs inside the per-file lock; throwing a `MutateError`
 * with a status code is the way to bail out of the lock cleanly while
 * keeping the HTTP status mapping at the handler boundary.
 */
class MutateError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * POST /api/agents?repo=<name> — DX-160 Phase 2.
 *
 * Body shape: `{name, bio, capabilities[], schedule, enabled,
 * avatar_path?}`. Server stamps `type:"agent"`, `created_at`,
 * `updated_at`. 5-cap (`AGENTS_MAX`) enforced after the read; duplicate
 * names rejected. Auth: per-user bearer.
 *
 * Returns 201 with `{name, ...record}` on success; 400 on validation;
 * 409 on cap-exceeded or duplicate name.
 *
 * Note on writeSettings semantics: the schema-level write replaces the
 * entire `agents` map. Per-agent CRUD is therefore a read-modify-write
 * — read the current settings, rebuild the agents map, write back.
 * `writeSettings`'s per-file lock + in-process queue serialize concurrent
 * writes within the worker process, so the sequence is atomic relative
 * to other dashboard mutations on the same file.
 */
export async function handlePostAgent(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const rawName = body.name;
  if (typeof rawName !== "string" || !AGENT_NAME_SHAPE.test(rawName)) {
    json(res, 400, {
      error: `name must match ${AGENT_NAME_SHAPE} (lowercase, starts with letter, ≤32 chars, [a-z0-9_-])`,
    });
    return;
  }
  const name = rawName;

  const validation = validateAgentFields(body, { requireAll: true });
  if ("errors" in validation) {
    json(res, 400, { error: "validation failed", errors: validation.errors });
    return;
  }
  const f = validation.fields;
  // requireAll=true guarantees these are present.
  if (
    f.bio === undefined ||
    f.capabilities === undefined ||
    f.schedule === undefined ||
    f.enabled === undefined
  ) {
    json(res, 400, { error: "validation failed" });
    return;
  }

  const now = new Date().toISOString();
  const record: AgentRecord = {
    type: "agent",
    bio: f.bio,
    capabilities: f.capabilities,
    schedule: f.schedule,
    enabled: f.enabled,
    created_at: now,
    updated_at: now,
  };

  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        if (Object.prototype.hasOwnProperty.call(current, name)) {
          throw new MutateError(409, `agent "${name}" already exists`);
        }
        if (Object.keys(current).length >= AGENTS_MAX) {
          throw new MutateError(
            409,
            `agent limit reached — at most ${AGENTS_MAX} agents per repo`,
          );
        }
        current[name] = record;
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(`handlePostAgent(${repo.name}, ${name}): mutateAgents threw`, err);
    json(res, 500, { error: "Failed to persist agent" });
    return;
  }

  await publishAgentSnapshot(repo, deps.resolveHost);
  json(res, 201, namedRecord(name, record));
}

/**
 * PATCH /api/agents/:name?repo=<name> — DX-160 Phase 2.
 *
 * Partial update. `name` is immutable — `body.name` 400s. Any subset of
 * `bio`, `capabilities`, `schedule`, `enabled`, `avatar_path` is
 * accepted; missing fields preserve their current value. Bumps
 * `updated_at`. Returns the refreshed `{name, ...record}` on 200.
 */
export async function handlePatchAgent(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    json(res, 400, { error: "name is immutable" });
    return;
  }

  const validation = validateAgentFields(body, { requireAll: false });
  if ("errors" in validation) {
    json(res, 400, { error: "validation failed", errors: validation.errors });
    return;
  }
  const f = validation.fields;

  let saved: AgentRecord | null = null;
  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        const record = current[agentName];
        if (!record) {
          throw new MutateError(404, `agent "${agentName}" not found`);
        }
        const updated: AgentRecord = {
          ...record,
          bio: f.bio ?? record.bio,
          capabilities: f.capabilities ?? record.capabilities,
          schedule: f.schedule ?? record.schedule,
          enabled: f.enabled ?? record.enabled,
          updated_at: new Date().toISOString(),
        };
        current[agentName] = updated;
        saved = updated;
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(
      `handlePatchAgent(${repo.name}, ${agentName}): mutateAgents threw`,
      err,
    );
    json(res, 500, { error: "Failed to persist agent update" });
    return;
  }

  if (!saved) {
    // Mutator success path always assigns; the !saved branch is
    // structurally unreachable but kept as a fail-loud guard.
    log.error(`handlePatchAgent(${repo.name}, ${agentName}): mutator did not capture saved record`);
    json(res, 500, { error: "Internal error capturing updated record" });
    return;
  }
  await publishAgentSnapshot(repo, deps.resolveHost);
  json(res, 200, namedRecord(agentName, saved));
}

/**
 * DELETE /api/agents/:name?repo=<name> — DX-160 Phase 2.
 *
 * Tear-down sequence:
 * 1. 409 if the named agent currently has any non-terminal dispatch
 *    (pre Phase-5 we conservatively treat ANY non-terminal dispatch in
 *    the repo as making every agent busy — `assigned_agent` linkage
 *    lands in DX-200 and tightens this check).
 * 2. Drop the record from `settings.agents`.
 * 3. `rm -rf <repo.localPath>/.danxbot/agents/<name>/` (avatar + any
 *    per-agent scratch). Best-effort; logs if it fails.
 * 4. Worktree teardown + branch deletion are Phase 3 (DX-161) — not
 *    invoked here. The current handler intentionally does NOT touch
 *    git: the worktree directory may not exist yet (Phase 3 owns
 *    bootstrap on agent create).
 *
 * Returns 204 on success.
 */
export async function handleDeleteAgent(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  // Busy check — Phase 2 conservative: any non-terminal dispatch in the
  // repo blocks. Phase 5 (DX-200) narrows this to assigned_agent ===
  // agentName once the lock-stamp lands. The check runs OUTSIDE the
  // settings lock since `dispatches` is a different storage layer; a
  // dispatch could in theory start between the probe and the write,
  // but the agent's worktree teardown is Phase 3 work — Phase 2's
  // contract is "remove the record + per-agent dir" which a stale
  // probe doesn't compromise.
  try {
    const active = await findNonTerminalDispatches(repo.name);
    if (active.length > 0) {
      json(res, 409, {
        error: `agent "${agentName}" is busy — ${active.length} non-terminal dispatch(es) in repo "${repo.name}"`,
      });
      return;
    }
  } catch (err) {
    log.error(`handleDeleteAgent(${repo.name}, ${agentName}): busy probe threw`, err);
    json(res, 500, { error: "Failed to probe dispatch state" });
    return;
  }

  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        if (!Object.prototype.hasOwnProperty.call(current, agentName)) {
          throw new MutateError(404, `agent "${agentName}" not found`);
        }
        delete current[agentName];
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(`handleDeleteAgent(${repo.name}, ${agentName}): mutateAgents threw`, err);
    json(res, 500, { error: "Failed to persist agent removal" });
    return;
  }

  // Best-effort filesystem cleanup. A failure here is logged but does
  // NOT roll back the settings write — the operator's stated intent
  // (delete this agent) has already taken effect; a stale `agents/<name>/`
  // directory is benign and gitignored.
  const dir = agentDir(repo, agentName);
  const escape = assertWithinAgentsRoot(repo, dir);
  if (escape) {
    log.error(`handleDeleteAgent(${repo.name}, ${agentName}): refusing to rm — ${escape}`);
  } else {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`handleDeleteAgent(${repo.name}, ${agentName}): rm ${dir} failed`, err);
    }
  }

  await publishAgentSnapshot(repo, deps.resolveHost);
  res.writeHead(204);
  res.end();
}

/**
 * POST /api/agents/:name/avatar?repo=<name> — DX-160 Phase 2.
 *
 * Raw-body upload. The card spec mentioned "multipart upload" but the
 * implementation uses a raw binary POST instead — no multipart parser
 * is shipped with this repo, and the browser FormData API can stream a
 * `File` blob directly via `fetch(url, {method:'POST', body: file})`
 * with `Content-Type` taken from `file.type`. Same security posture,
 * fewer moving parts, no new dependency.
 *
 * Validation (in this order):
 *   - 415 unsupported media type — anything outside png/jpeg/webp.
 *   - 413 payload too large — body > 1 MB (cap enforced at stream time
 *     so we never buffer a multi-megabyte body).
 *   - 404 unknown agent.
 *
 * Side effects on success:
 *   - Writes `<repo.localPath>/.danxbot/agents/<name>/avatar.<ext>`.
 *   - Removes any prior-extension avatar files for the same agent (so
 *     png → jpg upgrade leaves only the new file behind).
 *   - Updates `agents.<name>.avatar_path` to the relative path.
 *   - Bumps `updated_at`.
 *
 * Returns 200 with the refreshed `{name, ...record}`.
 */
export async function handlePostAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  // MIME validation FIRST so an oversized but unsupported MIME 415s
  // without us reading 1 MB into memory.
  const rawCt = req.headers["content-type"] ?? "";
  const ct = (typeof rawCt === "string" ? rawCt : "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_AVATAR_MIME.get(ct);
  if (!ext) {
    json(res, 415, {
      error: `unsupported media type "${ct}" — allowed: ${Array.from(ALLOWED_AVATAR_MIME.keys()).join(", ")}`,
    });
    // Drain the body so the client doesn't see a connection reset.
    req.resume();
    return;
  }

  // Read body with a hard cap. We can't trust Content-Length blindly
  // (clients can lie), so enforce at chunk-arrival time too.
  const collect = await readBoundedBody(req, AVATAR_MAX_BYTES);
  if ("tooLarge" in collect) {
    json(res, 413, {
      error: `payload too large — avatar must be ≤ ${AVATAR_MAX_BYTES} bytes`,
    });
    return;
  }
  if ("error" in collect) {
    json(res, 400, { error: `failed to read body: ${collect.error}` });
    return;
  }

  // Probe the agent's existence before writing bytes — a missing
  // record means the bytes would land orphaned on disk. The probe is
  // outside the lock; a delete that lands between the probe and the
  // write would leave the bytes orphaned (gitignored, benign — the
  // next delete or upload cleans them up).
  const probe = readSettings(repo.localPath).agents?.[agentName];
  if (!probe) {
    json(res, 404, { error: `agent "${agentName}" not found` });
    return;
  }

  const dir = agentDir(repo, agentName);
  const escape = assertWithinAgentsRoot(repo, dir);
  if (escape) {
    log.error(`handlePostAvatar(${repo.name}, ${agentName}): ${escape}`);
    json(res, 500, { error: "internal path error" });
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    // Remove any previous avatar files (different extension).
    for (const otherExt of AVATAR_EXTS) {
      if (otherExt === ext) continue;
      const stale = resolvePath(dir, `avatar.${otherExt}`);
      if (existsSync(stale)) {
        try {
          unlinkSync(stale);
        } catch (err) {
          log.warn(
            `handlePostAvatar(${repo.name}, ${agentName}): failed to unlink stale ${stale}`,
            err,
          );
        }
      }
    }
    const target = resolvePath(dir, `avatar.${ext}`);
    writeFileSync(target, collect.buffer);
  } catch (err) {
    log.error(`handlePostAvatar(${repo.name}, ${agentName}): write failed`, err);
    json(res, 500, { error: "Failed to persist avatar" });
    return;
  }

  let saved: AgentRecord | null = null;
  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        const record = current[agentName];
        if (!record) {
          throw new MutateError(404, `agent "${agentName}" not found`);
        }
        const updated: AgentRecord = {
          ...record,
          avatar_path: `agents/${agentName}/avatar.${ext}`,
          updated_at: new Date().toISOString(),
        };
        current[agentName] = updated;
        saved = updated;
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(
      `handlePostAvatar(${repo.name}, ${agentName}): mutateAgents threw`,
      err,
    );
    json(res, 500, { error: "Failed to persist avatar metadata" });
    return;
  }

  if (!saved) {
    log.error(`handlePostAvatar(${repo.name}, ${agentName}): mutator did not capture saved record`);
    json(res, 500, { error: "Internal error capturing updated record" });
    return;
  }
  await publishAgentSnapshot(repo, deps.resolveHost);
  json(res, 200, namedRecord(agentName, saved));
}

/**
 * GET /api/agents/:name/avatar?repo=<name> — DX-160 Phase 2.
 *
 * Serves the bytes from `<repo.localPath>/.danxbot/agents/<name>/avatar.<ext>`
 * with the Content-Type derived from the stored extension. 404 when the
 * agent record carries no `avatar_path`, when the file is missing on
 * disk, or when the agent itself doesn't exist.
 *
 * The handler runs under the dashboard's blanket `/api/*` user-auth gate
 * — no per-handler `requireUser` call needed (the gate produces the
 * 401 BEFORE this code runs).
 */
export async function handleGetAvatar(
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!repoName) {
    json(res, 400, { error: "Missing required query param: repo" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }

  let settings: Settings;
  try {
    settings = readSettings(repo.localPath);
  } catch (err) {
    log.error(`handleGetAvatar(${repo.name}, ${agentName}): readSettings threw`, err);
    json(res, 500, { error: "Failed to read settings" });
    return;
  }
  const record = settings.agents?.[agentName];
  if (!record) {
    json(res, 404, { error: `agent "${agentName}" not found` });
    return;
  }
  if (!record.avatar_path) {
    json(res, 404, { error: `agent "${agentName}" has no avatar` });
    return;
  }
  // avatar_path is relative to <repo.localPath>/.danxbot/. Resolve and
  // verify the result is contained within the repo's `.danxbot/agents/`
  // root before reading.
  const danxbotRoot = resolvePath(repo.localPath, ".danxbot");
  const file = resolvePath(danxbotRoot, record.avatar_path);
  const escape = assertWithinAgentsRoot(repo, file);
  if (escape) {
    log.error(`handleGetAvatar(${repo.name}, ${agentName}): ${escape}`);
    json(res, 404, { error: "avatar not found" });
    return;
  }
  if (!existsSync(file)) {
    json(res, 404, { error: "avatar file missing on disk" });
    return;
  }
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const mime = AVATAR_MIME_FROM_EXT.get(ext) ?? "application/octet-stream";
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    log.error(`handleGetAvatar(${repo.name}, ${agentName}): read failed`, err);
    json(res, 500, { error: "Failed to read avatar" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": "private, max-age=60",
  });
  res.end(bytes);
}

/**
 * Read an `IncomingMessage` body into a Buffer with a strict byte cap.
 * Aborts as soon as the running total exceeds the cap so an attacker
 * can't DOS the worker by streaming an oversized body. Returns one of
 * three shapes the caller pattern-matches on:
 *
 *   {buffer}         — body fits within the cap
 *   {tooLarge: true} — body exceeded the cap; request was destroyed
 *   {error}          — underlying socket error / parse failure
 */
function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ buffer: Buffer } | { tooLarge: true } | { error: string }> {
  return new Promise((resolveRead) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { buffer: Buffer } | { tooLarge: true } | { error: string }) => {
      if (settled) return;
      settled = true;
      resolveRead(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.destroy();
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ buffer: Buffer.concat(chunks) }));
    req.on("error", (err) =>
      finish({ error: err instanceof Error ? err.message : String(err) }),
    );
  });
}
