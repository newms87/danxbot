/**
 * Minimal stdio MCP server for danxbot agent lifecycle tools.
 *
 * Provides the danxbot_complete tool that agents call when they finish work.
 * Reads DANXBOT_STOP_URL from env and POSTs to it when the tool is invoked.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 *
 * The status enum carries three values:
 * - `completed` / `failed` — normal lifecycle. Job finalizes in that state.
 * - `critical_failure` — environment-level blocker (MCP not loading, Bash
 *   unavailable, Claude auth missing). The worker writes a per-repo
 *   critical-failure flag that halts the poller; a human must investigate
 *   and clear the flag. See `.claude/rules/agent-dispatch.md` "Critical
 *   failure flag" for the contract.
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
];

/**
 * Exported so unit tests can exercise the validation + fetch contract
 * directly. Production callers (the JSON-RPC dispatcher below) go
 * through this same function via `tools/call`.
 */
export async function callTool(
  name: string,
  args: unknown,
  stopUrl: string,
): Promise<string> {
  if (name !== "danxbot_complete") {
    throw new Error(`Unknown tool: ${name}`);
  }

  if (!args || typeof args !== "object") {
    throw new Error(`Invalid arguments: expected an object for danxbot_complete`);
  }
  const argObj = args as Record<string, unknown>;
  const status = argObj.status;
  const rawSummary = argObj.summary;

  if (!isCompleteStatus(status)) {
    throw new Error(
      `Invalid status "${String(status)}" — must be one of ${COMPLETE_STATUSES.join(", ")}`,
    );
  }
  const summary = typeof rawSummary === "string" ? rawSummary : "";

  const response = await fetch(stopUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, summary }),
  });

  if (!response.ok) {
    throw new Error(`Stop API returned HTTP ${response.status}`);
  }

  return `Agent signaled ${status}: ${summary}`;
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

function main(stopUrl: string): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

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
          respond(id, { tools: TOOLS });
        } else if (method === "tools/call") {
          // params comes off the wire as `unknown`; callTool validates
          // the shape internally and throws on malformed input, which
          // the outer try/catch converts to a JSON-RPC -32000 error.
          const p = (params ?? {}) as Record<string, unknown>;
          const text = await callTool(
            p.name as string,
            p.arguments,
            stopUrl,
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
  main(stopUrl);
}
