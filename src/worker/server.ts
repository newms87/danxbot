/**
 * Worker HTTP server — minimal dispatch API for a single repo.
 *
 * Runs in worker mode (DANXBOT_REPO_NAME set). Provides:
 * - GET /health — liveness check (DB + Slack)
 * - POST /api/launch — dispatch an agent for this repo
 * - GET /api/status/:jobId — check job status
 * - POST /api/cancel/:jobId — cancel a running job
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { createLogger } from "../logger.js";
import { config } from "../config.js";
import { isSlackConnected, getQueueStats, getTotalQueuedCount } from "../slack/listener.js";
import { getPool } from "../db/connection.js";
import {
  launchAgent,
  cancelJob,
  getJobStatus,
  buildMcpSettings,
  type AgentJob,
} from "../agent/launcher.js";
import { spawnInTerminal, buildDispatchScript } from "../terminal.js";
import { getReposBase } from "../poller/constants.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-server");

const activeJobs = new Map<string, AgentJob>();

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const DB_PING_TIMEOUT_MS = 2000;

async function getHealthStatus(repo: RepoContext) {
  const slackConnected = isSlackConnected();

  let dbConnected = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const pool = getPool();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DB ping timeout")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([pool.query("SELECT 1"), timeoutPromise]);
    dbConnected = true;
  } catch {
    // DB unreachable or timed out
  } finally {
    if (timer) clearTimeout(timer);
  }

  const slackExpected = repo.slack.enabled;
  const allHealthy = dbConnected && (!slackExpected || slackConnected);

  return {
    status: allHealthy ? "ok" : "degraded",
    repo: repo.name,
    uptime_seconds: Math.round(process.uptime()),
    slack_connected: slackConnected,
    slack_expected: slackExpected,
    db_connected: dbConnected,
    memory_usage_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    queued_messages: getTotalQueuedCount(),
    queue_by_thread: getQueueStats(),
  };
}

export async function startWorkerServer(repo: RepoContext): Promise<void> {
  const PORT = parseInt(process.env.DANXBOT_WORKER_PORT || "5560", 10);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const method = req.method?.toUpperCase() || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");

    // Health check
    if (url.pathname === "/health") {
      const health = await getHealthStatus(repo);
      const statusCode = health.status === "ok" ? 200 : 503;
      json(res, statusCode, health);
      return;
    }

    // Launch agent
    if (method === "POST" && url.pathname === "/api/launch") {
      try {
        const body = await parseBody(req);
        const task = body.task as string;
        const agents = body.agents as Array<Record<string, unknown>> | undefined;
        const apiToken = body.api_token as string;
        const apiUrl = (body.api_url as string) || config.dispatch.defaultApiUrl;
        const statusUrl = body.status_url as string | undefined;
        const schemaDefinitionId = body.schema_definition_id as string | undefined;
        const maxRuntimeMs = body.max_runtime_ms as number | undefined;
        const schemaRole = body.schema_role as string | undefined;

        if (!task || !apiToken) {
          json(res, 400, { error: "Missing required fields: task, api_token" });
          return;
        }

        // repo field is optional on the worker — defaults to this worker's repo.
        // If provided, it must match this worker's repo.
        const requestedRepo = body.repo as string | undefined;
        if (requestedRepo && requestedRepo !== repo.name) {
          json(res, 400, { error: `This worker manages "${repo.name}", not "${requestedRepo}"` });
          return;
        }

        const launchOptions = {
          task,
          agents,
          apiToken,
          apiUrl,
          statusUrl,
          schemaDefinitionId,
          schemaRole,
          timeout: config.dispatch.agentTimeoutMs,
          maxRuntimeMs,
          repoName: repo.name,
        };

        if (config.isHost) {
          const jobId = randomUUID();
          const settingsDir = buildMcpSettings(launchOptions);

          const promptFile = join(settingsDir, "prompt.md");
          writeFileSync(promptFile, task);

          let agentsFile: string | undefined;
          if (agents && agents.length > 0) {
            agentsFile = join(settingsDir, "agents.json");
            writeFileSync(agentsFile, JSON.stringify(agents));
          }

          const logDir = join(config.logsDir, jobId);
          try {
            mkdirSync(logDir, { recursive: true });
            writeFileSync(join(logDir, "prompt.md"), task);
          } catch (e) {
            log.warn("Failed to write dispatch debug log:", e);
          }

          const scriptPath = buildDispatchScript(settingsDir, {
            promptFile,
            mcpConfigPath: join(settingsDir, "settings.json"),
            agentsFile,
            statusUrl,
            apiToken,
          });

          const agentCwd = join(getReposBase(), repo.name);

          spawnInTerminal({
            title: `Schema Agent ${jobId.substring(0, 8)}`,
            script: scriptPath,
            cwd: agentCwd,
          });

          json(res, 200, { job_id: jobId, status: "launched" });
        } else {
          const job = await launchAgent(launchOptions);
          activeJobs.set(job.id, job);

          const cleanupInterval = setInterval(() => {
            if (job.status !== "running" && Date.now() - (job.completedAt?.getTime() || 0) > 3600000) {
              activeJobs.delete(job.id);
              clearInterval(cleanupInterval);
            }
          }, 60000);

          json(res, 200, { job_id: job.id, status: "launched" });
        }
      } catch (err) {
        log.error("Launch failed", err);
        json(res, 500, { error: err instanceof Error ? err.message : "Launch failed" });
      }
      return;
    }

    // Cancel job
    const cancelMatch = url.pathname.match(/^\/api\/cancel\/(.+)$/);
    if (method === "POST" && cancelMatch) {
      const jobId = cancelMatch[1];
      const job = activeJobs.get(jobId);
      if (!job) { json(res, 404, { error: "Job not found" }); return; }
      if (job.status !== "running") { json(res, 409, { error: `Job is not running (status: ${job.status})` }); return; }
      const body = await parseBody(req);
      await cancelJob(job, (body.api_token as string) || "");
      json(res, 200, { status: "canceled" });
      return;
    }

    // Job status
    const statusMatch = url.pathname.match(/^\/api\/status\/(.+)$/);
    if (method === "GET" && statusMatch) {
      const jobId = statusMatch[1];
      const job = activeJobs.get(jobId);
      if (!job) { json(res, 404, { error: "Job not found" }); return; }
      json(res, 200, getJobStatus(job));
      return;
    }

    json(res, 404, { error: "Not found" });
  });

  server.listen(PORT, () => {
    log.info(`Worker server for "${repo.name}" running at http://localhost:${PORT}`);
  });
}
