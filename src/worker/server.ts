/**
 * Worker HTTP server — thin routing layer for a single repo.
 *
 * Runs in worker mode (DANXBOT_REPO_NAME set). Routes:
 * - GET /health — liveness check (DB + Slack)
 * - POST /api/launch — dispatch an agent for this repo
 * - POST /api/resume — resume a prior dispatch's Claude session (--resume)
 * - GET /api/status/:jobId — check job status
 * - POST /api/cancel/:jobId — cancel a running job
 * - POST /api/stop/:jobId — agent self-stop (lifecycle tool callback)
 */

import { createServer, type Server } from "http";
import { createLogger } from "../logger.js";
import { json } from "../http/helpers.js";
import { getHealthStatus } from "./health.js";
import {
  handleLaunch,
  handleResume,
  handleCancel,
  handleListJobs,
  handleStatus,
  handleStop,
  handleSlackReply,
  handleSlackUpdate,
} from "./dispatch.js";
import { handleClearCriticalFailure } from "./critical-failure-route.js";
import {
  handleIssueCreate,
  handleIssueSave,
} from "./issue-route.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-server");

export async function startWorkerServer(repo: RepoContext): Promise<Server> {
  const PORT = repo.workerPort;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const method = req.method?.toUpperCase() || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/health") {
      const health = await getHealthStatus(repo);
      // `halted` keeps HTTP 200 so Docker health checks stay green —
      // operator-intent signal lives in the `status` field, not the
      // status code. Only `degraded` returns 503 so external monitors
      // page when the worker has infra problems, not when it's
      // intentionally paused. See `.claude/rules/agent-dispatch.md`.
      const statusCode = health.status === "degraded" ? 503 : 200;
      json(res, statusCode, health);
      return;
    }

    if (method === "POST" && url.pathname === "/api/launch") {
      await handleLaunch(req, res, repo);
      return;
    }

    if (method === "POST" && url.pathname === "/api/resume") {
      await handleResume(req, res, repo);
      return;
    }

    if (method === "GET" && url.pathname === "/api/jobs") {
      handleListJobs(res);
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/cancel\/(.+)$/);
    if (method === "POST" && cancelMatch) {
      await handleCancel(req, res, cancelMatch[1]);
      return;
    }

    const stopMatch = url.pathname.match(/^\/api\/stop\/(.+)$/);
    if (method === "POST" && stopMatch) {
      await handleStop(req, res, stopMatch[1], repo);
      return;
    }

    const slackReplyMatch = url.pathname.match(/^\/api\/slack\/reply\/(.+)$/);
    if (method === "POST" && slackReplyMatch) {
      await handleSlackReply(req, res, slackReplyMatch[1], repo);
      return;
    }

    const slackUpdateMatch = url.pathname.match(/^\/api\/slack\/update\/(.+)$/);
    if (method === "POST" && slackUpdateMatch) {
      await handleSlackUpdate(req, res, slackUpdateMatch[1], repo);
      return;
    }

    const issueSaveMatch = url.pathname.match(/^\/api\/issue-save\/(.+)$/);
    if (method === "POST" && issueSaveMatch) {
      await handleIssueSave(req, res, issueSaveMatch[1], repo);
      return;
    }

    const issueCreateMatch = url.pathname.match(/^\/api\/issue-create\/(.+)$/);
    if (method === "POST" && issueCreateMatch) {
      await handleIssueCreate(req, res, issueCreateMatch[1], repo);
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/status\/(.+)$/);
    if (method === "GET" && statusMatch) {
      handleStatus(res, statusMatch[1]);
      return;
    }

    if (
      method === "DELETE" &&
      url.pathname === "/api/poller/critical-failure"
    ) {
      await handleClearCriticalFailure(req, res, repo);
      return;
    }

    json(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      log.info(
        `Worker server for "${repo.name}" running at http://localhost:${PORT}`,
      );
      resolve();
    });
  });
  return server;
}
