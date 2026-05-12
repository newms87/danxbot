/**
 * Mutation routes for the Agents tab — feature toggles, conflict-check
 * default, critical-failure flag clear, agent roster fetch, Trello
 * credential rotation.
 *
 *   GET    /api/agents?repo=<name>                       → handleGetRoster
 *   PATCH  /api/agents/:repo/toggles                     → handlePatchToggle
 *   PATCH  /api/agents-settings?repo=<name>              → handlePatchAgentDefaults
 *   PATCH  /api/agents/:repo/trello-credentials          → handlePatchTrelloCredentials
 *   DELETE /api/agents/:repo/critical-failure            → handleClearAgentCriticalFailure
 *
 * All five require a per-user bearer issued from `/api/auth/login` —
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
import {
  agentBusyOn,
  countDispatchesByRepo,
  type AgentBusyOn,
  type RepoDispatchCounts,
} from "./dispatches-db.js";
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
import { writeRepoEnvVars } from "./repo-env-writer.js";

const log = createLogger("agents-toggles");

/**
 * Roster shape returned by `GET /api/agents?repo=<name>` (DX-159 Phase 1).
 *
 * Each `agents[i]` is the per-repo `AgentRecord` enriched with `name`
 * (DX-159) plus an optional `busyOn` field (DX-164 Phase 6) describing
 * the agent's currently in-flight dispatch — `card_id` is the issue id
 * the agent is working on (`null` for slack/api dispatches), `started_at`
 * is the dispatch's epoch ms, `dispatch_id` is the dispatch UUID. The
 * SPA renders the green-dot busy badge off this field; absence means
 * idle.
 */
export interface AgentRosterEntry extends AgentRecordWithName {
  busyOn?: AgentBusyOn;
}

export interface AgentRosterResponse {
  agents: AgentRosterEntry[];
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
    // DX-164 Phase 6: join the live `dispatches` table so each agent
    // surfaces its in-flight `busyOn`. Best-effort — a DB hiccup logs
    // and returns the roster with no busy info rather than 500-ing
    // the whole page; the SPA renders idle-grey-dot for everyone in
    // that case, which is the correct degraded UX.
    const busyMap = await agentBusyOn(repo.name).catch((err) => {
      log.warn(
        `handleGetRoster(${repoName}): agentBusyOn lookup failed — rendering with idle state`,
        err,
      );
      return new Map<string, AgentBusyOn>();
    });
    const agents: AgentRosterEntry[] = Object.entries(agentsMap).map(
      ([name, record]) => {
        const busy = busyMap.get(name);
        return busy ? { name, ...record, busyOn: busy } : { name, ...record };
      },
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

/**
 * Reject any value containing characters that would corrupt a `.env`
 * file or smuggle additional assignments through the writer. Trello
 * API keys + tokens are alphanumeric in practice (Trello issues hex
 * keys and ~64-char hex tokens), so the rejected character class is
 * deliberately strict — newline / carriage-return / null byte. The
 * empty / whitespace-only / non-string cases are caught separately so
 * the 400 error message points at the actual defect.
 */
const FORBIDDEN_VALUE_CHARS = /[\n\r\0]/;

interface CredentialPatchBody {
  apiKey?: string;
  apiToken?: string;
}

/**
 * Map of dashboard-facing field names to the env vars they rotate.
 * Centralised so the handler, the response, and a future field can all
 * reference the same source of truth.
 */
const CREDENTIAL_FIELD_TO_ENV: Record<keyof CredentialPatchBody, string> = {
  apiKey: "DANX_TRELLO_API_KEY",
  apiToken: "DANX_TRELLO_API_TOKEN",
};

/**
 * PATCH /api/agents/:repo/trello-credentials — user-bearer auth required.
 *
 * Rotates `DANX_TRELLO_API_KEY` / `DANX_TRELLO_API_TOKEN` in
 * `<repo>/.danxbot/.env` without operators having to SSH and hand-edit
 * the file. The credentials live in the env file (NOT
 * `settings.json`) because the existing pattern routes secrets through
 * `<repo>/.danxbot/.env` — see `.claude/rules/docker-runtime.md` —
 * and `settings.json` carries only masked display mirrors.
 *
 * Response shape: `{updated: ["apiKey", "apiToken"], restartRequired: true}`.
 * The list names the fields that were rotated; the raw values are
 * NEVER echoed back. `restartRequired: true` is the AC-permitted
 * shortcut for live RepoContext reload — the chokidar watcher on
 * `<repo>/.danxbot/.env` in `startWorkerMode` logs the change but the
 * cached `repoContexts[0]` reference is captured at boot and threaded
 * into ~20 downstream consumers (mirror, dispatcher, MCP injection,
 * reattach), so a full live-swap would be a parallel refactor of its
 * own. Credential rotation is rare enough that "restart the worker"
 * is a reasonable operator cue; the dashboard SPA surfaces the
 * `restartRequired` flag in the next iteration of the Trello config
 * panel (Phase 3).
 *
 * Validation (fail-loud, 400 each):
 *  - body parses as JSON object
 *  - at least one of `apiKey` / `apiToken` is present
 *  - present field is a non-empty string
 *  - present field doesn't contain newline / CR / null byte
 *
 * Authentication:
 *  - per-user bearer required; `DANXBOT_DISPATCH_TOKEN` rejected — the
 *    dispatch token is bot↔repo (`/api/launch` and friends) and must
 *    NEVER unlock secret rotation.
 */
export async function handlePatchTrelloCredentials(
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

  const apiKey = body["apiKey"];
  const apiToken = body["apiToken"];

  if (apiKey === undefined && apiToken === undefined) {
    json(res, 400, {
      error:
        "No credential field to update — body must include apiKey and/or apiToken",
    });
    return;
  }

  const updates: Record<string, string> = {};
  const updatedFields: Array<keyof CredentialPatchBody> = [];

  for (const field of ["apiKey", "apiToken"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      json(res, 400, { error: `${field} must be a string` });
      return;
    }
    if (value.trim().length === 0) {
      json(res, 400, { error: `${field} must be a non-empty string` });
      return;
    }
    if (FORBIDDEN_VALUE_CHARS.test(value)) {
      json(res, 400, {
        error: `${field} must not contain newline / carriage-return / null bytes`,
      });
      return;
    }
    updates[CREDENTIAL_FIELD_TO_ENV[field]] = value;
    updatedFields.push(field);
  }

  try {
    await writeRepoEnvVars({
      repoLocalPath: repo.localPath,
      updates,
      writtenBy: `${DASHBOARD_PREFIX}${auth.user.username}`,
    });
    json(res, 200, {
      updated: updatedFields,
      restartRequired: true,
    });
  } catch (err) {
    log.error(
      `handlePatchTrelloCredentials(${repoName}, [${updatedFields.join(", ")}]) failed`,
      err,
    );
    json(res, 500, {
      error:
        err instanceof Error ? err.message : "Failed to rotate Trello credentials",
    });
  }
}
