/**
 * Shared leaf types for the MCP factory pipeline.
 *
 * `mcp-registry.ts` consumes these to declare the per-server `build()`
 * factories that produce `McpServerConfig` entries for the dispatch
 * core's `mcpServers` map.
 */

import type { McpServerConfig } from "./mcp-settings-shape.js";

/** Infrastructure server name — always present in the dispatch MCP set. */
export const DANXBOT_SERVER_NAME = "danxbot";

/**
 * Thrown when an MCP server factory is invoked without the deps it needs
 * (e.g. schema server without `apiUrl`/`apiToken`/`definitionId`, or the
 * danxbot server without `danxbotStopUrl`). Caller (`worker/dispatch.ts`'s
 * `handleLaunch` / `handleResume`) maps this to a `400` HTTP response —
 * fail-loud per `.claude/rules/code-quality.md`.
 */
export class McpResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpResolveError";
  }
}

/**
 * The options bag the danxbot infrastructure MCP factory receives.
 * Caller-app servers (trello, schema, playwright) live in each
 * workspace's `.mcp.json` and never see this options bag. Per-tool
 * allowlisting is NOT a concept — the workspace's `.mcp.json` +
 * `--strict-mcp-config` is the agent's MCP surface (see
 * `src/workspace/resolve.ts` header for why).
 */
export interface McpFactoryOptions {
  /**
   * Worker URL that the agent's `danxbot_complete` tool call will POST to.
   * Always required — every dispatched agent is a spawned CLI with a worker
   * port to call back. Required (not optional) so forgetting to provide it
   * is a compile-time error, never a silent skip.
   */
  danxbotStopUrl: string;
  /**
   * Slack callback URLs for Slack-triggered dispatches. When present,
   * the danxbot MCP server gets the URLs via env and exposes two
   * additional tools (`danxbot_slack_reply`, `danxbot_slack_post_update`)
   * that POST to them. Absent for every non-Slack dispatch.
   *
   * The danxbot MCP server's `buildActiveTools` filter (the SOLE
   * enforcement seam — see `src/mcp/danxbot-server.ts`) hides these
   * tools from `tools/list` when the URLs aren't set. Both fields are
   * required together; a half-Slack dispatch would produce a partially-
   * working tool surface and hide real bugs.
   */
  slack?: {
    replyUrl: string;
    updateUrl: string;
  };
}

export interface McpServerEntry {
  /**
   * Build the `McpServerConfig` for this server from dispatch options.
   * Throws `McpResolveError` when required inputs are missing or malformed.
   * Called only when the workspace's `.mcp.json` (or the dispatch core's
   * danxbot infrastructure merge) actually needs this server.
   */
  build(opts: McpFactoryOptions): McpServerConfig;
}

export type McpRegistry = Readonly<Record<string, McpServerEntry>>;
