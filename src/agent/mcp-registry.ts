/**
 * MCP server registry — the single declarative list of MCP servers danxbot
 * knows how to spawn for a dispatched agent.
 *
 * Each registry entry declares:
 *   - `tools`   — short tool names the server exposes (without the
 *                 `mcp__<server>__` prefix). Used for wildcard expansion when
 *                 a caller passes `mcp__<server>__*` in `allow_tools`. Explicit
 *                 tool names in `allow_tools` pass through unconditionally —
 *                 claude is the authoritative gate at runtime.
 *   - `build`   — factory that produces the `McpServerConfig` for a dispatch.
 *                 Throws `McpResolveError` when required deps are missing.
 *
 * Adding a new MCP server is a single entry here plus a one-line doc update —
 * no changes at any call site. See `.claude/rules/agent-dispatch.md` for the
 * runbook.
 */

import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DANXBOT_COMPLETE_TOOL,
  DANXBOT_SERVER_NAME,
  McpResolveError,
  type McpRegistry,
  type McpServerEntry,
} from "./mcp-types.js";

export type { McpRegistry, McpServerEntry } from "./mcp-types.js";
export { DANXBOT_COMPLETE_TOOL, DANXBOT_SERVER_NAME } from "./mcp-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the danxbot MCP server script (src/mcp/danxbot-server.ts). */
export const DANXBOT_MCP_SERVER_PATH = pathResolve(
  __dirname,
  "../mcp/danxbot-server.ts",
);

/** Slack-only tools exposed on the danxbot server when opts.slack is present. */
export const DANXBOT_SLACK_REPLY_TOOL = "danxbot_slack_reply";
export const DANXBOT_SLACK_POST_UPDATE_TOOL = "danxbot_slack_post_update";

/** Infrastructure server — always injected by the resolver. */
const DANXBOT_ENTRY: McpServerEntry = {
  // The `tools` list is the set of short names used for wildcard
  // expansion. We intentionally DO NOT include the Slack tools here:
  // wildcard expansion of `mcp__danxbot__*` must not silently enable
  // Slack tools for a non-Slack dispatch. Slack tools are added to
  // `allowedTools` only when `opts.slack` is present, via an explicit
  // branch in the resolver — belt-and-suspenders with the server's
  // own `tools/list` filtering (see `src/mcp/danxbot-server.ts`'s
  // `activeTools` filter in `main`).
  tools: [DANXBOT_COMPLETE_TOOL],
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
    return {
      command: "npx",
      args: ["tsx", DANXBOT_MCP_SERVER_PATH],
      env,
    };
  },
};

const SCHEMA_ENTRY: McpServerEntry = {
  tools: [
    "annotation_convert_to_rule",
    "annotation_create",
    "annotation_delete",
    "annotation_list",
    "annotation_resolve",
    "annotation_update",
    "blueprint_list",
    "context_chat_history",
    "context_workflow_input_pages",
    "context_workflow_inputs",
    "directive_create",
    "directive_delete",
    "directive_list",
    "directive_update",
    "post_progress",
    "quality_gate_list",
    "quality_gate_submit_review",
    "schema_get",
    "schema_remove_model",
    "schema_update_model",
    "schema_update_root",
    "style_list",
    "template_create",
    "template_get",
    "template_get_example_pages",
    "template_get_sample_data",
    "template_list",
    "template_patch",
    "template_preview",
    "template_preview_html",
    "template_set_sample_data",
    "template_update",
  ],
  build(opts) {
    const schema = opts.schema;
    if (!schema) {
      throw new McpResolveError(
        "mcp__schema__* requires a 'schema' options block with apiUrl, apiToken, and definitionId",
      );
    }
    if (!schema.apiUrl) {
      throw new McpResolveError("schema server missing apiUrl (SCHEMA_API_URL)");
    }
    if (!schema.apiToken) {
      throw new McpResolveError(
        "schema server missing apiToken (SCHEMA_API_TOKEN)",
      );
    }
    if (!schema.definitionId) {
      throw new McpResolveError(
        "schema server missing definitionId (SCHEMA_DEFINITION_ID)",
      );
    }
    const env: Record<string, string> = {
      SCHEMA_API_URL: schema.apiUrl,
      SCHEMA_API_TOKEN: schema.apiToken,
      SCHEMA_DEFINITION_ID: schema.definitionId,
    };
    if (schema.role) env.SCHEMA_ROLE = schema.role;
    return {
      command: "npx",
      args: ["-y", "@thehammer/schema-mcp-server"],
      env,
    };
  },
};

const TRELLO_ENTRY: McpServerEntry = {
  tools: [
    "add_card_to_list",
    "add_checklist_item",
    "add_comment",
    "create_checklist",
    "create_label",
    "delete_checklist_item",
    "delete_label",
    "get_acceptance_criteria",
    "get_board_labels",
    "get_card",
    "get_card_comments",
    "get_card_history",
    "get_cards_by_list_id",
    "get_checklist_by_name",
    "get_checklist_items",
    "get_lists",
    "get_my_cards",
    "move_card",
    "update_card_details",
    "update_checklist_item",
    "update_label",
  ],
  build(opts, enabledTools) {
    const trello = opts.trello;
    if (!trello) {
      throw new McpResolveError(
        "mcp__trello__* requires a 'trello' options block with apiKey, apiToken, and boardId",
      );
    }
    if (!trello.apiKey) {
      throw new McpResolveError("trello server missing apiKey (TRELLO_API_KEY)");
    }
    if (!trello.apiToken) {
      throw new McpResolveError(
        "trello server missing apiToken (TRELLO_TOKEN)",
      );
    }
    if (!trello.boardId) {
      throw new McpResolveError(
        "trello server missing boardId (TRELLO_BOARD_ID)",
      );
    }
    const env: Record<string, string> = {
      TRELLO_API_KEY: trello.apiKey,
      TRELLO_TOKEN: trello.apiToken,
      TRELLO_BOARD_ID: trello.boardId,
    };
    // `enabledTools === undefined` = wildcard (`mcp__trello__*`). Leaving
    // TRELLO_ENABLED_TOOLS absent makes the server register its full tool
    // surface, matching the caller's request. An explicit array narrows the
    // server's registerTool shim so unlisted tools never appear in the
    // MCP tool list Claude sees — this is the enforcement boundary, not
    // `--allowed-tools`. See @thehammer/mcp-server-trello#TrelloServer ctor.
    if (enabledTools && enabledTools.length > 0) {
      env.TRELLO_ENABLED_TOOLS = enabledTools.join(",");
    }
    return {
      command: "npx",
      args: ["-y", "@thehammer/mcp-server-trello"],
      env,
    };
  },
};

/**
 * The production MCP server registry. Call sites that want the defaults pass
 * nothing (resolver uses this). Tests inject a custom registry via
 * `ResolveDispatchToolsOptions.registry` to exercise the lookup path without
 * touching production factories.
 */
export const defaultMcpRegistry: McpRegistry = Object.freeze({
  [DANXBOT_SERVER_NAME]: DANXBOT_ENTRY,
  schema: SCHEMA_ENTRY,
  trello: TRELLO_ENTRY,
});
