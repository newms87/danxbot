import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config.js";
import { json, parseBody } from "../http/helpers.js";
import {
  spawnAgent,
  cancelJob,
  getJobStatus,
  buildMcpSettings,
  cleanupMcpSettings,
  buildCompletionInstruction,
  terminateWithGrace,
  type AgentJob,
  type McpSettingsOptions,
} from "../agent/launcher.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import { updateDispatch } from "../dashboard/dispatches-db.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import { TerminalOutputWatcher } from "../agent/terminal-output-watcher.js";
import { StallDetector } from "../agent/stall-detector.js";
import {
  deriveSessionDir,
  findSessionFileByDispatchId,
} from "../agent/session-log-watcher.js";
import { getReposBase } from "../poller/constants.js";
import { normalizeCallbackUrl } from "./url-normalizer.js";
import { isFeatureEnabled } from "../settings-file.js";

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

/**
 * Shared inputs parsed from `POST /api/launch` and `POST /api/resume`. Both
 * endpoints share the full dispatch-slot machinery (spawn, stall recovery,
 * heartbeat, activeJobs registration) — only the source of the prompt and
 * the presence of a parent session differ.
 */
interface DispatchSlotInputs {
  task: string;
  apiToken: string;
  apiUrl: string;
  statusUrl?: string;
  schemaDefinitionId?: string;
  schemaRole?: string;
  title?: string;
  agents?: Record<string, Record<string, unknown>>;
  maxRuntimeMs?: number;
  /** Dispatch metadata persisted on the new row. */
  apiDispatchMeta: DispatchTriggerMetadata;
  /** Claude session UUID to resume. Undefined for fresh launches. */
  resumeSessionId?: string;
  /** Parent dispatch ID. Present when this slot is a resume child. */
  parentJobId?: string;
}

/**
 * Owns the dispatch-slot lifecycle: initial spawn + stall-recovery respawns
 * under the same `dispatchId` + activeJobs registration + TTL-based eviction.
 *
 * Runs identically for launches and resumes — the only differences are
 * `inputs.resumeSessionId` (appended to the claude invocation via
 * `spawnAgent`) and `inputs.parentJobId` (persisted on the dispatch row).
 */
async function runDispatchSlot(
  repo: RepoContext,
  inputs: DispatchSlotInputs,
): Promise<{ dispatchId: string; job: AgentJob }> {
  const dispatchId = randomUUID();
  const workerStopUrl = `http://localhost:${repo.workerPort}/api/stop/${dispatchId}`;

  const mcpOptions: McpSettingsOptions = {
    apiToken: inputs.apiToken,
    apiUrl: inputs.apiUrl,
    schemaDefinitionId: inputs.schemaDefinitionId,
    schemaRole: inputs.schemaRole,
    // Always inject the danxbot_complete tool so agents can signal completion.
    danxbotStopUrl: workerStopUrl,
  };

  // Append completion instruction to every dispatched task.
  const taskWithInstruction = inputs.task + buildCompletionInstruction();

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
        title: inputs.title,
        repoName: repo.name,
        timeoutMs: config.dispatch.agentTimeoutMs,
        mcpConfigPath: join(settingsDir, "settings.json"),
        agents: inputs.agents,
        statusUrl: inputs.statusUrl,
        apiToken: inputs.apiToken,
        maxRuntimeMs: inputs.maxRuntimeMs,
        eventForwarding: inputs.statusUrl
          ? { statusUrl: inputs.statusUrl, apiToken: inputs.apiToken }
          : undefined,
        openTerminal: config.isHost,
        // Only the initial spawn records the dispatch row — stall-recovery
        // respawns reuse the same dispatchId in `activeJobs` and should
        // NOT create a second row for the same conceptual run.
        dispatch: isRespawn ? undefined : inputs.apiDispatchMeta,
        resumeSessionId: inputs.resumeSessionId,
        parentJobId: inputs.parentJobId,
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
    if (
      !config.isHost ||
      !inputs.statusUrl ||
      !job.watcher ||
      !job.terminalLogPath
    )
      return;

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
          await currentJob.stop?.(
            "failed",
            "Agent stalled repeatedly and did not recover",
          );
          return;
        }

        log.warn(
          `[Dispatch ${dispatchId}] Stall detected (resume ${resumeCount}/${MAX_STALL_RESUMES}) — killing and resuming`,
        );

        // Reflect the nudge count on the dispatch row. The row was created
        // by the initial spawn's tracker; later respawns reuse the same
        // dispatchId, so we update by id directly rather than chasing the
        // tracker reference through respawns.
        updateDispatch(dispatchId, { nudgeCount: resumeCount }).catch((err) =>
          log.error(
            `[Dispatch ${dispatchId}] Failed to record nudge count`,
            err,
          ),
        );

        // Kill stalled process directly (no job.stop — we want to keep the
        // slot "running" from the caller's perspective while we respawn, so
        // we can't mark the job completed/failed here). `terminateWithGrace`
        // is the shared SIGTERM/5s/SIGKILL helper; it routes through
        // killAgentProcess so docker (ChildProcess) and host (tracked PID)
        // both work — see `.claude/rules/agent-dispatch.md`.
        await terminateWithGrace(currentJob, 5_000);

        // Use the original task (not taskWithInstruction) as the base so the
        // completion instruction appears exactly once, followed by the stall note.
        const nudgePrompt =
          inputs.task +
          buildCompletionInstruction() +
          `\n\n---\nNOTE: Your previous session appeared to stall after receiving ` +
          `a tool result (resume ${resumeCount}/${MAX_STALL_RESUMES}). ` +
          `Continue your work from where it was left off.`;

        try {
          const newJob = await spawnForDispatch(nudgePrompt, true);
          setupStallDetection(newJob);
        } catch (err) {
          log.error(
            `[Dispatch ${dispatchId}] Failed to respawn after stall:`,
            err,
          );
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

  return { dispatchId, job };
}

/**
 * Shared header parsing: derives the caller IP, normalized api/status URLs.
 * Used by both launch and resume.
 */
interface ParsedRequestShared {
  apiUrl: string;
  statusUrl: string | undefined;
  callerIp: string | null;
}

function parseSharedRequestFields(
  req: IncomingMessage,
  body: Record<string, unknown>,
): ParsedRequestShared {
  // Dispatchers (e.g., GPT Manager) send callback URLs from the host's
  // perspective — `http://localhost:80/...`. In docker runtime those resolve
  // to the worker container itself and the callback fails. Rewrite to the
  // docker-host alias here so the rest of the pipeline is runtime-agnostic.
  // Normalize AFTER the defaultApiUrl fallback so the default (also a
  // loopback URL) gets rewritten in docker runtime too.
  const rawApiUrl =
    (body.api_url as string | undefined) ?? config.dispatch.defaultApiUrl;
  const apiUrl = normalizeCallbackUrl(rawApiUrl, config.isHost) as string;
  const statusUrl = normalizeCallbackUrl(
    body.status_url as string | undefined,
    config.isHost,
  );
  const callerIp =
    (req.socket?.remoteAddress ?? req.headers["x-forwarded-for"])?.toString() ??
    null;
  return { apiUrl, statusUrl, callerIp };
}

/** Result of resolving a parent dispatch's Claude session UUID on disk. */
export type ResolveParentResult =
  | { kind: "found"; sessionId: string }
  | { kind: "not-found" } // Directory exists, no JSONL contains the tag
  | { kind: "no-session-dir" }; // `~/.claude/projects/<cwd>/` does not exist

/**
 * Resolve the parent dispatch's Claude session UUID by scanning the JSONL
 * directory for the parent's dispatch tag. Works after worker restarts because
 * the tag lives in the file content, not in `activeJobs` memory.
 *
 * Distinguishes three outcomes so the caller can map them to the right HTTP
 * status. A missing session dir is an infrastructure problem (claude never
 * ran in this cwd); a missing tag is a user error (wrong parent id). Per
 * `.claude/rules/code-quality.md` "fallbacks are bugs" — don't collapse these
 * two failure modes into a single 404.
 */
export async function resolveParentSessionId(
  repoName: string,
  parentJobId: string,
): Promise<ResolveParentResult> {
  const sessionDir = deriveSessionDir(join(getReposBase(), repoName));
  try {
    const s = await stat(sessionDir);
    if (!s.isDirectory()) {
      return { kind: "no-session-dir" };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "no-session-dir" };
    }
    throw err;
  }

  const filePath = await findSessionFileByDispatchId(sessionDir, parentJobId);
  if (!filePath) return { kind: "not-found" };
  return { kind: "found", sessionId: basename(filePath, ".jsonl") };
}

/**
 * Reject empty strings (including whitespace-only) and non-string values.
 * Caller-supplied fields land in handleLaunch/handleResume as `unknown` and
 * must be type-checked before we trust them downstream — relying on
 * `if (!value)` truthiness lets `task: 123` or `task: "   "` through.
 */
function requireString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

/**
 * Shared fields both `/api/launch` and `/api/resume` consume. Keeps the
 * handler bodies focused on endpoint-specific concerns (launch: fresh task;
 * resume: parent jobId + session resolution).
 */
interface CommonRequestParams {
  apiToken: string;
  agents: Record<string, Record<string, unknown>> | undefined;
  schemaDefinitionId: string | undefined;
  schemaRole: string | undefined;
  maxRuntimeMs: number | undefined;
  title: string | undefined;
  task: string;
}

/**
 * Parse + validate the shared fields from a launch/resume body. Writes the
 * appropriate 400 to `res` and returns null on failure; returns the parsed
 * params on success. The endpoint-specific fields (`job_id` for resume) are
 * validated separately by each handler.
 */
function parseCommonRequestParams(
  body: Record<string, unknown>,
  res: ServerResponse,
  repo: RepoContext,
): CommonRequestParams | null {
  const task = requireString(body.task);
  const apiToken = requireString(body.api_token);
  if (!task || !apiToken) {
    json(res, 400, { error: "Missing required fields: task, api_token" });
    return null;
  }

  const requestedRepo = typeof body.repo === "string" ? body.repo : undefined;
  if (requestedRepo && requestedRepo !== repo.name) {
    json(res, 400, {
      error: `This worker manages "${repo.name}", not "${requestedRepo}"`,
    });
    return null;
  }

  return {
    task,
    apiToken,
    // Object keyed by agent name — see `.claude/rules/agent-dispatch.md`.
    agents: body.agents as Record<string, Record<string, unknown>> | undefined,
    // Accept both string and number: Laravel serializes int IDs as JSON
    // numbers. Coercing to string here matches what buildMcpSettings does
    // downstream and keeps the MCP server's SCHEMA_DEFINITION_ID env as a
    // string. A string-only check silently dropped the field for numeric
    // payloads, which caused the schema MCP server to exit on startup
    // with "SCHEMA_DEFINITION_ID is required".
    schemaDefinitionId:
      typeof body.schema_definition_id === "string" ||
      typeof body.schema_definition_id === "number"
        ? String(body.schema_definition_id)
        : undefined,
    schemaRole:
      typeof body.schema_role === "string" ? body.schema_role : undefined,
    maxRuntimeMs:
      typeof body.max_runtime_ms === "number" ? body.max_runtime_ms : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
  };
}

export async function handleLaunch(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
): Promise<void> {
  try {
    // Runtime toggle — when the dispatch API is disabled for this repo
    // via the settings file, 503 before any bookkeeping. The dashboard
    // proxy forwards the status+body verbatim so external callers see
    // the same shape as an in-worker `curl`. See
    // `.claude/rules/settings-file.md`.
    if (!isFeatureEnabled(repo, "dispatchApi")) {
      json(res, 503, {
        error: `Dispatch API is disabled for repo ${repo.name}`,
      });
      return;
    }

    const body = await parseBody(req);
    const common = parseCommonRequestParams(body, res, repo);
    if (!common) return;

    const { apiUrl, statusUrl, callerIp } = parseSharedRequestFields(req, body);

    const apiDispatchMeta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp,
        statusUrl: statusUrl ?? null,
        initialPrompt: common.task,
      },
    };

    const { dispatchId } = await runDispatchSlot(repo, {
      ...common,
      apiUrl,
      statusUrl,
      apiDispatchMeta,
    });

    json(res, 200, { job_id: dispatchId, status: "launched" });
  } catch (err) {
    log.error("Launch failed", err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Launch failed",
    });
  }
}

/**
 * `POST /api/resume` — spawn a fresh dispatch that inherits a prior job's
 * Claude session via `claude --resume`. Body shape mirrors `/api/launch`
 * except the required `job_id` (parent) replaces the role of a fresh prompt
 * (the `task` here is the next user turn added on top of the prior context).
 *
 * The parent's session file is resolved on disk by scanning for its dispatch
 * tag — so resume works across worker restarts and no in-memory mapping is
 * required. The new row gets its own fresh `dispatchId`; `parent_job_id`
 * persists the lineage for queryability.
 */
export async function handleResume(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
): Promise<void> {
  try {
    if (!isFeatureEnabled(repo, "dispatchApi")) {
      json(res, 503, {
        error: `Dispatch API is disabled for repo ${repo.name}`,
      });
      return;
    }

    const body = await parseBody(req);

    // Endpoint-specific required field (whitespace + non-string rejected).
    const parentJobId = requireString(body.job_id);
    if (!parentJobId) {
      json(res, 400, {
        error: "Missing required fields: job_id, task, api_token",
      });
      return;
    }

    const common = parseCommonRequestParams(body, res, repo);
    if (!common) return;

    const resolved = await resolveParentSessionId(repo.name, parentJobId);
    switch (resolved.kind) {
      case "found":
        break;
      case "not-found":
        json(res, 404, {
          error: `Parent job "${parentJobId}" session file not found — cannot resume`,
        });
        return;
      case "no-session-dir":
        // Infrastructure: claude has never run in this repo's cwd. This is
        // NOT a caller error — don't pretend the parent is simply missing.
        json(res, 500, {
          error: `Claude session directory for repo "${repo.name}" does not exist — cannot resume`,
        });
        return;
    }

    const { apiUrl, statusUrl, callerIp } = parseSharedRequestFields(req, body);

    const apiDispatchMeta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/resume",
        callerIp,
        statusUrl: statusUrl ?? null,
        initialPrompt: common.task,
      },
    };

    const { dispatchId } = await runDispatchSlot(repo, {
      ...common,
      apiUrl,
      statusUrl,
      apiDispatchMeta,
      resumeSessionId: resolved.sessionId,
      parentJobId,
    });

    json(res, 200, {
      job_id: dispatchId,
      parent_job_id: parentJobId,
      status: "launched",
    });
  } catch (err) {
    log.error("Resume failed", err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Resume failed",
    });
  }
}

export async function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const job = activeJobs.get(jobId);
  if (!job) {
    json(res, 404, { error: "Job not found" });
    return;
  }
  if (job.status !== "running") {
    json(res, 409, { error: `Job is not running (status: ${job.status})` });
    return;
  }
  const body = await parseBody(req);
  await cancelJob(job, (body.api_token as string) || "");
  json(res, 200, { status: "canceled" });
}

export function handleStatus(res: ServerResponse, jobId: string): void {
  const job = activeJobs.get(jobId);
  if (!job) {
    json(res, 404, { error: "Job not found" });
    return;
  }
  json(res, 200, getJobStatus(job));
}

export async function handleStop(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  try {
    const job = activeJobs.get(jobId);
    if (!job) {
      json(res, 404, { error: "Job not found" });
      return;
    }
    if (job.status !== "running") {
      json(res, 409, { error: `Job is not running (status: ${job.status})` });
      return;
    }
    if (!job.stop) {
      json(res, 500, { error: "Job does not support agent-initiated stop" });
      return;
    }

    const body = await parseBody(req);
    const status =
      (body.status as string) === "failed" ? "failed" : "completed";
    const summary = body.summary as string | undefined;

    await job.stop(status, summary);
    json(res, 200, { status });
  } catch (err) {
    log.error("Stop failed", err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Stop failed",
    });
  }
}
