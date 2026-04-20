/**
 * External /api/launch → worker proxy routes for dashboard mode.
 *
 * Workers are never reachable from the public internet — Caddy only fronts
 * the dashboard on :5555. To give external dispatchers (e.g. gpt-manager's
 * Laravel app) a way to launch agents, the dashboard exposes:
 *
 *   POST /api/launch           — forwards to worker POST /api/launch
 *   POST /api/resume           — forwards to worker POST /api/resume
 *   GET  /api/status/:jobId    — forwards to worker GET  /api/status/:jobId
 *   POST /api/cancel/:jobId    — forwards to worker POST /api/cancel/:jobId
 *   POST /api/stop/:jobId      — forwards to worker POST /api/stop/:jobId
 *
 * Every proxied request requires `Authorization: Bearer <DANXBOT_DISPATCH_TOKEN>`.
 * The token is materialized into the dashboard container's .env from SSM.
 *
 * Worker resolution: the request body carries `repo` (launch) or the route
 * already scopes by jobId (status/cancel/stop). Launch looks up the
 * matching RepoConfig and forwards to
 * `http://${deps.resolveHost(name)}:${workerPort}/api/launch`. Status/cancel/stop
 * must include `?repo=<name>` since the dashboard does not persist the
 * jobId→worker mapping (workers do).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { request as httpRequest } from "http";
import { optional } from "../env.js";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";

const log = createLogger("dispatch-proxy");

/** Overall upstream request timeout (connect + read) — not connect-only. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Docker hostname for a worker container. Matches `container_name` in the
 * per-repo compose file: `danxbot-worker-<name>`. All workers sit on
 * `danxbot-net` alongside the dashboard.
 */
export function workerHost(repoName: string): string {
  return `danxbot-worker-${repoName}`;
}

/** Strip the `Bearer ` prefix. Returns null when header is missing/malformed. */
function extractBearer(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Timing-safe compare. Bearer tokens are short — the difference is negligible
 * here, but a length-mismatch early-return leaks length. Equal-length buffers
 * go through a constant-time XOR.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

export function checkAuth(
  req: IncomingMessage,
  expectedToken: string,
): AuthResult {
  if (!expectedToken) {
    return { ok: false, reason: "server_missing_token" };
  }
  const token = extractBearer(req.headers["authorization"]);
  if (!token) return { ok: false, reason: "missing_bearer" };
  if (!safeEqual(token, expectedToken)) {
    return { ok: false, reason: "invalid_token" };
  }
  return { ok: true };
}

function rejectUnauthorized(res: ServerResponse, result: AuthResult): void {
  if (result.reason === "server_missing_token") {
    json(res, 500, {
      error:
        "DANXBOT_DISPATCH_TOKEN is not configured on this dashboard — external dispatch is disabled",
    });
    return;
  }
  json(res, 401, { error: "Unauthorized" });
}

function resolveRepo(name: string, repos: RepoConfig[]): RepoConfig | null {
  return repos.find((r) => r.name === name) ?? null;
}

/**
 * Emit an upstream error response, or simply end the stream if headers were
 * already flushed. Shared between connect-error, read-error, and timeout paths
 * so the `headersSent` guard is applied consistently.
 */
function sendUpstreamError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  if (!res.headersSent) {
    json(res, status, { error: message });
  } else {
    res.end();
  }
}

/**
 * Proxy an incoming HTTP request to a worker URL. Buffers the upstream body
 * and forwards it with the upstream status and Content-Type. Uses
 * `res.end(buffer)` rather than `pipe()` so mock responses in unit tests work
 * without a duplex stream.
 */
export async function proxyToWorker(
  _req: IncomingMessage,
  res: ServerResponse,
  upstream: { host: string; port: number; path: string; method: string },
  body: string | null,
): Promise<void> {
  return new Promise((resolve) => {
    const outgoingHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (body !== null) {
      outgoingHeaders["Content-Length"] = Buffer.byteLength(body).toString();
    }

    const upstreamReq = httpRequest(
      {
        host: upstream.host,
        port: upstream.port,
        path: upstream.path,
        method: upstream.method,
        headers: outgoingHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const contentType =
          upstreamRes.headers["content-type"] ?? "application/json";
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          res.writeHead(status, { "Content-Type": contentType });
          res.end(Buffer.concat(chunks).toString("utf-8"));
          resolve();
        });
        upstreamRes.on("error", (err) => {
          log.error(
            `Upstream response error from ${upstream.host}:${upstream.port}${upstream.path}`,
            err,
          );
          sendUpstreamError(res, 502, `Upstream read failed: ${err.message}`);
          resolve();
        });
      },
    );

    upstreamReq.on("error", (err) => {
      log.warn(
        `Worker upstream unreachable (${upstream.host}:${upstream.port}${upstream.path}): ${err.message}`,
      );
      sendUpstreamError(
        res,
        502,
        `Worker for this request is not reachable (${err.message})`,
      );
      resolve();
    });

    upstreamReq.on("timeout", () => {
      // Socket-level timeout — destroy triggers the error handler above with
      // the message we pass here, which calls `sendUpstreamError` with the
      // same headersSent guard as a connect failure.
      upstreamReq.destroy(new Error("Upstream timeout"));
    });

    if (body !== null) upstreamReq.write(body);
    upstreamReq.end();
  });
}

/**
 * Load the dispatch bearer token from env. Returns empty string when unset —
 * `checkAuth` translates that to a 500 with a clear message so the dashboard
 * can still boot for non-dispatch use (Trello polling, Slack agent, UI).
 */
export function loadDispatchToken(): string {
  return optional("DANXBOT_DISPATCH_TOKEN", "");
}

export interface DispatchProxyDeps {
  token: string;
  repos: RepoConfig[];
  /** Resolves a repo name to its worker hostname. Required — tests inject one. */
  resolveHost: (repoName: string) => string;
}

/**
 * Auth-check and resolve the repo (plus port) for a proxied request. Writes a
 * 401/404/500 and returns null on failure; returns the repo on success.
 * Shared by launch and status/cancel/stop handlers so the auth+resolve
 * sequence lives in one place.
 */
async function authAndResolveRepo(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchProxyDeps,
  repoName: string | null,
): Promise<RepoConfig | null> {
  const auth = checkAuth(req, deps.token);
  if (!auth.ok) {
    rejectUnauthorized(res, auth);
    return null;
  }
  if (!repoName) {
    json(res, 400, {
      error: "`repo` identifier is required (body field or query parameter)",
    });
    return null;
  }
  const repo = resolveRepo(repoName, deps.repos);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return null;
  }
  if (!repo.workerPort) {
    // Defense-in-depth — src/config.ts::attachWorkerPorts enforces this at
    // boot so this path is unreachable when the dashboard starts cleanly.
    json(res, 500, {
      error: `Repo "${repoName}" has no workerPort configured on this dashboard`,
    });
    return null;
  }
  return repo;
}

/**
 * Auth + body.repo → forward to the matching worker at `upstreamPath`.
 * Shared between `/api/launch` and `/api/resume` — both routes have the same
 * request shape (repo is carried in the JSON body, not the URL) and the same
 * auth contract.
 */
async function forwardRepoBodyToWorker(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchProxyDeps,
  upstreamPath: string,
): Promise<void> {
  // Auth first — don't parse the body for unauthenticated callers.
  const authCheck = checkAuth(req, deps.token);
  if (!authCheck.ok) {
    rejectUnauthorized(res, authCheck);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const repoName = typeof body["repo"] === "string" ? body["repo"] : null;
  const repo = await authAndResolveRepo(req, res, deps, repoName);
  if (!repo) return;

  await proxyToWorker(
    req,
    res,
    {
      host: deps.resolveHost(repo.name),
      port: repo.workerPort as number,
      path: upstreamPath,
      method: "POST",
    },
    JSON.stringify(body),
  );
}

/**
 * POST /api/launch proxy — auth + body.repo → forward to worker.
 */
export async function handleLaunchProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchProxyDeps,
): Promise<void> {
  await forwardRepoBodyToWorker(req, res, deps, "/api/launch");
}

/**
 * POST /api/resume proxy — auth + body.repo → forward to worker. The worker's
 * resume handler validates `body.job_id` (parent dispatch id) and resolves
 * the Claude session file on disk; the proxy is a pure pass-through.
 */
export async function handleResumeProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchProxyDeps,
): Promise<void> {
  await forwardRepoBodyToWorker(req, res, deps, "/api/resume");
}

/**
 * Proxy for status/cancel/stop routes. Requires `?repo=<name>` on the URL
 * because the dashboard does not store the jobId→worker mapping; workers do.
 */
export async function handleJobProxy(
  req: IncomingMessage,
  res: ServerResponse,
  params: { method: string; pathTemplate: string; jobId: string; repoName: string | null },
  deps: DispatchProxyDeps,
): Promise<void> {
  const repo = await authAndResolveRepo(req, res, deps, params.repoName);
  if (!repo) return;

  let body: string | null = null;
  if (params.method === "POST") {
    try {
      const parsed = await parseBody(req);
      body = JSON.stringify(parsed);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
  }

  await proxyToWorker(
    req,
    res,
    {
      host: deps.resolveHost(repo.name),
      port: repo.workerPort as number,
      path: params.pathTemplate.replace(":jobId", encodeURIComponent(params.jobId)),
      method: params.method,
    },
    body,
  );
}
