import type { IncomingMessage, ServerResponse } from "http";
import { config } from "../config.js";
import { json, parseBody } from "../http/helpers.js";
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
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-dispatch");

const activeJobs = new Map<string, AgentJob>();

/** Set of per-job cleanup intervals — cleared on shutdown. */
const jobCleanupIntervals = new Set<NodeJS.Timeout>();

/** Clear all tracked job cleanup intervals. Call during shutdown. */
export function clearJobCleanupIntervals(): void {
  for (const interval of jobCleanupIntervals) {
    clearInterval(interval);
  }
  jobCleanupIntervals.clear();
}

export async function handleLaunch(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
): Promise<void> {
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
          jobCleanupIntervals.delete(cleanupInterval);
        }
      }, 60000);
      jobCleanupIntervals.add(cleanupInterval);

      json(res, 200, { job_id: job.id, status: "launched" });
    }
  } catch (err) {
    log.error("Launch failed", err);
    json(res, 500, { error: err instanceof Error ? err.message : "Launch failed" });
  }
}

export async function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const job = activeJobs.get(jobId);
  if (!job) { json(res, 404, { error: "Job not found" }); return; }
  if (job.status !== "running") { json(res, 409, { error: `Job is not running (status: ${job.status})` }); return; }
  const body = await parseBody(req);
  await cancelJob(job, (body.api_token as string) || "");
  json(res, 200, { status: "canceled" });
}

export function handleStatus(res: ServerResponse, jobId: string): void {
  const job = activeJobs.get(jobId);
  if (!job) { json(res, 404, { error: "Job not found" }); return; }
  json(res, 200, getJobStatus(job));
}
