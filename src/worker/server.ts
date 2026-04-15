/**
 * Worker HTTP server — thin routing layer for a single repo.
 *
 * Runs in worker mode (DANXBOT_REPO_NAME set). Routes:
 * - GET /health — liveness check (DB + Slack)
 * - POST /api/launch — dispatch an agent for this repo
 * - GET /api/status/:jobId — check job status
 * - POST /api/cancel/:jobId — cancel a running job
 */

import { createServer } from "http";
import { createLogger } from "../logger.js";
import { json } from "../http/helpers.js";
import { getHealthStatus } from "./health.js";
import { handleLaunch, handleCancel, handleStatus } from "./dispatch.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-server");

export async function startWorkerServer(repo: RepoContext): Promise<void> {
  const PORT = parseInt(process.env.DANXBOT_WORKER_PORT || "5560", 10);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const method = req.method?.toUpperCase() || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/health") {
      const health = await getHealthStatus(repo);
      const statusCode = health.status === "ok" ? 200 : 503;
      json(res, statusCode, health);
      return;
    }

    if (method === "POST" && url.pathname === "/api/launch") {
      await handleLaunch(req, res, repo);
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/cancel\/(.+)$/);
    if (method === "POST" && cancelMatch) {
      await handleCancel(req, res, cancelMatch[1]);
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/status\/(.+)$/);
    if (method === "GET" && statusMatch) {
      handleStatus(res, statusMatch[1]);
      return;
    }

    json(res, 404, { error: "Not found" });
  });

  server.listen(PORT, () => {
    log.info(`Worker server for "${repo.name}" running at http://localhost:${PORT}`);
  });
}
