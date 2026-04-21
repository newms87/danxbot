import type { IncomingMessage, ServerResponse } from "http";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config.js";
import { json, parseBody } from "../http/helpers.js";
import {
  cancelJob,
  getJobStatus,
  type AgentJob,
} from "../agent/launcher.js";
import { McpResolveError } from "../agent/mcp-types.js";
import { dispatch, getActiveJob } from "../dispatch/core.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import {
  deriveSessionDir,
  findSessionFileByDispatchId,
} from "../agent/session-log-watcher.js";
import { getReposBase } from "../poller/constants.js";
import { normalizeCallbackUrl } from "./url-normalizer.js";
import { isFeatureEnabled } from "../settings-file.js";

const log = createLogger("worker-dispatch");

export { clearJobCleanupIntervals } from "../dispatch/core.js";

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
  allowTools: string[];
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

  // allow_tools is required: deny-by-default is enforced at the API boundary.
  // Missing field → 400; malformed array → 400. Unknown servers + missing
  // env are surfaced from the resolver as McpResolveError (caught in handlers).
  const rawAllow = body.allow_tools;
  if (rawAllow === undefined || rawAllow === null) {
    json(res, 400, { error: "Missing required field: allow_tools" });
    return null;
  }
  if (!Array.isArray(rawAllow)) {
    json(res, 400, {
      error: "allow_tools must be an array of tool name strings",
    });
    return null;
  }
  for (const entry of rawAllow) {
    if (typeof entry !== "string") {
      json(res, 400, {
        error: "allow_tools entries must be strings",
      });
      return null;
    }
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
    allowTools: rawAllow as string[],
    // Object keyed by agent name — see `.claude/rules/agent-dispatch.md`.
    agents: body.agents as Record<string, Record<string, unknown>> | undefined,
    // Accept both string and number: Laravel serializes int IDs as JSON
    // numbers. Coercing to string here matches what the schema MCP server
    // env expects (SCHEMA_DEFINITION_ID is a string).
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

/**
 * Build the `DispatchInput` shape from the parsed HTTP body pieces. Shared by
 * `handleLaunch` and `handleResume` — the only fields that differ between the
 * two endpoints are `resumeSessionId` and `parentJobId`, which are passed as
 * optional extras.
 */
function buildDispatchInput(
  repo: RepoContext,
  common: CommonRequestParams,
  apiUrl: string,
  statusUrl: string | undefined,
  apiDispatchMeta: DispatchTriggerMetadata,
  extras: { resumeSessionId?: string; parentJobId?: string } = {},
): Parameters<typeof dispatch>[0] {
  return {
    repo,
    task: common.task,
    apiToken: common.apiToken,
    apiUrl,
    allowTools: common.allowTools,
    statusUrl,
    schemaDefinitionId: common.schemaDefinitionId,
    schemaRole: common.schemaRole,
    title: common.title,
    agents: common.agents,
    maxRuntimeMs: common.maxRuntimeMs,
    apiDispatchMeta,
    resumeSessionId: extras.resumeSessionId,
    parentJobId: extras.parentJobId,
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

    const { dispatchId } = await dispatch(
      buildDispatchInput(repo, common, apiUrl, statusUrl, apiDispatchMeta),
    );

    json(res, 200, { job_id: dispatchId, status: "launched" });
  } catch (err) {
    if (err instanceof McpResolveError) {
      json(res, 400, { error: err.message });
      return;
    }
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

    const { dispatchId } = await dispatch(
      buildDispatchInput(repo, common, apiUrl, statusUrl, apiDispatchMeta, {
        resumeSessionId: resolved.sessionId,
        parentJobId,
      }),
    );

    json(res, 200, {
      job_id: dispatchId,
      parent_job_id: parentJobId,
      status: "launched",
    });
  } catch (err) {
    if (err instanceof McpResolveError) {
      json(res, 400, { error: err.message });
      return;
    }
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
  const job = getActiveJob(jobId);
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
  const job = getActiveJob(jobId);
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
    const job: AgentJob | undefined = getActiveJob(jobId);
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
