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
 *
 * **Binary-safe sibling:** `proxyToWorker` below is JSON-only — it hardcodes
 * the request Content-Type to application/json and calls `.toString("utf-8")`
 * on the response body, which silently corrupts non-UTF-8 bytes. Do NOT
 * reuse it for any upstream that returns binary data (screenshots, PDFs,
 * protobufs). The Playwright proxy (`/api/playwright/*`) lives in
 * `./playwright-proxy.ts` and preserves request/response bytes verbatim.
 * The auth helpers (`checkAuth`, `rejectUnauthorized`, `loadDispatchToken`)
 * are shared — import them from here, don't copy-paste them.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { request as httpRequest } from "http";
import { connect as netConnect } from "net";
import { optional } from "../env.js";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";

const log = createLogger("dispatch-proxy");

/** Overall upstream request timeout (connect + read) — not connect-only. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Worker-host resolution cache. Workers run either as docker containers
 * (DNS: `danxbot-worker-<repo>`) or as host-side processes (reachable from
 * inside the dashboard container via `host.docker.internal`). On every
 * proxied request we probe candidates in order until one connects, then
 * cache the winner so subsequent requests skip the probe.
 *
 * 24h TTL — long enough that day-to-day traffic doesn't probe; short enough
 * that a long-term mode switch (e.g. the team retires host mode) eventually
 * re-resolves without manual intervention. Cache is also invalidated on the
 * real proxied request's connect error, so any bad cache entry self-heals
 * within one failed request.
 */
const HOST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** TCP-probe timeout. Docker DNS + container-net latency is sub-50ms in
 * practice; 1s is a generous ceiling that still keeps fallback fast on a
 * dead candidate. */
const PROBE_TIMEOUT_MS = 1_000;

/** Docker's standard hostname for the host runtime, available in modern
 * Docker Desktop + dockerd configurations. Used as the fallback when the
 * configured per-repo container DNS doesn't resolve. */
const HOST_DOCKER_INTERNAL = "host.docker.internal";

interface CachedHostEntry {
  host: string;
  expiresAt: number;
}

const cachedWorkerHost = new Map<string, CachedHostEntry>();

function getCachedHost(repoName: string): string | null {
  const entry = cachedWorkerHost.get(repoName);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cachedWorkerHost.delete(repoName);
    return null;
  }
  return entry.host;
}

function setCachedHost(repoName: string, host: string): void {
  cachedWorkerHost.set(repoName, {
    host,
    expiresAt: Date.now() + HOST_CACHE_TTL_MS,
  });
}

/**
 * Drop the cached worker-host entry for a repo (or all of them when called
 * with no argument). Exposed so the on-connect-error hook in
 * `proxyToWorkerWithFallback` can self-heal a stale cache, and so admin
 * tooling has a clean way to force re-resolution without restarting the
 * dashboard.
 */
export function clearCachedWorkerHost(repoName?: string): void {
  if (repoName === undefined) {
    cachedWorkerHost.clear();
    return;
  }
  cachedWorkerHost.delete(repoName);
}

/**
 * Build the candidate host list in resolution order:
 *   1. Cached good host (if not expired) — most likely to succeed
 *   2. Primary host — the configured `workerHost` override OR the
 *      default `danxbot-worker-<name>` container DNS
 *   3. `host.docker.internal` — for repos whose worker is currently
 *      running on the host runtime instead of as a container
 *
 * Duplicates are collapsed (e.g. when the cached host is the same as the
 * primary, only one probe attempt is made).
 */
function buildCandidateHosts(primary: string, cached: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (host: string): void => {
    if (seen.has(host)) return;
    seen.add(host);
    out.push(host);
  };
  if (cached) add(cached);
  add(primary);
  add(HOST_DOCKER_INTERNAL);
  return out;
}

/**
 * TCP-handshake probe. Resolves to true if a connection establishes within
 * `timeoutMs`, false on any error or timeout. Connection is destroyed
 * immediately after a successful handshake — we only check reachability,
 * not application-layer health.
 *
 * Exported for tests; not part of the public API otherwise.
 */
export function probeReachable(
  host: string,
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const socket = netConnect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Test seam — swap the probe fn used by `resolveReachableHost`. Tests use
 * this to mock TCP-handshake outcomes without spinning up real servers on
 * `host.docker.internal` (unreachable from the CI runner). Prod code never
 * calls this.
 */
let activeProbe: typeof probeReachable = probeReachable;
export function _setProbeForTesting(
  fn: typeof probeReachable,
): typeof probeReachable {
  const prev = activeProbe;
  activeProbe = fn;
  return prev;
}

/**
 * Probe candidate hosts for `repoName` and return the first reachable one,
 * or null if every candidate fails. The winner is cached for
 * HOST_CACHE_TTL_MS so subsequent requests skip the probe loop.
 *
 * Cache eviction:
 *   - TTL expiry (read-time check in `getCachedHost`)
 *   - Probe miss on the cached entry (this fn deletes it before falling
 *     through, so the same request and all subsequent ones use the
 *     refreshed ordering)
 *   - Real-request connect error in `proxyToWorkerWithFallback` (via
 *     the `onConnectError` hook in `proxyToWorker`)
 */
async function resolveReachableHost(
  repoName: string,
  primary: string,
  port: number,
): Promise<string | null> {
  const cached = getCachedHost(repoName);
  for (const host of buildCandidateHosts(primary, cached)) {
    if (await activeProbe(host, port)) {
      setCachedHost(repoName, host);
      return host;
    }
    if (host === cached) {
      // Probe miss on the cached entry — drop it so the loop falls through
      // to the fresh ordering on the next iteration AND so subsequent
      // requests don't keep paying the probe-then-fail cost.
      cachedWorkerHost.delete(repoName);
    }
  }
  return null;
}

/**
 * Default docker hostname for a worker container. Matches `container_name`
 * in the per-repo compose file: `danxbot-worker-<name>`. All workers sit on
 * `danxbot-net` alongside the dashboard.
 *
 * For per-repo overrides — when a connected repo's compose file uses a
 * different `container_name` — declare `worker_host:` on the repo in the
 * deployment yml and use `makeResolveWorkerHost` below to build a resolver
 * that consults the override first and falls back to this default.
 */
export function workerHost(repoName: string): string {
  return `danxbot-worker-${repoName}`;
}

/**
 * Build the resolver consulted by `DispatchProxyDeps.resolveHost`. Returns
 * each repo's `workerHost` override when set, falling back to the default
 * `danxbot-worker-<name>`. Unknown names also fall back — `authAndResolveRepo`
 * 404s on unconfigured repos before resolveHost is reached for proxied
 * traffic, so the unknown-name path here is defense-in-depth (boot-time DNS
 * check, future callers, etc.), not a real lookup miss in the proxy hot path.
 */
export function makeResolveWorkerHost(
  repos: RepoConfig[],
): (repoName: string) => string {
  const byName = new Map(repos.map((r) => [r.name, r]));
  return (repoName) => byName.get(repoName)?.workerHost ?? workerHost(repoName);
}

/** Strip the `Bearer ` prefix. Returns null when header is missing/malformed. */
export function extractBearer(
  header: string | string[] | undefined,
): string | null {
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

export function rejectUnauthorized(
  res: ServerResponse,
  result: AuthResult,
): void {
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
 * Optional hooks for `proxyToWorker`. Currently only `onConnectError` is
 * exposed — used by `proxyToWorkerWithFallback` to invalidate the cached
 * host the moment the real proxied request fails to connect, so the
 * cache self-heals within one failed request.
 */
export interface ProxyToWorkerHooks {
  onConnectError?: (host: string, err: Error) => void;
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
  hooks: ProxyToWorkerHooks = {},
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
      hooks.onConnectError?.(upstream.host, err);
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
 * Container-or-host-aware request wrapper. Resolves a reachable host for
 * `repoName` (cache + probe loop), then proxies to it. Wraps the existing
 * `proxyToWorker` so all the JSON-only / Content-Length / timeout
 * semantics are preserved exactly.
 *
 * Use this for every dashboard → worker proxy call. The dashboard runs
 * inside a docker container; workers may run as sibling containers
 * (`danxbot-worker-<repo>`) or as host-side processes. This wrapper makes
 * the dashboard agnostic to which mode is currently active and switches
 * without config changes.
 *
 * On total reachability failure (every candidate fails the TCP probe),
 * sends a 502 with a clear message and resolves. On real-request connect
 * error after a successful probe, evicts the cache so the next request
 * re-resolves.
 */
export async function proxyToWorkerWithFallback(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: {
    repoName: string;
    primaryHost: string;
    port: number;
    path: string;
    method: string;
  },
  body: string | null,
): Promise<void> {
  const reachableHost = await resolveReachableHost(
    upstream.repoName,
    upstream.primaryHost,
    upstream.port,
  );

  if (!reachableHost) {
    sendUpstreamError(
      res,
      502,
      `Worker for repo "${upstream.repoName}" is not reachable on any candidate host (tried "${upstream.primaryHost}" and "${HOST_DOCKER_INTERNAL}")`,
    );
    return;
  }

  await proxyToWorker(
    req,
    res,
    {
      host: reachableHost,
      port: upstream.port,
      path: upstream.path,
      method: upstream.method,
    },
    body,
    {
      onConnectError: (failedHost) => {
        // Probe just succeeded but the real request failed — race or
        // transient kernel-level reset. Drop the cache so the next
        // request goes through the full probe loop fresh.
        if (cachedWorkerHost.get(upstream.repoName)?.host === failedHost) {
          cachedWorkerHost.delete(upstream.repoName);
        }
      },
    },
  );
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

  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: repo.name,
      primaryHost: deps.resolveHost(repo.name),
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
  params: {
    method: string;
    pathTemplate: string;
    jobId: string;
    repoName: string | null;
  },
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

  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: repo.name,
      primaryHost: deps.resolveHost(repo.name),
      port: repo.workerPort as number,
      path: params.pathTemplate.replace(
        ":jobId",
        encodeURIComponent(params.jobId),
      ),
      method: params.method,
    },
    body,
  );
}
