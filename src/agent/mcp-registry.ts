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
    // Issue-create URL injection. The danxbot MCP process gets the URL
    // via env and `buildActiveTools` exposes `danx_issue_create` only
    // when the env var is set. Single-URL surface — DX-157 retired the
    // parallel agent-facing save tool; agents now `Edit` / `Write` the
    // YAML directly and the chokidar watcher mirrors the change.
    if (opts.issue) {
      env.DANXBOT_ISSUE_CREATE_URL = opts.issue.createUrl;
    }
    // Worker-restart URL injection. The danxbot MCP process gets the
    // URL via env and `buildActiveTools` exposes `danxbot_restart_worker`
    // only when the env var is set. Single-URL surface (unlike the
    // slack + issue pairs) — the worker route is one endpoint.
    if (opts.restartWorkerUrl) {
      env.DANXBOT_RESTART_WORKER_URL = opts.restartWorkerUrl;
    }
    // DX-294 — prep-verdict URL injection. The danxbot MCP process
    // gets the URL via env and `buildActiveTools` exposes
    // `danxbot_prep_verdict` only when the env var is set. Single-URL
    // surface like `restartWorkerUrl`.
    if (opts.prepVerdictUrl) {
      env.DANXBOT_PREP_VERDICT_URL = opts.prepVerdictUrl;
    }
    // DX-294 — per-repo issue prefix used by `parsePrepVerdictArgs` to
    // validate `conflict_with` entries against `^${prefix}-\d+$`. Set
    // alongside the URL (no separate gate) — the validator is a no-op
    // when the prefix is absent, but production dispatches always
    // carry both. The MCP server reads `DANX_ISSUE_PREFIX` at boot and
    // threads it into `PrepVerdictUrls.issuePrefix`.
    if (opts.issuePrefix) {
      env.DANX_ISSUE_PREFIX = opts.issuePrefix;
    }
    // DX-242: pass the fallback context so the MCP server can finalize
    // a dispatch when the stop URL is unreachable. The MCP server reads
    // each var independently (`readFallbackDbConfig` + raw env reads in
    // `main()`) so a half-configured environment (e.g. only repoRoot
    // set, no DB creds) still gets the filesystem-queue path.
    if (opts.fallback) {
      env.DANXBOT_DISPATCH_ID = opts.fallback.dispatchId;
      env.DANX_REPO_ROOT = opts.fallback.repoRoot;
      if (opts.fallback.db) {
        env.DANXBOT_DB_HOST = opts.fallback.db.host;
        if (opts.fallback.db.port !== undefined) {
          env.DANXBOT_DB_PORT = String(opts.fallback.db.port);
        }
        env.DANXBOT_DB_USER = opts.fallback.db.user;
        env.DANXBOT_DB_PASSWORD = opts.fallback.db.password;
        if (opts.fallback.db.database !== undefined) {
          env.DANXBOT_DB_NAME = opts.fallback.db.database;
        }
      }
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
