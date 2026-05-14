/**
 * Mutation routes for the Agents tab — feature toggles, critical-failure
 * flag clear, agent roster fetch, Trello credential rotation.
 *
 *   GET    /api/agents?repo=<name>                       → handleGetRoster
 *   PATCH  /api/agents/:repo/toggles                     → handlePatchToggle
 *   PATCH  /api/agents/:repo/trello-credentials          → handlePatchTrelloCredentials
 *   DELETE /api/agents/:repo/critical-failure            → handleClearAgentCriticalFailure
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
}

/**
 * GET /api/agents?repo=<name> — agent roster for a single repo. The
 * router dispatches here when the `?repo=` query is present; the
 * unparameterized variant continues to call `handleListAgents` for the
 * per-repo aggregation list. Same path, two shapes, distinct consumers
 * — see `.claude/rules/dashboard.md`.
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
    const body: AgentRosterResponse = { agents };
    json(res, 200, body);
  } catch (err) {
    log.error(`handleGetRoster(${repoName}) failed`, err);
    json(res, 500, { error: "Failed to load agent roster" });
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
 * POST /api/agents/:repo/re-run-evaluator — DX-367 (Phase 4b of
 * DX-363). User-bearer auth required.
 *
 * Thin proxy to the worker's `/api/re-run-evaluator` route. The
 * actual mutation + `broken-transition` emit lives on the worker
 * because the event bus is in-process and the evaluator-dispatcher
 * subscriber lives in the worker process; emitting from the
 * dashboard would never reach the worker in a multi-process
 * deployment (compose ships dashboard + per-repo worker as separate
 * containers).
 *
 * Body forwarded verbatim: `{name: "<agent-name>"}`. The worker
 * handles the validation + side-effects (missing/healthy/already-
 * running checks return 400/404 with the same shape the SPA
 * displays).
 */
export async function handleReRunEvaluator(
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

  // Read + re-serialize the body so `proxyToWorkerWithFallback` can
  // forward it as a string (req has already been consumed at this
  // point by upstream auth wrappers in some test fixtures). Also
  // lets us reject a malformed body with 400 BEFORE round-tripping
  // to the worker.
  let bodyStr: string;
  try {
    const parsed = await parseBody(req);
    bodyStr = JSON.stringify(parsed);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: repo.name,
      primaryHost: deps.resolveHost(repo.name),
      port: repo.workerPort,
      path: "/api/re-run-evaluator",
      method: "POST",
    },
    bodyStr,
  );
  // The proxy wrote the response (worker body verbatim); recorded
  // user attribution is the audit log via the worker's mutator
  // ("worker" writtenBy — we trade fine-grained "dashboard:<user>"
  // attribution for the simpler proxy chain since the worker doesn't
  // have a per-user identity to use). The auth-checked dashboard
  // bearer satisfies the access gate; the worker is on danxbot-net
  // only, not publicly reachable.
  log.info(
    `handleReRunEvaluator(${repoName}): proxied for user=${auth.user.username}`,
  );
}

/**
 * POST /api/agents/:repo/unblock — DX-369 (Phase 6 of DX-363). User-bearer
 * auth required.
 *
 * Thin proxy to the worker's `POST /api/clear-broken` (the broken stamp
 * and the strike counter live in `<repo>/.danxbot/settings.json`, which
 * the worker owns via `mutateAgents`'s per-file lock). The chokidar
 * settings.json watcher running in the dashboard process detects the
 * write and re-publishes the affected repo's snapshot on the
 * `agent:updated` SSE topic, so every connected dashboard tab sees the
 * banner row disappear without a manual refresh.
 *
 * Body forwarded verbatim: `{name: "<agent-name>"}`. Validation lives on
 * the worker — the proxy only enforces auth + the repo allowlist; the
 * worker maps missing/healthy/already-cleared to 400/404 with the same
 * shape the SPA renders.
 */
export async function handleClearAgentBroken(
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

  // Re-serialize the body for `proxyToWorkerWithFallback` — same shape
  // as `handleReRunEvaluator`. Worker enforces `{name: "<agent>"}`.
  let bodyStr: string;
  try {
    const parsed = await parseBody(req);
    bodyStr = JSON.stringify(parsed);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: repo.name,
      primaryHost: deps.resolveHost(repo.name),
      port: repo.workerPort,
      path: "/api/clear-broken",
      method: "POST",
    },
    bodyStr,
  );
  log.info(
    `handleClearAgentBroken(${repoName}): proxied for user=${auth.user.username}`,
  );
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
