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

/**
 * All values the `danxbot_complete` MCP tool accepts for `status`. Exposed
 * (alongside `isCompleteStatus`) so the worker's stop handler and the
 * MCP server schema can reference a single source of truth.
 */
export const COMPLETE_STATUSES = ["completed", "failed", "critical_failure"] as const;
export type CompleteStatus = (typeof COMPLETE_STATUSES)[number];

export function isCompleteStatus(value: unknown): value is CompleteStatus {
  return (
    typeof value === "string" &&
    (COMPLETE_STATUSES as readonly string[]).includes(value)
  );
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
   * Issue-tracker save/create endpoints. Both required together to
   * expose the `danx_issue_save` + `danx_issue_create` tools — a half-
   * defined surface would mean the agent could call save but never
   * create (or vice versa), and silent partial behavior is exactly the
   * failure mode the fail-loud `callTool` guard catches.
   *
   * Auto-injected by `dispatch()` in worker mode (the worker URL is
   * `http://localhost:<workerPort>/api/issue-…/<dispatchId>`).
   */
  issueSave?: string;
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
      "For card-specific blockers (missing info, unclear requirements), use status=\"failed\" " +
      "and rely on the orchestrator to move the card to Needs Help.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [...COMPLETE_STATUSES],
          description:
            "completed = success, failed = card-specific fatal error, " +
            "critical_failure = environment-level blocker affecting every dispatch",
        },
        summary: {
          type: "string",
          description:
            "A brief summary of what was accomplished or why the agent failed. " +
            "For critical_failure, describe the specific environment issue so the operator " +
            "can fix it (e.g. 'MCP server failed to load Trello tools').",
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
    name: "danx_issue_save",
    description:
      "Save the per-issue YAML at .danxbot/issues/open/<id>.yml " +
      "(or .danxbot/issues/closed/<id>.yml if the issue is Done/Cancelled). " +
      "The worker validates the YAML synchronously and returns " +
      "{saved: true} on success or {saved: false, errors: [...]} on " +
      "schema-validation failure. Call this after every meaningful edit " +
      "to the local YAML. When the saved status is Done or Cancelled, " +
      "the worker moves the file from open/ → closed/ as part of the save.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The issue's id (matches the YAML filename without the .yml " +
            "extension, e.g. ISS-138).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "danx_issue_create",
    description:
      "Create a brand-new issue from a draft YAML at " +
      ".danxbot/issues/open/<filename>.yml. The draft can have empty " +
      "id and empty check_item_ids; the worker assigns them. On success " +
      "the worker stamps the assigned id back into the YAML and renames " +
      "the file to <id>.yml — your subsequent danx_issue_save calls must " +
      "use that new id. Returns {created: true, id} on success or " +
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

  const response = await postJson(urls.stop, { status, summary });
  if (!response.ok) {
    throw new Error(`Stop API returned HTTP ${response.status}`);
  }
  return `Agent signaled ${status}: ${summary}`;
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
 * (`/api/issue-save`, `/api/issue-create`, `/api/restart`) and return
 * the response body verbatim as the tool's text content.
 *
 * Network / 4xx / 5xx are surfaced as JSON-RPC errors — those represent
 * worker-side failures, not the agent's expected outcomes. The agent's
 * success/failure semantics live entirely in the 200-response body
 * shape (e.g. `{saved: true|false}`, `{started: true|false}`).
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

async function callDanxIssueSave(
  args: Record<string, unknown>,
  urls: DanxbotToolUrls,
): Promise<string> {
  if (!urls.issueSave) {
    throw new Error(
      "danx_issue_save called without DANXBOT_ISSUE_SAVE_URL configured " +
        "(no worker endpoint available)",
    );
  }
  const id = requireNonBlankString("danx_issue_save", "id", args.id);
  return postWorkerRoute(urls.issueSave, { id }, "danx_issue_save");
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
    case "danx_issue_save":
      return callDanxIssueSave(
        requireObjectArgs("danx_issue_save", args),
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
    if (t.name === "danx_issue_save") return !!urls.issueSave;
    if (t.name === "danx_issue_create") return !!urls.issueCreate;
    if (t.name === "danxbot_restart_worker") return !!urls.restartWorker;
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
  const urls: DanxbotToolUrls = {
    stop: stopUrl,
    slackReply: process.env.DANXBOT_SLACK_REPLY_URL,
    slackUpdate: process.env.DANXBOT_SLACK_UPDATE_URL,
    issueSave: process.env.DANXBOT_ISSUE_SAVE_URL,
    issueCreate: process.env.DANXBOT_ISSUE_CREATE_URL,
    restartWorker: process.env.DANXBOT_RESTART_WORKER_URL,
  };
  main(urls);
}
