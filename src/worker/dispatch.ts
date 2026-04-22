import type { IncomingMessage, ServerResponse } from "http";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "../config.js";
import { json, parseBody } from "../http/helpers.js";
import {
  cancelJob,
  getJobStatus,
  type AgentJob,
} from "../agent/launcher.js";
import { McpResolveError } from "../agent/mcp-types.js";
import { dispatch, getActiveJob } from "../dispatch/core.js";
import { dispatchAllowTools } from "../dispatch/profiles.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import {
  deriveSessionDir,
  findSessionFileByDispatchId,
} from "../agent/session-log-watcher.js";
import { workspacePath } from "../workspace/generate.js";
import { normalizeCallbackUrl } from "./url-normalizer.js";
import { isFeatureEnabled } from "../settings-file.js";
import { writeFlag } from "../critical-failure.js";
import {
  isCompleteStatus,
  type CompleteStatus,
} from "../mcp/danxbot-server.js";

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
  // Must match the spawn cwd used by `spawnAgent` — dispatched agents
  // run from `<repo>/.danxbot/workspace/`, so claude writes its JSONL
  // under the workspace-encoded projects dir. Using the bare repo root
  // would look in an empty directory and return `no-session-dir` for
  // every resume. See `src/agent/launcher.ts` and the agent-isolation
  // epic (Trello `7ha2CSpc`).
  const sessionDir = deriveSessionDir(workspacePath(repoName));
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
 *
 * Returns null on both "missing" and "present but blank" — the caller maps
 * that to the 400 message below, which distinguishes the two cases in prose
 * so an operator sending `task: "   "` doesn't read "Missing" and assume
 * the field was dropped in transit.
 */
function requireString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

/**
 * Type guard: narrows `unknown` to `string[]` when every entry is a string.
 * Used by `validateAllowToolsBody` so the downstream `DispatchInput.allowTools`
 * lands without an `as string[]` cast — the narrowing here is proof.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((e) => typeof e === "string");
}

/**
 * Shared fields both `/api/launch` and `/api/resume` consume. Keeps the
 * handler bodies focused on endpoint-specific concerns (launch: fresh task;
 * resume: parent jobId + session resolution).
 */
interface CommonRequestParams {
  apiToken: string;
  allowTools: readonly string[];
  agents: Record<string, Record<string, unknown>> | undefined;
  schemaDefinitionId: string | undefined;
  schemaRole: string | undefined;
  maxRuntimeMs: number | undefined;
  title: string | undefined;
  task: string;
}

/**
 * Validate the `allow_tools` body field. Returns the narrowed `string[]` on
 * success, or null after writing the appropriate 400 to `res`. Enforces
 * deny-by-default at the API boundary: the field is required and must be an
 * array of strings.
 */
function validateAllowToolsBody(
  raw: unknown,
  res: ServerResponse,
): string[] | null {
  if (raw === undefined || raw === null) {
    json(res, 400, { error: "Missing required field: allow_tools" });
    return null;
  }
  if (!Array.isArray(raw)) {
    json(res, 400, {
      error: "allow_tools must be an array of tool name strings",
    });
    return null;
  }
  if (!isStringArray(raw)) {
    json(res, 400, { error: "allow_tools entries must be strings" });
    return null;
  }
  return raw;
}

/**
 * Validate that the body's optional `repo` field matches this worker's repo.
 * Returns true on match (or when the field is absent); writes a 400 and
 * returns false on mismatch. Extracted from `parseCommonRequestParams` so
 * that function stays purely about body-shape parsing rather than routing.
 */
function validateRepoMatch(
  body: Record<string, unknown>,
  res: ServerResponse,
  repo: RepoContext,
): boolean {
  const requestedRepo = typeof body.repo === "string" ? body.repo : undefined;
  if (requestedRepo && requestedRepo !== repo.name) {
    json(res, 400, {
      error: `This worker manages "${repo.name}", not "${requestedRepo}"`,
    });
    return false;
  }
  return true;
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
    // `requireString` treats blank strings as missing — name both cases in
    // the error so an operator who sent `task: "   "` doesn't read "Missing"
    // and assume the field was dropped in transit.
    json(res, 400, {
      error: "Missing or blank required fields: task, api_token",
    });
    return null;
  }

  const rawAllow = validateAllowToolsBody(body.allow_tools, res);
  if (!rawAllow) return null;

  if (!validateRepoMatch(body, res, repo)) return null;

  // `dispatchAllowTools` is the ONE entry point every dispatch consumer goes
  // through. It resolves the named profile (fail-loud on a typo'd literal)
  // and merges the baseline with the caller's overrides. Today the
  // `http-launch` baseline is empty so this is structurally a no-op, but the
  // plumbing is the contract — any future baseline flows through unchanged.
  // Identical shape to the poller callsite and to the Phase 5 Slack path.
  // See `src/dispatch/profiles.ts` and the agent-isolation epic (Trello
  // `7ha2CSpc`) Phase 4.
  const allowTools = dispatchAllowTools("http-launch", rawAllow);

  return {
    task,
    apiToken,
    allowTools,
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
        error: "Missing or blank required fields: job_id, task, api_token",
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

/**
 * Validate `status` on a `/api/stop/:jobId` body. Returns the parsed
 * status, or `null` after writing a 4xx to `res` (so the caller returns
 * without further work). Extracted from `handleStop` so the parsing
 * contract is a single, testable function mirror of `requireString`.
 */
function parseStopStatus(
  body: Record<string, unknown>,
  res: ServerResponse,
): CompleteStatus | null {
  const rawStatus = body.status;
  if (rawStatus === undefined || rawStatus === null) {
    // Fail-loud: the MCP tool schema marks `status` as required, so a
    // call without it is a caller bug. Silent defaulting to "completed"
    // (the old behavior) hides integration bugs and could let a stuck
    // agent's noise traffic finalize a job as success.
    json(res, 400, { error: "Missing required field: status" });
    return null;
  }
  if (!isCompleteStatus(rawStatus)) {
    json(res, 400, {
      error:
        `Invalid status "${String(rawStatus)}" — must be one of ` +
        `completed, failed, critical_failure`,
    });
    return null;
  }
  return rawStatus;
}

export async function handleStop(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  repo: RepoContext,
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
    const status = parseStopStatus(body, res);
    if (!status) return;

    const summary =
      typeof body.summary === "string" ? body.summary : undefined;

    if (status === "critical_failure") {
      // The flag file is the operator's sole source of truth for what
      // environment blocker to investigate. Require a non-empty summary
      // here so the banner has actionable content — the MCP tool schema
      // already marks summary as required, and an empty string is a
      // caller bug we'd rather surface than paper over.
      if (!summary) {
        json(res, 400, {
          error:
            'Missing required field: summary (required when status="critical_failure")',
        });
        return;
      }

      writeFlag(repo.localPath, {
        source: "agent",
        dispatchId: jobId,
        reason: "Agent-signaled critical failure",
        detail: summary,
      });

      // Deliberate asymmetry: the response advertises "critical_failure"
      // so the MCP tool surfaces a distinct outcome to the agent, while
      // `job.stop` runs the "failed" lifecycle (it only understands
      // completed/failed). The flag file on disk — not `job.status` —
      // is the authoritative halt signal for the poller. See
      // `.claude/rules/agent-dispatch.md` "Critical failure flag".
      await job.stop("failed", summary);
      json(res, 200, { status });
      return;
    }

    await job.stop(status, summary);
    json(res, 200, { status });
  } catch (err) {
    log.error("Stop failed", err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Stop failed",
    });
  }
}
