/**
 * Danxbot infrastructure MCP server registry.
 *
 * The dispatch core merges this server into every dispatch's MCP set so
 * the agent can call `danxbot_complete`. `build(opts)` produces the
 * `McpServerConfig`; it throws `McpResolveError` when a required dep is
 * missing. Caller-app MCP servers (trello, schema, playwright, anything
 * the workspace author wants) live in each workspace's `.mcp.json`
 * directly — there is no registry lookup for them and no per-tool
 * allowlist concept anywhere. The workspace's `.mcp.json` (combined
 * with `--strict-mcp-config`) IS the agent's MCP surface; built-ins are
 * all available by default.
 */

import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DANXBOT_SERVER_NAME,
  McpResolveError,
  type McpRegistry,
  type McpServerEntry,
} from "./mcp-types.js";

export type { McpRegistry, McpServerEntry } from "./mcp-types.js";
export { DANXBOT_SERVER_NAME } from "./mcp-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the danxbot MCP server script (src/mcp/danxbot-server.ts). */
export const DANXBOT_MCP_SERVER_PATH = pathResolve(
  __dirname,
  "../mcp/danxbot-server.ts",
);

/** Infrastructure server — always merged in by the dispatch core. */
const DANXBOT_ENTRY: McpServerEntry = {
  build(opts) {
    if (!opts.danxbotStopUrl) {
      throw new McpResolveError(
        "danxbot server requires danxbotStopUrl (infrastructure dep)",
      );
    }
    const env: Record<string, string> = {
      DANXBOT_STOP_URL: opts.danxbotStopUrl,
    };
    // Slack URL injection: when the caller (today: `dispatch()` for a
    // Slack-triggered dispatch) supplies the Slack callback URLs, the
    // danxbot MCP process gets them via env and the server advertises
    // the Slack tools. Absent `opts.slack`, these env vars are NEVER
    // set — a non-Slack agent can't resolve them via `${...}`
    // interpolation and can't call the Slack tools even if it tries.
    if (opts.slack) {
      env.DANXBOT_SLACK_REPLY_URL = opts.slack.replyUrl;
      env.DANXBOT_SLACK_UPDATE_URL = opts.slack.updateUrl;
    }
    // Issue-tracker URL injection: parallel to the Slack pair. The
    // danxbot MCP process gets the URLs via env and `buildActiveTools`
    // exposes `danx_issue_save` + `danx_issue_create` only when both
    // env vars are set. Absent here, the tools don't appear in
    // `tools/list` and an agent can't accidentally call them.
    if (opts.issue) {
      env.DANXBOT_ISSUE_SAVE_URL = opts.issue.saveUrl;
      env.DANXBOT_ISSUE_CREATE_URL = opts.issue.createUrl;
    }
    return {
      command: "npx",
      args: ["tsx", DANXBOT_MCP_SERVER_PATH],
      env,
    };
  },
};

/**
 * The production MCP server registry. The dispatch core indexes into this
 * to build the danxbot infrastructure server it merges into every
 * dispatch's MCP set. Caller-app servers (trello, schema, playwright)
 * are declared directly in each workspace's `.mcp.json` and never go
 * through this registry.
 */
export const defaultMcpRegistry: McpRegistry = Object.freeze({
  [DANXBOT_SERVER_NAME]: DANXBOT_ENTRY,
});
