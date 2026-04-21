/**
 * Shared leaf types for the MCP dispatch pipeline.
 *
 * `mcp-registry.ts` and `resolve-dispatch-tools.ts` depend on these types and
 * on each other; putting the shared pieces in this leaf module breaks the
 * cycle (see `.claude/rules/tools.md#import-order`).
 */

import type { McpServerConfig } from "./mcp-settings-shape.js";

/** Infrastructure server name — always present in resolver output. */
export const DANXBOT_SERVER_NAME = "danxbot";

/** The one infrastructure tool danxbot exposes to every dispatched agent. */
export const DANXBOT_COMPLETE_TOOL = "danxbot_complete";

/**
 * Thrown when `allow_tools` references an unregistered server, a required
 * dependency is missing for a requested server, or the allowlist is
 * malformed. The caller (worker `handleLaunch` / `handleResume`) maps this to
 * a `400` HTTP response. Fails loud per
 * `.claude/rules/code-quality.md#fallbacks-are-bugs`.
 */
export class McpResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpResolveError";
  }
}

export interface ResolveDispatchToolsOptions {
  /**
   * The caller's tool allowlist. Built-ins are named bare (`Read`, `Bash`);
   * MCP tools use `mcp__<server>__<tool>` or `mcp__<server>__*`. Empty array
   * is valid and means "only the infrastructure `danxbot_complete` tool."
   */
  allowTools: readonly string[];
  /**
   * Worker URL that the agent's `danxbot_complete` tool call will POST to.
   * Required — danxbot is infrastructure.
   */
  danxbotStopUrl: string;
  /** Dependencies for the schema server. Required iff allowTools enables it. */
  schema?: {
    apiUrl: string;
    apiToken: string;
    definitionId: string;
    role?: string;
  };
  /** Dependencies for the trello server. Required iff allowTools enables it. */
  trello?: {
    apiKey: string;
    apiToken: string;
    boardId: string;
    enabledTools?: string;
  };
  /** Test-only: override the registry. Defaults to `defaultMcpRegistry`. */
  registry?: McpRegistry;
}

export interface ResolveDispatchToolsResult {
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
}

export interface McpServerEntry {
  /** Tool short names exposed by this server (used for wildcard expansion). */
  readonly tools: readonly string[];
  /**
   * Build the `McpServerConfig` for this server from dispatch options. Throws
   * `McpResolveError` when required inputs are missing or malformed. Called
   * only when the server is actually needed for a dispatch.
   */
  build(opts: ResolveDispatchToolsOptions): McpServerConfig;
}

export type McpRegistry = Readonly<Record<string, McpServerEntry>>;
