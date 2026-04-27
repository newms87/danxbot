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
import { ClaudeAuthError } from "../agent/claude-auth-preflight.js";
import { ProjectsDirError } from "../agent/projects-dir-preflight.js";
import { dispatch, getActiveJob, listActiveJobs } from "../dispatch/core.js";
import {
  WorkspaceNotFoundError,
  WorkspaceFileMissingError,
  WorkspaceSettingsError,
  WorkspaceGateError,
  WorkspaceGateUnknownError,
} from "../workspace/resolve.js";
import {
  PlaceholderError,
} from "../workspace/placeholders.js";
import { WorkspaceManifestError } from "../workspace/manifest.js";
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
import { getDispatchById } from "../dashboard/dispatches-db.js";
import { getSlackClientForRepo } from "../slack/listener.js";
import type { SlackTriggerMetadata } from "../dashboard/dispatches.js";
import {
  processResponseWithAttachments,
  type SqlAttachment,
} from "./sql-executor.js";

const log = createLogger("worker-dispatch");

export { clearJobCleanupIntervals } from "../dispatch/core.js";

/**
 * Shared header parsing: derives the caller IP and the normalized status
 * callback URL (if any). Used by both launch and resume.
 *
 * Both `body.status_url` and every `body.overlay` value are run through
 * `normalizeCallbackUrl(..., config.isHost)` so localhost-bearing entries
 * (e.g. gpt-manager's `SCHEMA_API_URL: "http://localhost:80"`) get
 * rewritten to `host.docker.internal` in docker runtime. Without this,
 * every fetch the dispatched agent makes against an overlay URL inside a
 * worker container resolves to the agent's own container and fails with
 * `fetch failed`. Empirical reproducer: gpt-manager AGD-29.
 */
interface ParsedRequestShared {
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
  const statusUrl = normalizeCallbackUrl(
    body.status_url as string | undefined,
    config.isHost,
  );
  const callerIp =
    (req.socket?.remoteAddress ?? req.headers["x-forwarded-for"])?.toString() ??
    null;
  return { statusUrl, callerIp };
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
 */
function requireString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

/**
 * Body fields rejected at the boundary as part of the P5 cutover
 * (workspace-dispatch epic, card mGrHNHWM). Each field belonged to the
 * pre-workspace dispatch shape and stays rejected so a caller who held an
 * old client gets a loud 400 instead of a silently-ignored field:
 *
 *   - `schema_definition_id` / `schema_role` — gpt-manager-specific schema
 *     MCP knobs that now live in the caller's overlay (`SCHEMA_DEFINITION_ID`
 *     etc) and are declared by the caller's own workspace `.mcp.json`.
 *   - `api_url` — schema MCP base URL; same — moves to overlay.
 *   - `allow_tools` — caller-supplied tool allowlist; the allow-tools
 *     concept was retired entirely (see `src/workspace/resolve.ts` header).
 *     The workspace's `.mcp.json` (with `--strict-mcp-config`) is the
 *     agent's MCP surface; built-ins are all available by default.
 *   - `agents` — inline sub-agent JSON; replaced by the workspace's
 *     `.claude/agents/*.md` files.
 *
 * Order is the canonical detection / response order — locked so a caller
 * who grep's `offendingFields` sees a deterministic surface.
 */
const LEGACY_BODY_FIELDS = Object.freeze([
  "schema_definition_id",
  "schema_role",
  "api_url",
  "allow_tools",
  "agents",
] as const);

/**
 * Detect any legacy body fields. Returns the offending list in canonical
 * order (subset of `LEGACY_BODY_FIELDS`). Empty array means "clean — proceed
 * to workspace validation."
 */
function detectLegacyFields(body: Record<string, unknown>): string[] {
  return LEGACY_BODY_FIELDS.filter((f) => f in body);
}

/**
 * Write the canonical 400 for a legacy-shape body. The message points the
 * caller at the new API and the gpt-manager migration card so external
 * dispatchers can self-serve their migration without reading danxbot
 * source. `offendingFields` is the structured surface tests + dashboards
 * can rely on; `message` is for humans tailing logs.
 */
function rejectLegacyShape(
  res: ServerResponse,
  offendingFields: string[],
): void {
  json(res, 400, {
    error: "Legacy dispatch body shape rejected",
    message:
      "This worker accepts only {repo, workspace, task, overlay?, ...}. " +
      "The schema_*/allow_tools/agents fields are no longer supported " +
      "(allow_tools in particular was retired entirely — the workspace's " +
      "`.mcp.json` is now the agent's MCP surface). Migrate to " +
      "{workspace: '<name>', overlay: {...}} — see " +
      "https://trello.com/c/s9XdRLcz for the gpt-manager migration and " +
      "`.claude/rules/agent-dispatch.md` for the API contract.",
    offendingFields,
  });
}

/**
 * Validate that the body's optional `repo` field matches this worker's repo.
 * Returns true on match (or when the field is absent); writes a 400 and
 * returns false on mismatch.
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
 * Shape the parsed `/api/launch` or `/api/resume` body produces. The HTTP
 * handler validates the inbound JSON and either writes a 4xx + returns null,
 * or returns this struct.
 */
interface ParsedDispatchRequest {
  workspace: string;
  task: string;
  overlay: Record<string, string>;
  apiToken: string | undefined;
  statusUrl: string | undefined;
  callerIp: string | null;
  title: string | undefined;
  maxRuntimeMs: number | undefined;
}

/**
 * Validate the body's `overlay` field. Caller is opaque to danxbot — every
 * value MUST be a string (the resolver substitutes literally). A non-object
 * overlay or a non-string value is a caller bug; reject with 400 rather than
 * coercing.
 */
function validateOverlayBody(
  raw: unknown,
  res: ServerResponse,
): Record<string, string> | null {
  if (raw === undefined) return {};
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    json(res, 400, {
      error: "overlay must be an object mapping string → string",
    });
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      json(res, 400, {
        error: `overlay.${key} must be a string (got ${typeof value})`,
      });
      return null;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Parse + validate a `/api/launch` or `/api/resume` body for the new
 * `{repo, workspace, task, overlay?, ...}` shape. Writes the appropriate
 * 4xx to `res` and returns null on failure; returns a `ParsedDispatchRequest`
 * on success.
 *
 * Validation order is meaningful: legacy-field rejection FIRST so a caller
 * still on the old shape always sees the migration message (and never the
 * generic "Missing workspace"). This keeps the cutover signal loud and
 * specific.
 */
function parseDispatchRequest(
  req: IncomingMessage,
  body: Record<string, unknown>,
  res: ServerResponse,
  repo: RepoContext,
): ParsedDispatchRequest | null {
  // 1. Legacy-field rejection — fires BEFORE any other validation so a
  //    caller still on the pre-P5 shape always sees the migration message.
  const legacy = detectLegacyFields(body);
  if (legacy.length > 0) {
    rejectLegacyShape(res, legacy);
    return null;
  }

  // 2. Workspace required. No fallback / default workspace — danxbot ships
  //    only its own dispatch surfaces (`trello-worker`, `slack-worker`).
  //    External callers must declare a workspace in their target repo's
  //    `.danxbot/workspaces/`.
  const workspace = requireString(body.workspace);
  if (!workspace) {
    json(res, 400, { error: "Missing workspace" });
    return null;
  }

  // 3. Repo gate (cross-worker safety) and task non-empty.
  if (!validateRepoMatch(body, res, repo)) return null;
  const task = requireString(body.task);
  if (!task) {
    json(res, 400, { error: "Missing or blank required field: task" });
    return null;
  }

  // 4. Optional fields.
  const overlay = validateOverlayBody(body.overlay, res);
  if (!overlay) return null;
  // Same loopback rewrite as `status_url` — see `parseSharedRequestFields`
  // for the rationale. Applied to every value (the helper is a no-op for
  // non-localhost URLs and for non-URL strings, so tokens / numeric IDs
  // pass through untouched).
  const normalizedOverlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(overlay)) {
    normalizedOverlay[key] = normalizeCallbackUrl(value, config.isHost) ?? value;
  }
  const { statusUrl, callerIp } = parseSharedRequestFields(req, body);
  const apiToken =
    typeof body.api_token === "string" ? body.api_token : undefined;

  return {
    workspace,
    task,
    overlay: normalizedOverlay,
    apiToken,
    statusUrl,
    callerIp,
    title: typeof body.title === "string" ? body.title : undefined,
    maxRuntimeMs:
      typeof body.max_runtime_ms === "number" ? body.max_runtime_ms : undefined,
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
  parsed: ParsedDispatchRequest,
  apiDispatchMeta: DispatchTriggerMetadata,
  extras: { resumeSessionId?: string; parentJobId?: string } = {},
): Parameters<typeof dispatch>[0] {
  return {
    repo,
    workspace: parsed.workspace,
    overlay: parsed.overlay,
    task: parsed.task,
    apiToken: parsed.apiToken,
    statusUrl: parsed.statusUrl,
    title: parsed.title,
    maxRuntimeMs: parsed.maxRuntimeMs,
    apiDispatchMeta,
    resumeSessionId: extras.resumeSessionId,
    parentJobId: extras.parentJobId,
  };
}

/**
 * Map a workspace-resolution failure to a 400 with the resolver's own
 * message. These all signal "workspace declared by the caller does not exist
 * / is malformed / failed a gate" — caller-fixable. `WorkspaceGateUnknownError`
 * is the one outlier (the workspace itself declares an unknown gate, which
 * is a server-side bug); we 500 that one.
 */
function isWorkspaceCallerError(err: unknown): boolean {
  return (
    err instanceof WorkspaceNotFoundError ||
    err instanceof WorkspaceFileMissingError ||
    err instanceof WorkspaceManifestError ||
    err instanceof WorkspaceSettingsError ||
    err instanceof WorkspaceGateError ||
    err instanceof PlaceholderError
  );
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
    const parsed = parseDispatchRequest(req, body, res, repo);
    if (!parsed) return;

    const apiDispatchMeta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: parsed.callerIp,
        statusUrl: parsed.statusUrl ?? null,
        initialPrompt: parsed.task,
      },
    };

    const { dispatchId } = await dispatch(
      buildDispatchInput(repo, parsed, apiDispatchMeta),
    );

    json(res, 200, { job_id: dispatchId, status: "launched" });
  } catch (err) {
    if (err instanceof ClaudeAuthError) {
      // Worker-config issue, not a caller bug. 503 mirrors the
      // dispatch-disabled branch — same shape for external dispatchers.
      log.error(`Launch failed: claude-auth preflight (${err.reason})`, err);
      json(res, 503, { error: err.message });
      return;
    }
    if (err instanceof ProjectsDirError) {
      // Same severity tier as auth — worker-config issue, 503. Trello
      // cjAyJpgr-followup: the dir-perms class of broken bind that
      // produces silent dispatch timeouts.
      log.error(`Launch failed: projects-dir preflight (${err.reason})`, err);
      json(res, 503, { error: err.message });
      return;
    }
    if (err instanceof McpResolveError) {
      json(res, 400, { error: err.message });
      return;
    }
    if (err instanceof WorkspaceGateUnknownError) {
      // Server-side bug: a workspace shipped on disk declares a gate the
      // resolver doesn't know about. 500 (not 400) — fixing requires a
      // danxbot code change, not a caller change.
      log.error("Launch failed: workspace gate unknown", err);
      json(res, 500, { error: err.message });
      return;
    }
    if (isWorkspaceCallerError(err)) {
      json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
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

    // Endpoint-specific required field. Validated BEFORE legacy/workspace
    // checks so a resume body missing job_id always sees the focused error
    // (otherwise a body that's also missing workspace would surface
    // "Missing workspace" first and bury the real issue).
    const parentJobId = requireString(body.job_id);
    if (!parentJobId) {
      json(res, 400, {
        error: "Missing or blank required field: job_id",
      });
      return;
    }

    const parsed = parseDispatchRequest(req, body, res, repo);
    if (!parsed) return;

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

    const apiDispatchMeta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/resume",
        callerIp: parsed.callerIp,
        statusUrl: parsed.statusUrl ?? null,
        initialPrompt: parsed.task,
      },
    };

    const { dispatchId } = await dispatch(
      buildDispatchInput(repo, parsed, apiDispatchMeta, {
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
    if (err instanceof ClaudeAuthError) {
      log.error(`Resume failed: claude-auth preflight (${err.reason})`, err);
      json(res, 503, { error: err.message });
      return;
    }
    if (err instanceof ProjectsDirError) {
      log.error(`Resume failed: projects-dir preflight (${err.reason})`, err);
      json(res, 503, { error: err.message });
      return;
    }
    if (err instanceof McpResolveError) {
      json(res, 400, { error: err.message });
      return;
    }
    if (err instanceof WorkspaceGateUnknownError) {
      log.error("Resume failed: workspace gate unknown", err);
      json(res, 500, { error: err.message });
      return;
    }
    if (isWorkspaceCallerError(err)) {
      json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
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
 * `GET /api/jobs` — snapshot of every job currently in `activeJobs`,
 * including running and recently-finished (within the TTL grace window).
 *
 * Primary consumer: the system test (`test_poller`) needs to know which
 * dispatches are holding the worker's `teamRunning` slot so it can
 * cancel them before injecting its fixture card. Without this surface
 * the test relied on luck — a pre-existing in-flight dispatch (e.g. a
 * stuck card with a 1-hour inactivity timeout) would block the test
 * card forever and the 120s deadline would expire. See Trello
 * `IleofrBj` for the empirical reproduction.
 *
 * Wire shape: `{jobs: getJobStatus[]}` — the same per-job fields
 * `/api/status/:id` returns. A flat array under a `jobs` key keeps room
 * to add metadata (counts, server time) without breaking callers.
 */
export function handleListJobs(res: ServerResponse): void {
  json(res, 200, { jobs: listActiveJobs().map(getJobStatus) });
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

/**
 * Shared body shape for the two Slack side-channel endpoints. Kept as a
 * single helper so the request-parsing contract is identical between
 * `handleSlackReply` and `handleSlackUpdate` — the only difference
 * between the two is which method on the bolt client they call and
 * which dispatch is allowed to reach them (both: trigger === "slack").
 */
function parseSlackText(
  body: Record<string, unknown>,
  res: ServerResponse,
): string | null {
  const raw = body.text;
  if (typeof raw !== "string" || raw.trim() === "") {
    json(res, 400, {
      error: "Missing or blank required field: text",
    });
    return null;
  }
  return raw;
}

/**
 * Shared handler body for the two Slack side-channel endpoints.
 *
 * The danxbot MCP server's `danxbot_slack_reply` and
 * `danxbot_slack_post_update` tools each POST `{text}` to one of these
 * endpoints with the dispatchId in the path. We look up the dispatch,
 * confirm it originated from a Slack message (non-Slack dispatches must
 * never route through here — silent fallback to the first Slack listener
 * is exactly the bug the `getSlackClientForRepo` helper exists to
 * prevent), and call `chat.postMessage` with the thread metadata from
 * the dispatch row.
 *
 * The `tag` parameter is only used for diagnostic logging — both
 * endpoints call the same `chat.postMessage` shape.
 */
async function handleSlackPost(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
  tag: "reply" | "update",
): Promise<void> {
  try {
    const dispatch = await getDispatchById(dispatchId);
    if (!dispatch) {
      json(res, 404, { error: "Dispatch not found" });
      return;
    }
    // Cross-worker guard: the `dispatches` table is shared across
    // workers, so this handler can receive a dispatchId that belongs
    // to a different repo's worker. Without this check the mismatch
    // would surface as a confusing "Slack is not connected" 500 after
    // `getSlackClientForRepo` returned undefined for the other repo —
    // worse, it would leak the existence of other repos' dispatches
    // via the 500 message. 404 here keeps the failure mode crisp and
    // the info surface closed.
    if (dispatch.repoName !== repo.name) {
      json(res, 404, {
        error: `Dispatch "${dispatchId}" is not owned by this worker`,
      });
      return;
    }
    if (dispatch.trigger !== "slack") {
      // A non-Slack dispatch has no Slack thread to post into. Fail
      // loud — a 404 here signals "no such Slack resource for this
      // dispatch," not an auth error. Silent routing to some other
      // thread (e.g. the first connected listener) would be the
      // worst-case bug this check exists to prevent.
      json(res, 404, {
        error: `Dispatch "${dispatchId}" is not a Slack dispatch`,
      });
      return;
    }

    const body = await parseBody(req);
    const text = parseSlackText(body, res);
    if (text === null) return;

    // The `trigger === "slack"` discriminator above guarantees the
    // metadata shape. The cast is required because `Dispatch` stores
    // `trigger` and `triggerMetadata` as independent fields — TS can't
    // narrow the union across that boundary automatically.
    const slackMeta = dispatch.triggerMetadata as SlackTriggerMetadata;
    const client = getSlackClientForRepo(dispatch.repoName);
    if (!client) {
      json(res, 500, {
        error: `Slack is not connected for repo "${dispatch.repoName}"`,
      });
      return;
    }

    // Substitute ` ```sql:execute ``` ` blocks with formatted query
    // results + CSV attachments before posting. Skip the substitution
    // entirely when the worker has no platform DB configured —
    // calling `getPlatformPool()` in that mode would throw, and the
    // agent in a no-DB worker should not be emitting the blocks
    // anyway. Posting verbatim makes the misuse visible to the user
    // rather than masking it with a generic 500.
    let postText = text;
    let attachments: SqlAttachment[] = [];
    if (repo.db.enabled) {
      const processed = await processResponseWithAttachments(text);
      postText = processed.text;
      attachments = processed.attachments;
    }

    try {
      await client.chat.postMessage({
        channel: slackMeta.channelId,
        thread_ts: slackMeta.threadTs,
        text: postText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${tag}] chat.postMessage failed for ${dispatchId}`, err);
      json(res, 500, { error: `Failed to post to Slack: ${msg}` });
      return;
    }

    // Upload each CSV in the same thread. Failures are logged but do
    // not fail the reply — the substituted text is already posted, and
    // a stuck attachment must not silence the agent's answer.
    for (const attachment of attachments) {
      try {
        await client.filesUploadV2({
          channel_id: slackMeta.channelId,
          thread_ts: slackMeta.threadTs,
          filename: attachment.filename,
          content: attachment.csv,
          title: attachment.filename,
        });
      } catch (err) {
        log.warn(
          `[${tag}] filesUploadV2 failed for ${attachment.filename} on ${dispatchId}`,
          err,
        );
      }
    }

    json(res, 200, { status: "posted" });
  } catch (err) {
    log.error(`[${tag}] Slack post failed`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : `Slack ${tag} failed`,
    });
  }
}

/**
 * `POST /api/slack/reply/:dispatchId` — posts the agent's final reply
 * back into the Slack thread that originated this dispatch. Called by
 * the `danxbot_slack_reply` MCP tool from inside a Slack-triggered
 * dispatched agent.
 */
export async function handleSlackReply(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
): Promise<void> {
  await handleSlackPost(req, res, dispatchId, repo, "reply");
}

/**
 * `POST /api/slack/update/:dispatchId` — posts an intermediate status
 * update into the Slack thread. Called by the `danxbot_slack_post_update`
 * MCP tool from inside a Slack-triggered dispatched agent.
 */
export async function handleSlackUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
): Promise<void> {
  await handleSlackPost(req, res, dispatchId, repo, "update");
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
