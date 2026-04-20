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
  handleFollowDispatch,
} from "./dispatches-routes.js";
import {
  handleLaunchProxy,
  handleJobProxy,
  loadDispatchToken,
  workerHost,
  type DispatchProxyDeps,
} from "./dispatch-proxy.js";
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

/**
 * The list of explicitly-known frontend page routes the SPA handles client-side.
 * The SPA does not use vue-router today (everything lives under `/`), but the
 * list is still explicit — unknown paths MUST 404 rather than silently return
 * index.html.
 */
const SPA_ROUTES: readonly string[] = ["/"] as const;

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
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";

  // Health.
  if (method === "GET" && url.pathname === "/health") {
    const health = await getHealthStatus();
    const statusCode = health.status === "ok" ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
    return true;
  }

  // Read-only dispatch API.
  if (method === "GET" && url.pathname === "/api/repos") {
    json(
      res,
      200,
      repos.map((r) => ({ name: r.name, url: r.url })),
    );
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

  const followMatch = url.pathname.match(
    /^\/api\/dispatches\/([^/]+)\/follow$/,
  );
  if (method === "GET" && followMatch) {
    await handleFollowDispatch(req, res, decodeURIComponent(followMatch[1]));
    return true;
  }

  // External dispatch proxy — auth-gated, forwards to workers.
  if (method === "POST" && url.pathname === "/api/launch") {
    await handleLaunchProxy(req, res, dispatchDeps);
    return true;
  }

  // Job-scoped proxy routes share the same request shape: method + path
  // template + jobId extracted from the URL + repo from ?repo=. Keeping
  // them in a small table eliminates three near-identical match blocks
  // and makes the route surface easy to read at a glance.
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

  // Static assets from dashboard/dist/assets/.
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

  // Known SPA page routes — serve index.html.
  if (method === "GET" && SPA_ROUTES.includes(url.pathname)) {
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

  await checkWorkerHostResolution(repos, workerHost);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      const handled = await route(req, res, url, dispatchDeps);
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
