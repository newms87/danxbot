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
 * agent should never see these tools in its MCP list (the resolver only
 * adds them to `allowedTools` when the dispatch is Slack-triggered), so a
 * call that reaches `callTool` without a URL is a real bug to surface.
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
  // dispatch should never have this tool in its allowedTools list (the
  // resolver only adds it when opts.slack is present), so reaching here
  // without a URL means either: the resolver regressed, OR an agent is
  // probing for tools. Either way, silent fallback to another URL
  // (e.g. the stop URL) would hide a real bug AND misroute a message to
  // an endpoint that's shaped for a different payload.
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
 * tests can assert the advertise-filter contract directly — the
 * resolver's `--allowed-tools` flag is the "belt" that tells claude
 * which tools it may call; this filter is the "suspenders" that
 * controls what the MCP server exposes at all. A drift between the two
 * would leak Slack tools into a non-Slack agent's `tools/list` output
 * even though `callTool` would still refuse, breaking the enforcement
 * seam documented on the registry's DANXBOT_ENTRY.
 */
export function buildActiveTools(urls: DanxbotToolUrls) {
  return TOOLS.filter((t) => {
    if (t.name === "danxbot_slack_reply") return !!urls.slackReply;
    if (t.name === "danxbot_slack_post_update") return !!urls.slackUpdate;
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
  };
  main(urls);
}
