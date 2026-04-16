import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { json, parseBody } from "../http/helpers.js";
import {
  spawnAgent,
  cancelJob,
  getJobStatus,
  buildMcpSettings,
  cleanupMcpSettings,
  buildCompletionInstruction,
  type AgentJob,
  type McpSettingsOptions,
} from "../agent/launcher.js";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import { TerminalOutputWatcher } from "../agent/terminal-output-watcher.js";
import { StallDetector } from "../agent/stall-detector.js";

/** Maximum number of stall-recovery respawns before giving up and marking failed. */
const MAX_STALL_RESUMES = 3;

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

    // Stable ID returned to the caller — persists across stall-recovery respawns.
    const dispatchId = randomUUID();
    const workerPort = parseInt(process.env.DANXBOT_WORKER_PORT ?? "5560", 10);
    const workerStopUrl = `http://localhost:${workerPort}/api/stop/${dispatchId}`;

    const mcpOptions: McpSettingsOptions = {
      apiToken,
      apiUrl,
      schemaDefinitionId,
      schemaRole,
      // Always inject the danxbot_complete tool so agents can signal completion.
      danxbotStopUrl: workerStopUrl,
    };

    // Append completion instruction to every dispatched task.
    const taskWithInstruction = task + buildCompletionInstruction();

    let resumeCount = 0;

    /**
     * Spawn a new agent for this dispatch slot.
     * On initial spawn: uses the stable dispatchId.
     * On respawn: generates a fresh internal UUID for JSONL disambiguation,
     * but keeps dispatchId as the activeJobs key.
     */
    async function spawnForDispatch(
      prompt: string,
      isRespawn: boolean,
    ): Promise<AgentJob> {
      const jobId = isRespawn ? randomUUID() : dispatchId;
      const settingsDir = buildMcpSettings(mcpOptions);

      let job: AgentJob;
      try {
        job = await spawnAgent({
          jobId,
          prompt,
          repoName: repo.name,
          timeoutMs: config.dispatch.agentTimeoutMs,
          mcpConfigPath: join(settingsDir, "settings.json"),
          agents,
          statusUrl,
          apiToken,
          maxRuntimeMs,
          eventForwarding: statusUrl ? { statusUrl, apiToken } : undefined,
          openTerminal: config.isHost,
          onComplete: () => {
            cleanupMcpSettings(settingsDir);
          },
        });
      } catch (spawnErr) {
        cleanupMcpSettings(settingsDir);
        throw spawnErr;
      }

      // Always index under the stable dispatchId so callers can still poll.
      activeJobs.set(dispatchId, job);
      return job;
    }

    /**
     * Wire stall detection for a job. When a stall fires:
     * - If resumeCount < MAX_STALL_RESUMES: kill + respawn with nudge prompt.
     * - Otherwise: mark job as failed.
     */
    function setupStallDetection(job: AgentJob): void {
      if (!config.isHost || !statusUrl || !job.watcher || !job.terminalLogPath) return;

      const termWatcher = new TerminalOutputWatcher(job.terminalLogPath);
      const stallDetector = new StallDetector({
        watcher: job.watcher,
        terminalWatcher: termWatcher,
        maxNudges: 1, // Each detector fires once; resumeCount tracks the total.
        onStall: async () => {
          resumeCount++;
          const currentJob = activeJobs.get(dispatchId);
          if (!currentJob || currentJob.status !== "running") return;

          termWatcher.stop();
          stallDetector.stop();

          if (resumeCount >= MAX_STALL_RESUMES) {
            log.warn(
              `[Dispatch ${dispatchId}] Max stall resumes (${MAX_STALL_RESUMES}) reached — marking job failed`,
            );
            await currentJob.stop?.("failed", "Agent stalled repeatedly and did not recover");
            return;
          }

          log.warn(
            `[Dispatch ${dispatchId}] Stall detected (resume ${resumeCount}/${MAX_STALL_RESUMES}) — killing and resuming`,
          );

          // Kill stalled process — stop() sends SIGTERM + SIGKILL + fires onComplete.
          // We don't await it since we want to spawn immediately after kill.
          if (currentJob.status === "running" && currentJob.process) {
            currentJob.process.kill("SIGTERM");
            await new Promise<void>((r) => setTimeout(r, 5_000));
            if (currentJob.status === "running" && currentJob.process) {
              currentJob.process.kill("SIGKILL");
            }
          }

          // Use the original task (not taskWithInstruction) as the base so the
          // completion instruction appears exactly once, followed by the stall note.
          const nudgePrompt =
            task +
            buildCompletionInstruction() +
            `\n\n---\nNOTE: Your previous session appeared to stall after receiving ` +
            `a tool result (resume ${resumeCount}/${MAX_STALL_RESUMES}). ` +
            `Continue your work from where it was left off.`;

          try {
            const newJob = await spawnForDispatch(nudgePrompt, true);
            setupStallDetection(newJob);
          } catch (err) {
            log.error(`[Dispatch ${dispatchId}] Failed to respawn after stall:`, err);
          }
        },
      });

      termWatcher.start();
      stallDetector.start();

      // Tear down when the job completes.
      const originalCleanup = job._cleanup;
      job._cleanup = () => {
        termWatcher.stop();
        stallDetector.stop();
        originalCleanup?.();
      };
    }

    const job = await spawnForDispatch(taskWithInstruction, false);
    setupStallDetection(job);

    const cleanupInterval = setInterval(() => {
      const currentJob = activeJobs.get(dispatchId);
      if (
        currentJob &&
        currentJob.status !== "running" &&
        Date.now() - (currentJob.completedAt?.getTime() ?? 0) > 3_600_000
      ) {
        activeJobs.delete(dispatchId);
        clearInterval(cleanupInterval);
        jobCleanupIntervals.delete(cleanupInterval);
      }
    }, 60_000);
    jobCleanupIntervals.add(cleanupInterval);

    json(res, 200, { job_id: dispatchId, status: "launched" });
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

export async function handleStop(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  try {
    const job = activeJobs.get(jobId);
    if (!job) { json(res, 404, { error: "Job not found" }); return; }
    if (job.status !== "running") { json(res, 409, { error: `Job is not running (status: ${job.status})` }); return; }
    if (!job.stop) { json(res, 500, { error: "Job does not support agent-initiated stop" }); return; }

    const body = await parseBody(req);
    const status = (body.status as string) === "failed" ? "failed" : "completed";
    const summary = body.summary as string | undefined;

    await job.stop(status, summary);
    json(res, 200, { status });
  } catch (err) {
    log.error("Stop failed", err);
    json(res, 500, { error: err instanceof Error ? err.message : "Stop failed" });
  }
}
