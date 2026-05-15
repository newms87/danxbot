/**
 * Minimal stdio MCP server for danxbot agent lifecycle + side-channel tools.
 *
 * Provides three tools:
 *
 * - `danxbot_complete` — the agent calls this when it finishes work.
 *   POSTs `{status, summary}` to `DANXBOT_STOP_URL` so the worker finalizes
 *   the dispatch row. Always available on every dispatched agent.
 *
 * - `danxbot_slack_reply` — the agent calls this to post its final user-
 *   facing answer into the originating Slack thread. POSTs `{text}` to
 *   `DANXBOT_SLACK_REPLY_URL`. ONLY available when the env var is set
 *   (i.e., when the dispatch is Slack-triggered — see Phase 1 of the
 *   Slack unified-dispatch epic `kMQ170Ea`).
 *
 * - `danxbot_slack_post_update` — the agent calls this to post a
 *   meaningful intermediate progress update into the originating Slack
 *   thread. POSTs `{text}` to `DANXBOT_SLACK_UPDATE_URL`. ONLY available
 *   when the env var is set.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 *
 * The `danxbot_complete` status enum carries three values:
 * - `completed` / `failed` — normal lifecycle. Job finalizes in that state.
 * - `critical_failure` — environment-level blocker (MCP not loading, Bash
 *   unavailable, Claude auth missing). The worker writes a per-repo
 *   critical-failure flag that halts the poller; a human must investigate
 *   and clear the flag. See `.claude/rules/agent-dispatch.md` "Critical
 *   failure flag" for the contract.
 *
 * Fail-loud contract for the Slack tools: if the corresponding URL env var
 * is absent, `callTool` throws instead of silently no-op'ing. A non-Slack
 * agent should never see these tools in its MCP list — `buildActiveTools`
 * filters the server's advertised tools/list based on URL presence, so the
 * tools simply do not exist for a non-Slack dispatch. A call that reaches
 * `callTool` without a URL is a real bug to surface.
 */

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  readFallbackDbConfig,
  tryDirectDbWrite,
  writeFsQueueEntry,
  type FallbackDbConfig,
} from "./danxbot-stop-fallback.js";
import {
  callDanxbotPrepVerdict,
  PREP_VERDICTS,
  type PrepVerdictUrls,
} from "./danxbot-prep-verdict.js";

/**
 * Status values the `danxbot_complete` MCP tool's JSON schema advertises
 * to the agent. Subset of `COMPLETE_STATUSES` — the launcher-internal
 * `api_error_*` statuses (DX-260) are accepted by the worker's stop
 * pipeline but intentionally hidden from the agent's tool surface
 * because the agent never originates them (the API-error recover handler
 * in `attach-monitoring-stack.ts` does).
 */
export const AGENT_COMPLETE_STATUSES = [
  "completed",
  "failed",
  "critical_failure",
  "agent_blocked",
] as const;

/**
 * All values the `/api/stop/:jobId` endpoint AND `job.stop` accept.
 * Includes the agent-visible set plus the launcher-internal status
 * values the API-error recover handler emits (DX-260 / Phase 2 of
 * DX-246) and the rate-limit throttle handler emits (DX-322):
 *
 *   - `api_error_recover` — recover-ok path; maps to dispatch row
 *     status `"recovered"`. Caller is expected to follow up with
 *     `POST /api/resume` so the chain continues on a fresh row whose
 *     `parent_recover_id` references this row.
 *   - `api_error_failed` — cap-exhausted path (recoverCount has
 *     exceeded `MAX_RECOVERS = 3`); maps to dispatch row status
 *     `"failed"`. Caller is expected to write the per-repo
 *     `CRITICAL_FAILURE` flag before signaling so the poller halts.
 *   - `rate_limited` — DX-322 rate-limit throttle path; maps to
 *     dispatch row status `"throttled"`. Caller is expected to write
 *     a throttle-source `CRITICAL_FAILURE` flag with `resume_at`
 *     BEFORE signaling so the poller honors the deadline and auto-
 *     clears past it.
 *
 * Single source of truth for both the schema's enum (via
 * `AGENT_COMPLETE_STATUSES`) and the worker's `isCompleteStatus`
 * validator.
 */
export const COMPLETE_STATUSES = [
  ...AGENT_COMPLETE_STATUSES,
  "api_error_recover",
  "api_error_failed",
  "rate_limited",
] as const;
export type CompleteStatus = (typeof COMPLETE_STATUSES)[number];

export function isCompleteStatus(value: unknown): value is CompleteStatus {
  return (
    typeof value === "string" &&
    (COMPLETE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Map an agent-facing `CompleteStatus` to the `dispatches` row's
 * terminal `status` column.
 *
 *   - `completed` → `completed`
 *   - `failed` → `failed`
 *   - `critical_failure` → `failed`. The halt signal lives in the
 *     per-repo flag file (see `.claude/rules/agent-dispatch.md`
 *     "Critical failure flag"), not on the dispatch row. The
 *     agent-facing response advertises `critical_failure` distinctly
 *     so the operator and the agent see the right signal at each
 *     layer.
 *   - `agent_blocked` → `failed`. The self-block signal lives on the
 *     candidate YAML (`status: "Blocked"` + `blocked: {reason: summary,
 *     timestamp}`) — the dispatch row simply terminates as `failed`.
 *     The worker stop handler stamps the YAML BEFORE finalizing the
 *     row. Requires `issueId` on the dispatch row (the candidate to
 *     stamp); a dispatch without `issueId` rejects this status with
 *     400.
 *   - `api_error_recover` → `recovered`. DX-260 / Phase 2 of DX-246:
 *     the API-error recover handler ended this row terminal; a fresh
 *     row continues the chain via `POST /api/resume`.
 *   - `api_error_failed` → `failed`. DX-260: cap exhausted; the
 *     recover handler also writes the per-repo `CRITICAL_FAILURE`
 *     flag, mirroring the `critical_failure` two-layer pattern.
 *   - `rate_limited` → `throttled`. DX-322: rate-limit throttle
 *     handler killed the dispatch; the throttle flag at
 *     `<repo>/.danxbot/CRITICAL_FAILURE` carries `resume_at` and
 *     the poller auto-clears the flag past the deadline.
 *
 * Single source of truth — `worker/dispatch.ts` (handleStopFromDb),
 * `worker/replay-stop-queue.ts`, and `mcp/danxbot-server.ts`
 * (callDanxbotComplete fallback) all import this. A regression that
 * inlines the mapping in any of those sites loses the documented
 * contract.
 */
export function mapCompleteToTerminalStatus(
  status: CompleteStatus,
): "completed" | "failed" | "recovered" | "throttled" {
  if (status === "completed") return "completed";
  if (status === "api_error_recover") return "recovered";
  if (status === "rate_limited") return "throttled";
  return "failed";
}

/**
 * The set of per-dispatch callback URLs a danxbot MCP server process
 * can reach. `stop` is always present. The two Slack fields are present
 * only for Slack-triggered dispatches — the resolver injects their env
 * vars then, and the server exposes the corresponding tools.
 */
export interface DanxbotToolUrls {
  stop: string;
  slackReply?: string;
  slackUpdate?: string;
  /**
   * DX-242: fallback context so `danxbot_complete` can finalize a
   * dispatch when the worker's stop URL is unreachable (worker
   * crashed, OOM-killed, host reboot). When present, the MCP server
   * tries — in order — direct DB UPDATE on the `dispatches` row, then
   * a filesystem queue entry the worker's boot replay processes.
   *
   * `repoRoot` is the agent's repo root (`<repo>/.danxbot/dispatch-stops/`
   * is the queue directory). `dispatchId` is the same UUID baked into
   * the stop URL — passed explicitly so the MCP server doesn't have
   * to URL-parse `urls.stop` to recover it. `db` carries the
   * `DANXBOT_DB_*` credentials read at MCP boot.
   *
   * All three are optional — a non-worker dispatch (Slack-only ad-hoc
   * tests, fixtures) may not configure any of them. In that mode the
   * MCP server falls back exactly as far as the data lets it: HTTP
   * stop only when none of the fallbacks are configured; HTTP → fs
   * when only `repoRoot` is set; the full HTTP → DB → fs chain when
   * everything is set. Boot reads each from env independently.
   */
  fallback?: {
    repoRoot?: string;
    dispatchId?: string;
    db?: FallbackDbConfig;
  };
  /**
   * Issue-create endpoint. Exposes the `danx_issue_create` tool (atomic
   * `<PREFIX>-N` allocation needs server-side coordination — two agents
   * picking the next id from disk simultaneously would collide). Agents
   * edit YAMLs in place via `Edit` / `Write`; the chokidar watcher
   * mirrors changes to the DB and the poller's per-tick mirror pushes
   * to the tracker. There is no `issueSave` URL — the watcher replaced
   * it (DX-157).
   *
   * Auto-injected by `dispatch()` in worker mode (the worker URL is
   * `http://localhost:<workerPort>/api/issue-create/<dispatchId>`).
   */
  issueCreate?: string;
  /**
   * Worker-restart endpoint (`POST /api/restart/:dispatchId`). When
   * present, `buildActiveTools` exposes `danxbot_restart_worker` and
   * the dispatcher routes calls to `callDanxbotRestartWorker`. Absent,
   * the tool is filtered out of `tools/list` and a `callTool`
   * invocation throws fail-loud.
   *
   * Auto-injected by `dispatch()` in worker mode (the URL is
   * dispatchId-derived: `http://localhost:<workerPort>/api/restart/<dispatchId>`).
   */
  restartWorker?: string;
  /**
   * DX-294 — `danxbot_prep_verdict` endpoint. Exposes the tool only when
   * present (advertise filter); the URL is the worker route
   * `http://localhost:<workerPort>/api/prep-verdict/<dispatchId>`.
   *
   * Auto-injected by `dispatch()` in worker mode for every dispatch the
   * worker can host. The pre-dispatch prep agent (Phase 4 of DX-291)
   * calls this tool with a four-verdict payload; the worker's prep-
   * verdict route applies the YAML / settings stamps and decides
   * whether to keep the dispatch running (combined-mode `ok`) or stop
   * it.
   */
  prepVerdict?: string;
  /**
   * Per-repo `<PREFIX>` (e.g. `"DX"`) used by `parsePrepVerdictArgs`
   * to validate `conflict_with` entries against `^${prefix}-\d+$`.
   * Threaded through from `DANX_ISSUE_PREFIX` env at MCP boot.
   * Optional — absent dispatches degrade to non-prefix validation
   * (still rejects blank-string ids).
   */
  issuePrefix?: string;
  /**
   * DX-367 — `danxbot_set_evaluator_summary` endpoint. Exposed only
   * when present (advertise filter); the URL is the worker route
   * `http://localhost:<workerPort>/api/evaluator-summary/<dispatchId>`.
   *
   * Auto-injected by `dispatch()` ONLY for system-evaluator dispatches
   * (the evaluator-dispatcher passes it in the overlay alongside the
   * struck agent's name in the prompt body). Other dispatches do NOT
   * see this tool — the dispatcher is the only caller that wires it.
   *
   * The worker route locates the target agent by reverse-lookup on
   * `settings.agents.*.broken.evaluator_dispatch_id === dispatchId`,
   * so the MCP tool does not need to carry the target agent name in
   * its arguments — the dispatcher already wrote that binding into
   * settings.json when it stamped `evaluator_status: "running"`.
   */
  evaluatorSummary?: string;
}

export const TOOLS = [
  {
    name: "danxbot_complete",
    description:
      "Signal that the agent has completed all work. Always call this when done " +
      "instead of simply stopping output. Do not exit without calling this tool. " +
      "Use status=\"critical_failure\" ONLY for non-card-specific environment failures " +
      "(MCP tools not loading, Bash tool unavailable, Claude auth missing) — the worker " +
      "will halt the poller and require human intervention before further dispatches. " +
      "Use status=\"agent_blocked\" when YOU (the agent) cannot proceed on the assigned " +
      "card and a human must act — the worker stamps status: Blocked + blocked: " +
      "{reason: summary, timestamp} on the candidate YAML and finalizes the dispatch " +
      "as failed. Load the danxbot:issue-blocker skill BEFORE picking this status — " +
      "the 8-item gate distinguishes a real human-only block from a punt. " +
      "For card-specific fatal errors that do not need a Blocked stamp, use status=\"failed\".",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [...AGENT_COMPLETE_STATUSES],
          description:
            "completed = success, failed = card-specific fatal error, " +
            "critical_failure = environment-level blocker affecting every dispatch, " +
            "agent_blocked = self-block (stamps Blocked on the candidate YAML; requires issue_id on the dispatch row)",
        },
        summary: {
          type: "string",
          description:
            "A brief summary of what was accomplished or why the agent failed. " +
            "For critical_failure, describe the specific environment issue so the operator " +
            "can fix it (e.g. 'MCP server failed to load Trello tools'). " +
            "For agent_blocked, write the blocker reason as one sentence — the worker " +
            "copies this verbatim into the YAML's blocked.reason field.",
        },
      },
      required: ["status", "summary"],
    },
  },
  {
    name: "danxbot_slack_reply",
    description:
      "Post the FINAL user-facing reply to the originating Slack thread. " +
      "Call this exactly once per dispatch, immediately before danxbot_complete. " +
      "The text becomes the user's answer — keep it focused and well-formatted. " +
      "For intermediate progress, use danxbot_slack_post_update instead.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The final reply text to post to the Slack thread.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "danxbot_slack_post_update",
    description:
      "Post an intermediate progress update to the originating Slack thread. " +
      "Use SPARINGLY — only for meaningful status the user cares about (e.g. " +
      "'Reading the campaign schema now', 'Found the failing test'). Do NOT " +
      "post for every file read or trivial step — noise erodes trust.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The intermediate status update text.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "danx_issue_create",
    description:
      "Create a brand-new issue from a draft YAML at " +
      ".danxbot/issues/open/<filename>.yml. The draft can have empty " +
      "id and empty check_item_ids; the worker assigns them. On success " +
      "the worker stamps the assigned id back into the YAML and renames " +
      "the file to <id>.yml — subsequent edits to that issue go through " +
      "the `Edit` / `Write` tools directly (the watcher mirrors them). " +
      "Returns {created: true, id} on success or " +
      "{created: false, errors: [...]} on schema-validation failure.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description:
            "Basename (with or without .yml suffix) of the draft YAML at " +
            ".danxbot/issues/open/. Must already exist on disk.",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "danxbot_prep_verdict",
    description:
      "Signal the result of a pre-dispatch prep step (DX-291 / DX-294). " +
      "Use exactly once at the END of a prep dispatch, BEFORE danxbot_complete. " +
      "Five verdicts: \"ok\" (proceed with candidate); \"conflict_on\" " +
      "(SYMMETRIC file-overlap mutex — candidate and the cards in " +
      "conflict_with[] touch the same files and CANNOT run concurrently — " +
      "the worker appends {id, reason} entries to the candidate YAML's " +
      "conflict_on[]); \"waiting_on\" (ONE-WAY sequential dep — candidate " +
      "needs the cards in depends_on[] to LAND FIRST before its own work " +
      "can start; the worker stamps the candidate YAML's waiting_on field " +
      "with {by: depends_on, reason, timestamp}); \"blocked\" (candidate " +
      "is self-stuck — the worker stamps status: Blocked + blocked: " +
      "{reason, timestamp}); \"abort\" (the prep environment itself is " +
      "broken — the worker stamps agents.<name>.broken on settings.json " +
      "so the picker skips this agent until cleared, and the dispatch " +
      "finalizes as failed). " +
      "PICK THE RIGHT PRIMITIVE: sequential phase ordering (Phase 2 needs " +
      "Phase 1) → waiting_on. Symmetric file overlap between siblings → " +
      "conflict_on. When both apply, emit both (separate calls). " +
      "ARGUMENTS: verdict (required); reason (required, non-empty); " +
      "conflict_with (required iff verdict=conflict_on) — array of partner " +
      "ids; depends_on (required iff verdict=waiting_on) — array of " +
      "predecessor ids; broken_details (required iff verdict=abort) — " +
      "{suggested_steps: string[]}. The legacy \"blocked_by\" arg name " +
      "was renamed 2026-05-12 — calls using it are rejected with a hint.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: [...PREP_VERDICTS],
          description:
            "ok = proceed with candidate; conflict_on = SYMMETRIC mutex " +
            "with conflict_with[] partners (concurrent work on same files); " +
            "waiting_on = ONE-WAY sequential dep, depends_on[] must land " +
            "first; blocked = candidate is self-stuck (human action needed); " +
            "abort = the prep agent's own environment is broken.",
        },
        reason: {
          type: "string",
          description:
            "Non-empty one-sentence justification. Surfaces in the dashboard " +
            "drawer, the YAML's conflict_on / waiting_on / blocked record, " +
            "and the settings.json broken record.",
        },
        conflict_with: {
          type: "array",
          items: { type: "string" },
          description:
            "Required iff verdict === 'conflict_on'. Each entry is a " +
            "<PREFIX>-N id of a card whose work overlaps with the candidate. " +
            "The worker appends {id, reason} to the candidate's conflict_on[].",
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description:
            "Required iff verdict === 'waiting_on'. Each entry is a " +
            "<PREFIX>-N id of a card whose work the candidate sequentially " +
            "depends on (predecessor must land first). The worker stamps the " +
            "candidate's waiting_on = {by: depends_on, reason, timestamp}.",
        },
        broken_details: {
          type: "object",
          description:
            "Required iff verdict === 'abort'. Carries the operator-readable " +
            "recovery steps that land on agents.<name>.broken.suggested_steps.",
          properties: {
            suggested_steps: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["suggested_steps"],
        },
      },
      required: ["verdict", "reason"],
    },
  },
  {
    name: "danxbot_set_evaluator_summary",
    description:
      "Write the root-cause summary for a 3-strike broken agent (DX-367 — Phase 4 " +
      "of DX-363). ONLY the system-evaluator dispatch sees this tool — its dispatch " +
      "id is the binding to the target agent (the dispatcher wrote " +
      "`agent.broken.evaluator_dispatch_id = <this dispatch id>` when stamping " +
      "evaluator_status: 'running'). Call exactly once at the END of the dispatch, " +
      "immediately before danxbot_complete. The worker route writes " +
      "agent.broken.reason = reason + agent.broken.suggested_steps = suggested_steps " +
      "(default `[]` when omitted) + agent.broken.evaluator_status = 'completed', " +
      "and the dashboard banner renders the markdown. A dispatch that " +
      "exits without calling this tool is treated as evaluator failure — the " +
      "dispatcher's onComplete handler flips evaluator_status to 'failed' and the " +
      "default reason from Phase 2 stays put.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Markdown body the dashboard banner renders. Structure: ## Root cause(s) " +
            "(1–3 bullets), ## Per-strike detail (one bullet per strike), ## " +
            "Recommended human action (one paragraph).",
        },
        suggested_steps: {
          type: "array",
          items: { type: "string" },
          description:
            "Ordered list of concrete operator actions. Empty array is allowed " +
            "when the root cause has no clear operator action; the banner falls " +
            "back to displaying just the reason markdown.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "danxbot_restart_worker",
    description:
      "Restart the danxbot worker daemon serving this repo. Use when the " +
      "worker has reached an unrecoverable in-memory state and a fresh " +
      "process is the only fix (poller stuck mid-tick, MCP child leak, " +
      "config drift after deploy). The worker enforces a cooldown, refuses " +
      "cross-repo restarts, refuses self-restart inside docker, and writes " +
      "an audit row for every attempt. The 202 response body is returned " +
      "verbatim so the agent sees `{started: true, oldPid, restartId, " +
      "outcome: \"started\"}` on success or `{started: false, outcome: \"<guard>\"}` " +
      "on a guarded rejection.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description:
            "Repo name the restart targets. The worker refuses (403) when " +
            "this does not match the worker's own repo — cross-repo " +
            "restarts via dashboard proxy are out of scope for this tool.",
        },
        reason: {
          type: "string",
          description:
            "Non-empty operator-readable explanation of why the restart is " +
            "needed. Recorded on the worker_restarts audit row.",
        },
        drain_in_flight: {
          type: "boolean",
          description:
            "When true, the worker waits for in-flight dispatches to drain " +
            "before SIGTERM. Default false — caller opts in.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Drain + health-check timeout in ms. Default 60000.",
        },
      },
      required: ["repo", "reason"],
    },
  },
];

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requireObjectArgs(name: string, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    throw new Error(`Invalid arguments: expected an object for ${name}`);
  }
  return args as Record<string, unknown>;
}

function requireNonBlankString(
  toolName: string,
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new Error(
      `${toolName}: field "${field}" is required and must be a string (got ${typeof value})`,
    );
  }
  if (value.trim() === "") {
    throw new Error(
      `${toolName}: field "${field}" must be a non-empty string`,
    );
  }
  return value;
}

async function callDanxbotComplete(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  const status = args.status;
  const rawSummary = args.summary;

  if (!isCompleteStatus(status)) {
    throw new Error(
      `Invalid status "${String(status)}" — must be one of ${COMPLETE_STATUSES.join(", ")}`,
    );
  }
  const summary = typeof rawSummary === "string" ? rawSummary : "";

  // Primary path: POST to the worker's stop endpoint. Almost always
  // reaches the live worker on localhost; the fallback chain below
  // handles the rare worker-down case (DX-242).
  let primaryError: string | undefined;
  try {
    const response = await postJson(urls.stop, { status, summary });
    if (response.ok) {
      return `Agent signaled ${status}: ${summary}`;
    }
    primaryError = `Stop API returned HTTP ${response.status}`;
  } catch (err) {
    // fetch failed (ECONNREFUSED, DNS, network). Fall through.
    primaryError = err instanceof Error ? err.message : String(err);
  }

  // DX-242 fallback chain: when the worker is unreachable, finalize
  // the dispatch via direct DB write OR filesystem queue so an
  // in-flight dispatch isn't left half-applied (dispatch row stuck
  // running, no auto-sync, no Action Items spawn). The boot replay
  // path handles tracker push + onboard cleanup the next time the
  // worker boots.
  const dispatchId = urls.fallback?.dispatchId;
  const db = urls.fallback?.db;
  const repoRoot = urls.fallback?.repoRoot;

  if (!dispatchId) {
    // Without a dispatch id we can't write a deterministic queue
    // entry or DB row — surface the original error.
    throw new Error(
      `Stop API unreachable (${primaryError}) and no fallback dispatch id available — agent cannot signal completion`,
    );
  }

  // Fallback 1: direct DB UPDATE on the dispatches row.
  // Skip the agent-signaled critical_failure asymmetry — DB schema
  // collapses to completed/failed via `mapCompleteToTerminalStatus`,
  // shared with the worker's stop handlers and boot replay so the
  // collapse rule lives in one place.
  const dbStatus = mapCompleteToTerminalStatus(status);
  if (db) {
    const wrote = await tryDirectDbWrite(
      { dispatchId, dbStatus, summary },
      db,
    );
    if (wrote) {
      return `Agent signaled ${status} (worker unreachable, recorded via DB fallback): ${summary}`;
    }
  }

  // Fallback 2: filesystem queue. The worker scans
  // `<repoRoot>/.danxbot/dispatch-stops/` on next boot and replays
  // each entry through the same auto-sync / updateDispatch path the
  // live `handleStop` runs.
  if (repoRoot) {
    const queued = writeFsQueueEntry(
      { dispatchId, status, summary },
      repoRoot,
    );
    if (queued) {
      return `Agent signaled ${status} (worker + DB unreachable, queued for boot replay): ${summary}`;
    }
  }

  // Every fallback failed. Fail loud so the agent surfaces the issue
  // rather than silently exiting.
  throw new Error(
    `Stop API unreachable (${primaryError}); DB and filesystem fallbacks also failed for dispatch ${dispatchId}`,
  );
}

async function callDanxbotSlackReply(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  // Fail loud when the Slack reply URL isn't configured. A non-Slack
  // dispatch should never see this tool at all — `buildActiveTools`
  // filters it out of the advertised tools/list when `urls.slackReply`
  // is absent. So reaching here without a URL means either: the
  // advertise-filter regressed, OR an agent is probing for tools.
  // Either way, silent fallback to another URL (e.g. the stop URL)
  // would hide a real bug AND misroute a message to an endpoint that's
  // shaped for a different payload.
  if (!urls.slackReply) {
    throw new Error(
      "danxbot_slack_reply called outside a Slack dispatch (DANXBOT_SLACK_REPLY_URL not configured)",
    );
  }
  const text = requireNonBlankString(
    "danxbot_slack_reply",
    "text",
    args.text,
  );
  const response = await postJson(urls.slackReply, { text });
  if (!response.ok) {
    throw new Error(`Slack reply API returned HTTP ${response.status}`);
  }
  return `Reply posted to Slack thread`;
}

async function callDanxbotSlackPostUpdate(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  if (!urls.slackUpdate) {
    throw new Error(
      "danxbot_slack_post_update called outside a Slack dispatch (DANXBOT_SLACK_UPDATE_URL not configured)",
    );
  }
  const text = requireNonBlankString(
    "danxbot_slack_post_update",
    "text",
    args.text,
  );
  const response = await postJson(urls.slackUpdate, { text });
  if (!response.ok) {
    throw new Error(`Slack update API returned HTTP ${response.status}`);
  }
  return `Update posted to Slack thread`;
}

/**
 * Forward an MCP tool call to one of the worker's HTTP routes
 * (`/api/issue-create`, `/api/restart`) and return the response body
 * verbatim as the tool's text content.
 *
 * Network / 4xx / 5xx are surfaced as JSON-RPC errors — those represent
 * worker-side failures, not the agent's expected outcomes. The agent's
 * success/failure semantics live entirely in the 200-response body
 * shape (e.g. `{created: true|false}`, `{started: true|false}`).
 */
async function postWorkerRoute(
  url: string,
  body: Record<string, unknown>,
  toolName: string,
): Promise<string> {
  const response = await postJson(url, body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${toolName} worker endpoint returned HTTP ${response.status}: ${text}`,
    );
  }
  return text;
}

async function callDanxbotRestartWorker(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  if (!urls.restartWorker) {
    throw new Error(
      "danxbot_restart_worker called without DANXBOT_RESTART_WORKER_URL configured " +
        "(no worker endpoint available)",
    );
  }
  const repo = requireNonBlankString("danxbot_restart_worker", "repo", args.repo);
  const reason = requireNonBlankString(
    "danxbot_restart_worker",
    "reason",
    args.reason,
  );
  // The agent-facing schema uses snake_case (MCP convention); the worker's
  // RestartRequest is camelCase. Translate at the boundary so the worker
  // body shape stays untouched (Phase 1 contract). Forward the optional
  // fields only when present so the worker's defaults apply otherwise.
  const body: Record<string, unknown> = { repo, reason };
  if (typeof args.drain_in_flight === "boolean") {
    body.drainInFlight = args.drain_in_flight;
  }
  if (typeof args.timeout_ms === "number") {
    body.timeoutMs = args.timeout_ms;
  }
  return postWorkerRoute(urls.restartWorker, body, "danxbot_restart_worker");
}

async function callDanxbotSetEvaluatorSummary(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  if (!urls.evaluatorSummary) {
    throw new Error(
      "danxbot_set_evaluator_summary called without DANXBOT_EVALUATOR_SUMMARY_URL configured " +
        "(no worker endpoint available — this tool is only injected for system-evaluator dispatches)",
    );
  }
  const reason = requireNonBlankString(
    "danxbot_set_evaluator_summary",
    "reason",
    args.reason,
  );
  let suggestedSteps: string[] = [];
  if (args.suggested_steps !== undefined) {
    if (!Array.isArray(args.suggested_steps)) {
      throw new Error(
        "danxbot_set_evaluator_summary: suggested_steps must be an array of strings",
      );
    }
    for (const step of args.suggested_steps) {
      if (typeof step !== "string") {
        throw new Error(
          "danxbot_set_evaluator_summary: every entry in suggested_steps must be a string",
        );
      }
    }
    suggestedSteps = args.suggested_steps as string[];
  }
  return postWorkerRoute(
    urls.evaluatorSummary,
    { reason, suggested_steps: suggestedSteps },
    "danxbot_set_evaluator_summary",
  );
}

async function callDanxIssueCreate(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  if (!urls.issueCreate) {
    throw new Error(
      "danx_issue_create called without DANXBOT_ISSUE_CREATE_URL configured " +
        "(no worker endpoint available)",
    );
  }
  const filename = requireNonBlankString(
    "danx_issue_create",
    "filename",
    args.filename,
  );
  return postWorkerRoute(
    urls.issueCreate,
    { filename },
    "danx_issue_create",
  );
}

/**
 * Exported so unit tests can exercise the validation + fetch contract
 * directly. Production callers (the JSON-RPC dispatcher below) go
 * through this same function via `tools/call`.
 */
export async function callTool(
  name: string,
  args: unknown,
  urls: DanxbotToolUrls,
): Promise<string> {
  switch (name) {
    case "danxbot_complete":
      return callDanxbotComplete(
        requireObjectArgs("danxbot_complete", args),
        urls,
      );
    case "danxbot_slack_reply":
      return callDanxbotSlackReply(
        requireObjectArgs("danxbot_slack_reply", args),
        urls,
      );
    case "danxbot_slack_post_update":
      return callDanxbotSlackPostUpdate(
        requireObjectArgs("danxbot_slack_post_update", args),
        urls,
      );
    case "danx_issue_create":
      return callDanxIssueCreate(
        requireObjectArgs("danx_issue_create", args),
        urls,
      );
    case "danxbot_restart_worker":
      return callDanxbotRestartWorker(
        requireObjectArgs("danxbot_restart_worker", args),
        urls,
      );
    case "danxbot_set_evaluator_summary":
      return callDanxbotSetEvaluatorSummary(
        requireObjectArgs("danxbot_set_evaluator_summary", args),
        urls,
      );
    case "danxbot_prep_verdict": {
      if (!urls.prepVerdict) {
        throw new Error(
          "danxbot_prep_verdict called without DANXBOT_PREP_VERDICT_URL configured " +
            "(no worker endpoint available)",
        );
      }
      // Strip the completion-only `db` field from `urls.fallback`
      // when forwarding to the prep-verdict client — the verdict
      // fallback shape does NOT carry a db field (see
      // `PrepVerdictUrls.fallback` docstring for the rationale).
      // Pass only `repoRoot` + `dispatchId`.
      const fallback = urls.fallback
        ? {
            ...(urls.fallback.repoRoot
              ? { repoRoot: urls.fallback.repoRoot }
              : {}),
            ...(urls.fallback.dispatchId
              ? { dispatchId: urls.fallback.dispatchId }
              : {}),
          }
        : undefined;
      const prepUrls: PrepVerdictUrls = {
        url: urls.prepVerdict,
        ...(fallback ? { fallback } : {}),
        ...(urls.issuePrefix ? { issuePrefix: urls.issuePrefix } : {}),
      };
      return callDanxbotPrepVerdict(
        requireObjectArgs("danxbot_prep_verdict", args),
        prepUrls,
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(
  id: number | string,
  code: number,
  message: string,
): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

/**
 * Return the subset of `TOOLS` this MCP server will advertise over
 * JSON-RPC given the per-dispatch URL bag. Extracted (and exported) so
 * tests can assert the advertise-filter contract directly. This is the
 * SOLE enforcement seam for Slack-tool exposure — claude's
 * `--allowed-tools` flag was retired (see workspace resolver header at
 * `src/workspace/resolve.ts`), so there is no longer a CLI-side
 * allowlist to back this up. The advertise-filter must be correct on
 * its own: a Slack tool that escapes here becomes callable for a
 * non-Slack agent, and `callTool` would have to be the safety net.
 */
export function buildActiveTools(urls: DanxbotToolUrls) {
  return TOOLS.filter((t) => {
    if (t.name === "danxbot_slack_reply") return !!urls.slackReply;
    if (t.name === "danxbot_slack_post_update") return !!urls.slackUpdate;
    if (t.name === "danx_issue_create") return !!urls.issueCreate;
    if (t.name === "danxbot_restart_worker") return !!urls.restartWorker;
    if (t.name === "danxbot_prep_verdict") return !!urls.prepVerdict;
    if (t.name === "danxbot_set_evaluator_summary") {
      return !!urls.evaluatorSummary;
    }
    return true;
  });
}

function main(urls: DanxbotToolUrls): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const activeTools = buildActiveTools(urls);

  rl.on("line", (line: string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines
    }

    const id = msg["id"] as number | string | undefined;
    const method = msg["method"] as string;
    const params = msg["params"] as Record<string, unknown> | undefined;

    // Notifications (no id) — acknowledge and ignore
    if (id === undefined) return;

    (async () => {
      try {
        if (method === "initialize") {
          respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "danxbot", version: "1.0.0" },
          });
        } else if (method === "ping") {
          respond(id, {});
        } else if (method === "tools/list") {
          respond(id, { tools: activeTools });
        } else if (method === "tools/call") {
          // params comes off the wire as `unknown`; callTool validates
          // the shape internally and throws on malformed input, which
          // the outer try/catch converts to a JSON-RPC -32000 error.
          const p = (params ?? {}) as Record<string, unknown>;
          const text = await callTool(
            p.name as string,
            p.arguments,
            urls,
          );
          respond(id, { content: [{ type: "text", text }] });
        } else {
          respondError(id, -32601, `Method not found: ${method}`);
        }
      } catch (err) {
        respondError(
          id,
          -32000,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  });
}

// Gate the entrypoint bootstrap so unit tests can `import` this module
// without the stdin listener attaching or `process.exit` firing on
// missing env. When run directly (`tsx src/mcp/danxbot-server.ts`), the
// check matches and main() boots normally.
const entryUrl =
  typeof process.argv[1] === "string"
    ? pathToFileURL(process.argv[1]).href
    : "";
if (import.meta.url === entryUrl) {
  const stopUrl = process.env.DANXBOT_STOP_URL;
  if (!stopUrl) {
    process.stderr.write(
      "DANXBOT_STOP_URL environment variable is required\n",
    );
    process.exit(1);
  }
  // DX-242: assemble fallback context. Each piece is optional —
  // present in production worker dispatches, may be absent in older
  // tests or non-worker spawn shapes. The fallback chain inside
  // `callDanxbotComplete` skips any path whose context is missing
  // and reports a precise failure when ALL paths are unreachable.
  const fallbackDispatchId = process.env.DANXBOT_DISPATCH_ID;
  const fallbackRepoRoot = process.env.DANX_REPO_ROOT;
  const fallbackDb = readFallbackDbConfig(process.env);
  const fallback: DanxbotToolUrls["fallback"] =
    fallbackDispatchId || fallbackRepoRoot || fallbackDb
      ? {
          ...(fallbackDispatchId ? { dispatchId: fallbackDispatchId } : {}),
          ...(fallbackRepoRoot ? { repoRoot: fallbackRepoRoot } : {}),
          ...(fallbackDb ? { db: fallbackDb } : {}),
        }
      : undefined;
  const urls: DanxbotToolUrls = {
    stop: stopUrl,
    slackReply: process.env.DANXBOT_SLACK_REPLY_URL,
    slackUpdate: process.env.DANXBOT_SLACK_UPDATE_URL,
    issueCreate: process.env.DANXBOT_ISSUE_CREATE_URL,
    restartWorker: process.env.DANXBOT_RESTART_WORKER_URL,
    prepVerdict: process.env.DANXBOT_PREP_VERDICT_URL,
    issuePrefix: process.env.DANX_ISSUE_PREFIX,
    evaluatorSummary: process.env.DANXBOT_EVALUATOR_SUMMARY_URL,
    ...(fallback ? { fallback } : {}),
  };
  main(urls);
}
