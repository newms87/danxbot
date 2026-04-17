import { createServer } from "http";
import { readFile, access } from "fs/promises";
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

const log = createLogger("dashboard");

const PORT = parseInt(process.env.DASHBOARD_PORT || "5555", 10);

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

// Resolve dashboard dist directory (relative to project root, works with tsx)
const distDir = new URL("../../dashboard/dist", import.meta.url);

export async function startDashboard(): Promise<void> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/health") {
      const health = await getHealthStatus();
      const statusCode = health.status === "ok" ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    if (url.pathname === "/api/repos") {
      // Dashboard reads repo names from REPOS env var (parsed at startup).
      // Per-repo details (Slack, DB) are not available in dashboard mode.
      json(res, 200, repos.map((r) => ({
        name: r.name,
        url: r.url,
      })));
      return;
    }

    if (url.pathname === "/api/dispatches") {
      await handleListDispatches(res, url.searchParams);
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)$/);
    if (detailMatch) {
      await handleGetDispatch(res, detailMatch[1]);
      return;
    }

    const rawMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)\/raw$/);
    if (rawMatch) {
      await handleRawJsonl(res, rawMatch[1]);
      return;
    }

    const followMatch = url.pathname.match(
      /^\/api\/dispatches\/([^/]+)\/follow$/,
    );
    if (followMatch) {
      await handleFollowDispatch(req, res, followMatch[1]);
      return;
    }

    // Serve static assets from dashboard/dist/
    if (url.pathname.startsWith("/assets/")) {
      const filePath = new URL("." + url.pathname, distDir + "/");
      try {
        await access(filePath);
        const content = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": getMimeType(url.pathname),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(content);
        return;
      } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    // SPA fallback: serve index.html for all non-API routes
    const indexPath = new URL("./index.html", distDir + "/");
    try {
      const html = await readFile(indexPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Dashboard not built. Run: cd dashboard && npm run build");
    }
  });

  server.listen(PORT, () => {
    log.info(`Dashboard running at http://localhost:${PORT}`);
  });
}
