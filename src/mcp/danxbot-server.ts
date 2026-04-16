/**
 * Minimal stdio MCP server for danxbot agent lifecycle tools.
 *
 * Provides the danxbot_complete tool that agents call when they finish work.
 * Reads DANXBOT_STOP_URL from env and POSTs to it when the tool is invoked.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 */

import { createInterface } from "node:readline";

const stopUrl = process.env.DANXBOT_STOP_URL;
if (!stopUrl) {
  process.stderr.write("DANXBOT_STOP_URL environment variable is required\n");
  process.exit(1);
}

const TOOLS = [
  {
    name: "danxbot_complete",
    description:
      "Signal that the agent has completed all work. Always call this when done " +
      "instead of simply stopping output. Do not exit without calling this tool.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["completed", "failed"],
          description: "Whether the agent completed successfully or encountered a fatal error",
        },
        summary: {
          type: "string",
          description: "A brief summary of what was accomplished or why the agent failed",
        },
      },
      required: ["status", "summary"],
    },
  },
];

async function callTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  if (name !== "danxbot_complete") {
    throw new Error(`Unknown tool: ${name}`);
  }

  const { status, summary } = args;
  if (status !== "completed" && status !== "failed") {
    throw new Error(`Invalid status "${status}" — must be "completed" or "failed"`);
  }

  const response = await fetch(stopUrl!, {
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
        const name = (params as { name: string }).name;
        const toolArgs = (params as { arguments: Record<string, string> })
          .arguments;
        const text = await callTool(name, toolArgs);
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
