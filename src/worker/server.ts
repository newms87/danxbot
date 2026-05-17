/**
 * Worker HTTP server — thin routing layer for a single repo.
 *
 * Runs in worker mode (DANXBOT_REPO_NAME set). Routes:
 * - GET /health — liveness check (DB + Slack)
 * - POST /api/launch — dispatch an agent for this repo
 * - POST /api/resume — resume a prior dispatch's Claude session (--resume)
 * - POST /api/flesh-out — async card flesh-out (DX-349)
 * - POST /api/triage — operator-directed triage dispatch (DX-515)
 * - POST /api/chat — per-card chat session (DX-351 — fresh OR resume per
 *   the chat-sessions record at <repoRoot>/.danxbot/chat-sessions/<id>.json)
 * - GET /api/status/:jobId — check job status
 * - POST /api/cancel/:jobId — cancel a running job
 * - POST /api/stop/:jobId — agent self-stop (lifecycle tool callback)
 * - POST /api/restage/:dispatchId — Phase 5c (gpt-manager ISS-102):
 *   regenerate staged files mid-dispatch when an external writer
 *   mutates a row materialized into the agent's workspace.
 * - POST /api/template-build — DX-539 Phase 1 of Vue SPA build feature.
 *   Synchronous build endpoint: accepts presigned S3 URLs for source +
 *   dist, runs vite build inside a scratch dir, uploads dist.
 * - GET /api/template-build/recent — last 100 build outcomes (debug).
 */

import { createServer, type Server } from "http";
import { createLogger } from "../logger.js";
import { reportSystemError } from "../system-repair/report.js";
import { json } from "../http/helpers.js";
import { getHealthStatus } from "./health.js";
import {
  handleLaunch,
  handleResume,
  handleFleshOut,
  handleTriage,
  handleChat,
  handleCancel,
  handleListJobs,
  handleStatus,
  handleStop,
  handleSlackReply,
  handleSlackUpdate,
} from "./dispatch.js";
import { handleClearCriticalFailure } from "./critical-failure-route.js";
import { handleIssueCreate } from "./issue-route.js";
import {
  handleWorktreeBootstrap,
  handleWorktreeTeardown,
} from "./agents-route.js";
import { loadDispatchToken } from "../dashboard/dispatch-proxy.js";
import { handleRestart } from "./restart-route.js";
import { handleRestage } from "./restage-route.js";
import { handlePrepVerdict } from "./prep-verdict-route.js";
import { handleEvaluatorSummary } from "./evaluator-summary-route.js";
import { handleReRunEvaluator } from "./re-run-evaluator-route.js";
import { handleClearBroken } from "./clear-broken-route.js";
import { handleSyncRootRetry } from "./sync-root-route.js";
import {
  handleTemplateBuild,
  handleRecentBuilds,
} from "../template-build/handler.js";
import { handleTemplateHmrActive } from "./template-hmr-route.js";
import { shutdownAllHmr } from "../template-hmr/index.js";
import { seedCooldownFromDb } from "./restart.js";
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

    if (method === "POST" && url.pathname === "/api/flesh-out") {
      await handleFleshOut(req, res, repo);
      return;
    }

    if (method === "POST" && url.pathname === "/api/triage") {
      await handleTriage(req, res, repo);
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      await handleChat(req, res, repo);
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

    const issueCreateMatch = url.pathname.match(/^\/api\/issue-create\/(.+)$/);
    if (method === "POST" && issueCreateMatch) {
      await handleIssueCreate(req, res, issueCreateMatch[1], repo);
      return;
    }

    const restartMatch = url.pathname.match(/^\/api\/restart\/(.+)$/);
    if (method === "POST" && restartMatch) {
      await handleRestart(req, res, restartMatch[1], repo);
      return;
    }

    const restageMatch = url.pathname.match(/^\/api\/restage\/(.+)$/);
    if (method === "POST" && restageMatch) {
      await handleRestage(req, res, restageMatch[1]);
      return;
    }

    const prepVerdictMatch = url.pathname.match(/^\/api\/prep-verdict\/(.+)$/);
    if (method === "POST" && prepVerdictMatch) {
      await handlePrepVerdict(req, res, prepVerdictMatch[1], repo);
      return;
    }

    const evaluatorSummaryMatch = url.pathname.match(
      /^\/api\/evaluator-summary\/(.+)$/,
    );
    if (method === "POST" && evaluatorSummaryMatch) {
      await handleEvaluatorSummary(
        req,
        res,
        evaluatorSummaryMatch[1],
        repo,
      );
      return;
    }

    if (method === "POST" && url.pathname === "/api/re-run-evaluator") {
      await handleReRunEvaluator(req, res, repo);
      return;
    }

    if (method === "POST" && url.pathname === "/api/sync-root") {
      await handleSyncRootRetry(req, res, repo);
      return;
    }

    if (method === "POST" && url.pathname === "/api/clear-broken") {
      await handleClearBroken(req, res, repo);
      return;
    }

    if (method === "POST" && url.pathname === "/api/template-build") {
      await handleTemplateBuild(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/api/template-build/recent") {
      handleRecentBuilds(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/api/template-hmr/active") {
      handleTemplateHmrActive(req, res);
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

    // Per-agent worktree provisioning. Dashboard delegates here via
    // `RemoteWorktreeManager` because the dashboard container is on
    // `danxbot-net` only and cannot reach consumer-repo DB / redis
    // by Docker DNS, while the worker IS joined to the consumer's
    // sail network.
    if (method === "POST" && url.pathname === "/api/worktree-bootstrap") {
      await handleWorktreeBootstrap(req, res, repo, loadDispatchToken());
      return;
    }
    const teardownMatch = url.pathname.match(
      /^\/api\/worktree-bootstrap\/([^/]+)$/,
    );
    if (method === "DELETE" && teardownMatch) {
      await handleWorktreeTeardown(
        req,
        res,
        repo,
        teardownMatch[1],
        loadDispatchToken(),
      );
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

  // Seed the restart-cooldown map from the worker_restarts table so a
  // fast restart-then-restart-again across a worker boundary still
  // hits the cooldown. Best-effort — log + continue if the table
  // doesn't exist yet (pre-migration boot).
  try {
    await seedCooldownFromDb(repo.name);
  } catch (err) {
    log.warn(
      `Failed to seed restart cooldown for "${repo.name}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    void reportSystemError({
      repo: repo.name,
      component: "worker-boot",
      err,
    });
  }

  return server;
}
