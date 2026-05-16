/**
 * Worker-side agent worktree provisioning route.
 *
 * Mounted at:
 *   POST   /api/worktree-bootstrap         body: {name}
 *   DELETE /api/worktree-bootstrap/:name
 *
 * Runs `worktreeManager.bootstrap(repo, name)` / `.teardown(repo, name)`
 * inside the worker container — which IS joined to the consumer repo's
 * Docker network and CAN therefore reach `pgsql` / `redis` / etc. by
 * DNS name. The dashboard container is on `danxbot-net` only and would
 * `getaddrinfo ENOTFOUND pgsql` if it ran the same call locally.
 *
 * The dashboard's `handlePostAgent` / `handleDeleteAgent` keep owning
 * the settings-record write + response shape; only the worktree
 * provisioning side-effect is delegated here, via a thin shim that
 * implements the `WorktreeManager` interface but speaks HTTP to this
 * route (`createRemoteWorktreeManager` in
 * `src/dashboard/remote-worktree-manager.ts`).
 *
 * Auth: `DANXBOT_DISPATCH_TOKEN` (the same bot↔repo bearer the rest of
 * the worker routes use).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { checkAuth } from "../dashboard/dispatch-proxy.js";
import { createLogger } from "../logger.js";
import { createWorktreeManager } from "../agent/worktree-manager.js";
import { AGENT_NAME_SHAPE } from "../settings-file.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-agents-route");
const manager = createWorktreeManager();

function rejectUnauth(res: ServerResponse): void {
  json(res, 401, { error: "Unauthorized" });
}

function rejectBadName(res: ServerResponse, name: unknown): void {
  json(res, 400, {
    error: `name must match ${AGENT_NAME_SHAPE} — got ${JSON.stringify(name)}`,
  });
}

export async function handleWorktreeBootstrap(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
  token: string,
): Promise<void> {
  const auth = checkAuth(req, token);
  if (!auth.ok) return rejectUnauth(res);

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const name = body["name"];
  if (typeof name !== "string" || !AGENT_NAME_SHAPE.test(name)) {
    return rejectBadName(res, name);
  }

  try {
    await manager.bootstrap(repo, name);
    log.info(`bootstrap(${repo.name}, ${name}) succeeded`);
    res.writeHead(204);
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`bootstrap(${repo.name}, ${name}) failed: ${msg}`);
    json(res, 500, { error: msg });
  }
}

export async function handleWorktreeTeardown(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
  agentName: string,
  token: string,
): Promise<void> {
  const auth = checkAuth(req, token);
  if (!auth.ok) return rejectUnauth(res);

  if (!AGENT_NAME_SHAPE.test(agentName)) {
    return rejectBadName(res, agentName);
  }

  try {
    await manager.teardown(repo, agentName);
    log.info(`teardown(${repo.name}, ${agentName}) succeeded`);
    res.writeHead(204);
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`teardown(${repo.name}, ${agentName}) failed: ${msg}`);
    json(res, 500, { error: msg });
  }
}
