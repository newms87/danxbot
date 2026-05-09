/**
 * Mutation routes for the Agents tab — feature toggles, conflict-check
 * default, critical-failure flag clear, agent roster fetch.
 *
 *   GET    /api/agents?repo=<name>                   → handleGetRoster
 *   PATCH  /api/agents/:repo/toggles                 → handlePatchToggle
 *   PATCH  /api/agents-settings?repo=<name>          → handlePatchAgentDefaults
 *   DELETE /api/agents/:repo/critical-failure        → handleClearAgentCriticalFailure
 *
 * All four require a per-user bearer issued from `/api/auth/login` —
 * `DANXBOT_DISPATCH_TOKEN` is NOT accepted (that's the bot↔repo
 * credential, scoped to `/api/launch` and friends via
 * `dispatch-proxy.ts`). See `.claude/rules/agent-dispatch.md` for the
 * full separation.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import { countDispatchesByRepo, type RepoDispatchCounts } from "./dispatches-db.js";
import {
  DASHBOARD_PREFIX,
  FEATURES,
  readSettings,
  writeSettings,
  type AgentRecordWithName,
  type Feature,
} from "../settings-file.js";
import { proxyToWorkerWithFallback } from "./dispatch-proxy.js";
import { eventBus } from "./event-bus.js";
import { buildSnapshot, emptyCounts } from "./agents-list.js";

const log = createLogger("agents-toggles");

/**
 * Roster shape returned by `GET /api/agents?repo=<name>` (DX-159 Phase 1).
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
 * conflict-check default for a repo. Body: `{conflictCheckEnabled: boolean}`.
 * Anything else 400s. The handler writes via `writeSettings` (which
 * preserves overrides + agents + display) and returns the refreshed
 * `agentDefaults` block.
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
