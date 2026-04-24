import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { readFile, access } from "fs/promises";
import { lookup } from "node:dns/promises";
import { getHealthStatus } from "./health.js";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { repos } from "../config.js";
import {
  handleListDispatches,
  handleGetDispatch,
  handleRawJsonl,
} from "./dispatches-routes.js";
import { handleStream } from "./stream-routes.js";
import { startDbChangeDetector } from "./dispatch-stream.js";
import {
  handleLaunchProxy,
  handleResumeProxy,
  handleJobProxy,
  loadDispatchToken,
  workerHost,
  type DispatchProxyDeps,
} from "./dispatch-proxy.js";
import {
  handlePlaywrightProxy,
  loadPlaywrightUrl,
  type PlaywrightProxyDeps,
} from "./playwright-proxy.js";
import {
  handleClearAgentCriticalFailure,
  handleGetAgent,
  handleListAgents,
  handlePatchToggle,
} from "./agents-routes.js";
import {
  handleLogin,
  handleLogout,
  handleMe,
} from "./auth-routes.js";
import { handleAdminReset } from "./admin-routes.js";
import { requireUser } from "./auth-middleware.js";
import { optional } from "../env.js";

const log = createLogger("dashboard");

const PORT = parseInt(optional("DASHBOARD_PORT", "5555"), 10);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

const distDir = new URL("../../dashboard/dist", import.meta.url);

interface JobProxyRoute {
  method: "GET" | "POST";
  pattern: RegExp;
  pathTemplate: string;
}

/**
 * Job-scoped proxy routes forwarded to `handleJobProxy`. The route() function
 * iterates this table instead of repeating the same match/decode/forward
 * block for each of status/cancel/stop.
 */
const JOB_PROXY_ROUTES: readonly JobProxyRoute[] = [
  { method: "GET",  pattern: /^\/api\/status\/([^/]+)$/, pathTemplate: "/api/status/:jobId" },
  { method: "POST", pattern: /^\/api\/cancel\/([^/]+)$/, pathTemplate: "/api/cancel/:jobId" },
  { method: "POST", pattern: /^\/api\/stop\/([^/]+)$/,   pathTemplate: "/api/stop/:jobId" },
];

/**
 * Dispatch an incoming request. Returns true if the request was handled and
 * a response has been written. Returns false only when nothing matched —
 * the outer handler then emits 404 for any method.
 */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dispatchDeps: DispatchProxyDeps,
  playwrightDeps: PlaywrightProxyDeps,
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";

  // ── Always-open routes ──────────────────────────────────────────────
  // Health probes, login bootstrap, static assets, and the SPA shell
  // never require auth. The SPA itself decides whether to render Login
  // or the dashboard based on a subsequent /api/auth/me call.

  if (method === "GET" && url.pathname === "/health") {
    const health = await getHealthStatus();
    const statusCode = health.status === "ok" ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    await handleLogin(req, res);
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/assets/")) {
    const filePath = new URL("." + url.pathname, distDir + "/");
    try {
      await access(filePath);
      const content = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": getMimeType(url.pathname),
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(content);
      return true;
    } catch {
      json(res, 404, { error: "Not found" });
      return true;
    }
  }

  // Only GET / serves the SPA shell. Any unknown path — even other GETs —
  // must 404 so the SPA's router can't pretend to own routes it doesn't.
  if (method === "GET" && url.pathname === "/") {
    const indexPath = new URL("./index.html", distDir + "/");
    try {
      const html = await readFile(indexPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Dashboard not built. Run: cd dashboard && npm run build");
    }
    return true;
  }

  // ── Dispatch proxy — authenticates internally with DANXBOT_DISPATCH_TOKEN.
  // These routes are called by external dispatchers (gpt-manager, etc.) and
  // MUST NOT be gated by requireUser. See .claude/rules/agent-dispatch.md.

  if (method === "POST" && url.pathname === "/api/launch") {
    await handleLaunchProxy(req, res, dispatchDeps);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/resume") {
    await handleResumeProxy(req, res, dispatchDeps);
    return true;
  }

  for (const job of JOB_PROXY_ROUTES) {
    const jobMatch = url.pathname.match(job.pattern);
    if (method === job.method && jobMatch) {
      await handleJobProxy(
        req,
        res,
        {
          method: job.method,
          pathTemplate: job.pathTemplate,
          jobId: decodeURIComponent(jobMatch[1]),
          repoName: url.searchParams.get("repo"),
        },
        dispatchDeps,
      );
      return true;
    }
  }

  // ── Playwright proxy — same dispatch-token auth band as above.
  // MUST match ahead of the blanket `/api/*` user-auth gate below so
  // external callers (gpt-manager, curl) with only a bearer token aren't
  // 401'd on the session check. Any method is accepted; the tail of the
  // path (incl. query string) is forwarded to the Playwright service.
  // See `playwright-proxy.ts` for the binary-safe forwarder — do NOT
  // reroute this through `handleJobProxy` / `proxyToWorker`; those are
  // JSON-only and corrupt PNG bytes.
  if (url.pathname.startsWith("/api/playwright/")) {
    const tailPath =
      url.pathname.slice("/api/playwright".length) + url.search;
    await handlePlaywrightProxy(req, res, tailPath, playwrightDeps);
    return true;
  }

  // ── PATCH /api/agents/:repo/toggles — user bearer required.
  // The route is intentionally matched HERE, ahead of the blanket
  // `/api/*` gate below, so the handler's own `requireUser` call
  // produces the 401 (and the handler can stamp
  // `meta.updatedBy = dashboard:<username>` on success). That makes the
  // three auth bands explicit: (1) open routes (health, login, SPA),
  // (2) dispatch-proxy routes (dispatch-token auth inside the proxy),
  // (3) user-gated routes (this block + the blanket gate below).
  // `DANXBOT_DISPATCH_TOKEN` is NOT accepted here — see
  // `.claude/rules/agent-dispatch.md`.

  const agentTogglesMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/toggles$/,
  );
  if (method === "PATCH" && agentTogglesMatch) {
    await handlePatchToggle(
      req,
      res,
      decodeURIComponent(agentTogglesMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // DELETE /api/agents/:repo/critical-failure — user bearer required.
  // Matched ahead of the blanket /api/* gate so the handler's own
  // `requireUser` call produces the 401. Forwards to the worker's
  // DELETE /api/poller/critical-failure which calls clearFlag.
  const agentCriticalFailureMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/critical-failure$/,
  );
  if (method === "DELETE" && agentCriticalFailureMatch) {
    await handleClearAgentCriticalFailure(
      req,
      res,
      decodeURIComponent(agentCriticalFailureMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // User-auth gate for every remaining /api/* route. Bearer lives only in
  // the Authorization header — SSE uses fetch+ReadableStream on the client
  // so query-string tokens (which would leak into access logs) are never
  // needed.
  if (url.pathname.startsWith("/api/")) {
    const auth = await requireUser(req);
    if (!auth.ok) {
      json(res, 401, { error: "Unauthorized" });
      return true;
    }
  }

  // ── Authed user routes ──────────────────────────────────────────────

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    await handleLogout(req, res);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/auth/me") {
    await handleMe(req, res);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/repos") {
    json(
      res,
      200,
      repos.map((r) => ({ name: r.name, url: r.url })),
    );
    return true;
  }

  if (method === "GET" && url.pathname === "/api/stream") {
    await handleStream(req, res, url.searchParams);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/dispatches") {
    await handleListDispatches(res, url.searchParams);
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)$/);
  if (method === "GET" && detailMatch) {
    await handleGetDispatch(res, decodeURIComponent(detailMatch[1]));
    return true;
  }

  const rawMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)\/raw$/);
  if (method === "GET" && rawMatch) {
    await handleRawJsonl(res, decodeURIComponent(rawMatch[1]));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/agents") {
    await handleListAgents(res, dispatchDeps);
    return true;
  }

  const agentDetailMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (method === "GET" && agentDetailMatch) {
    await handleGetAgent(
      res,
      decodeURIComponent(agentDetailMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/api/admin/reset") {
    await handleAdminReset(req, res);
    return true;
  }

  return false;
}

/**
 * Verify that each repo's worker hostname resolves via DNS at startup. Logs
 * a warning for any that don't — catches the common misconfiguration where a
 * connected repo's compose `container_name` doesn't match `workerHost(name)`
 * (the source of silent 502s at proxy request time otherwise).
 *
 * Does not block startup: DNS may not be ready when the dashboard boots in
 * docker-compose ordering, and the proxy's upstream error already returns a
 * clear 502 when the hostname fails to resolve. This is a best-effort alert
 * for operators.
 */
async function checkWorkerHostResolution(
  configuredRepos: typeof repos,
  resolveHost: (name: string) => string,
): Promise<void> {
  for (const repo of configuredRepos) {
    if (!repo.workerPort) continue;
    const host = resolveHost(repo.name);
    try {
      await lookup(host);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `Worker hostname "${host}" for repo "${repo.name}" did not resolve: ${msg}. External /api/launch for this repo will 502 until the worker container is running with matching container_name.`,
      );
    }
  }
}

export async function startDashboard(): Promise<void> {
  const token = loadDispatchToken();
  if (!token) {
    log.warn(
      "DANXBOT_DISPATCH_TOKEN not set — external /api/launch proxy will reject with 500 until configured",
    );
  }

  // Build proxy deps once per dashboard process — token, repos, and the
  // worker-host resolver are all constant across requests. The handler below
  // closes over this object instead of allocating a new one per request.
  const dispatchDeps: DispatchProxyDeps = {
    token,
    repos,
    resolveHost: workerHost,
  };

  // Playwright proxy shares the DANXBOT_DISPATCH_TOKEN with dispatchDeps —
  // same bearer, different upstream. The upstream URL is resolved once at
  // boot from env (default `http://playwright:3000` on danxbot-net).
  const playwrightDeps: PlaywrightProxyDeps = {
    token,
    upstreamUrl: loadPlaywrightUrl(),
  };

  await checkWorkerHostResolution(repos, workerHost);

  // Start the DB change detector that publishes dispatch:created and
  // dispatch:updated events to the EventBus for SSE subscribers.
  startDbChangeDetector();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      const handled = await route(req, res, url, dispatchDeps, playwrightDeps);
      if (!handled) {
        json(res, 404, { error: "Not found" });
      }
    } catch (err) {
      log.error(`Unhandled error for ${req.method} ${url.pathname}`, err);
      if (!res.headersSent) {
        json(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    }
  });

  server.listen(PORT, () => {
    log.info(`Dashboard running at http://localhost:${PORT}`);
  });
}
