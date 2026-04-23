/**
 * Resolve a dispatch's tool surface — the single function every dispatch
 * entry-point (internal `dispatch()`, `/api/launch`, `/api/resume`, Slack
 * `runAgent`) calls to turn an `allow_tools` allowlist into the concrete
 * `{mcpServers, allowedTools}` pair that ships to claude via `--mcp-config`
 * and `--allowed-tools`.
 *
 * Design: deny-by-default. Built-in tools pass through; MCP tools activate
 * their server via the registry; wildcards expand from the registry's
 * declared tool list. The danxbot MCP server and its `danxbot_complete`
 * tool are infrastructure — they are always injected so the worker can
 * receive completion callbacks, regardless of what the caller asked for.
 *
 * Ordering contract of `allowedTools`:
 *   1. Built-ins in caller-declared order.
 *   2. Each MCP server's tools in registry order (wildcards first, then
 *      explicit names), servers in caller-declared order of first mention.
 *   3. `mcp__danxbot__danxbot_complete` last (so when a caller doesn't
 *      mention danxbot, the infra tool appears in a stable suffix position).
 *   Deduplication preserves earliest appearance.
 *
 * See `.claude/rules/agent-dispatch.md` for the full contract.
 */

import type { McpServerConfig } from "./mcp-settings-shape.js";
import { defaultMcpRegistry } from "./mcp-registry.js";
import {
  DANXBOT_COMPLETE_TOOL,
  DANXBOT_SERVER_NAME,
  McpResolveError,
  type ResolveDispatchToolsOptions,
  type ResolveDispatchToolsResult,
} from "./mcp-types.js";

export {
  DANXBOT_COMPLETE_TOOL,
  DANXBOT_SERVER_NAME,
  McpResolveError,
  type ResolveDispatchToolsOptions,
  type ResolveDispatchToolsResult,
};

/**
 * Resolve `allow_tools` + dispatch context to the concrete config claude needs.
 *
 * Algorithm:
 *   1. Validate every entry is a non-empty string.
 *   2. Split entries into built-ins and MCP tools by the `mcp__` prefix.
 *   3. For MCP tools, parse `mcp__<server>__<tool-or-*>` and collect the set
 *      of required servers.
 *   4. Reject any unknown server (not in the registry) — 400 at the caller.
 *   5. Always add the `danxbot` server.
 *   6. For each required server, call `registry[server].build(opts)` to
 *      produce its `McpServerConfig`. The factory validates its own deps and
 *      throws `McpResolveError` on missing values.
 *   7. Build the `allowedTools` array per the ordering contract above, then
 *      deduplicate (preserving earliest appearance).
 */
export function resolveDispatchTools(
  opts: ResolveDispatchToolsOptions,
): ResolveDispatchToolsResult {
  const registry = opts.registry ?? defaultMcpRegistry;

  // `danxbotStopUrl` is a two-state field: a non-empty URL string OR `null`
  // (explicit Slack-style opt-out). Empty string would otherwise create a
  // confusing third state — the resolver's `!== null` check would treat it
  // as "include danxbot" but the registry factory's truthy check would
  // throw inside `build()`. Reject it loud at the entry instead, with a
  // message that points at the right sentinel for the use case.
  if (
    opts.danxbotStopUrl !== null &&
    (typeof opts.danxbotStopUrl !== "string" || opts.danxbotStopUrl === "")
  ) {
    throw new McpResolveError(
      "danxbotStopUrl must be a non-empty URL string or null (use null to opt out of danxbot injection — Slack runAgent path)",
    );
  }

  // Entry-shape validation. Non-strings are a programming error at the caller
  // (e.g. a body parser let a number through); fail loud.
  //
  // Commas are rejected so the downstream `--allowed-tools <csv>` serialization
  // in `claude-invocation.ts` is unambiguous — a tool name containing a comma
  // would silently split into two tool names at the claude boundary. MCP tool
  // names are identifier-shaped by spec; this reject is a defense-in-depth
  // guard rather than a blocker for any real tool.
  for (const t of opts.allowTools) {
    if (typeof t !== "string") {
      throw new McpResolveError(
        `allow_tools entries must be strings; got ${typeof t}`,
      );
    }
    if (t.trim() === "") {
      throw new McpResolveError(
        "allow_tools entries must be non-empty strings",
      );
    }
    if (t.includes(",")) {
      throw new McpResolveError(
        `allow_tools entry "${t}" contains a comma; tool names must be comma-free (CSV-delimited in --allowed-tools)`,
      );
    }
  }

  const builtIns: string[] = [];
  /**
   * Map of server name → set of explicit tool names. The literal `"*"` is
   * used as a sentinel for a wildcard request — MCP tool names are
   * identifier-shaped, so `"*"` cannot collide with a real tool.
   */
  const serverTools = new Map<string, Set<string>>();

  for (const entry of opts.allowTools) {
    if (!entry.startsWith("mcp__")) {
      builtIns.push(entry);
      continue;
    }
    // mcp__<server>__<tool-or-*>
    const body = entry.slice("mcp__".length);
    const sep = body.indexOf("__");
    if (sep <= 0 || sep >= body.length - 2) {
      throw new McpResolveError(
        `allow_tools entry "${entry}" does not match mcp__<server>__<tool> shape`,
      );
    }
    const server = body.slice(0, sep);
    const tool = body.slice(sep + 2);
    if (!tool) {
      throw new McpResolveError(
        `allow_tools entry "${entry}" has empty tool name`,
      );
    }
    let bucket = serverTools.get(server);
    if (!bucket) {
      bucket = new Set<string>();
      serverTools.set(server, bucket);
    }
    bucket.add(tool);
  }

  // Infrastructure: include danxbot when the caller has a worker port to call
  // back to. Pass `danxbotStopUrl: null` (Slack `runAgent`) to opt out — the
  // SDK iterator's `result` message is the completion signal in that path.
  // The boolean is the single switch for both server injection and the
  // `mcp__danxbot__danxbot_complete` allowlist suffix below.
  const includeDanxbot = opts.danxbotStopUrl !== null;
  const requiredServers = new Set<string>([
    ...(includeDanxbot ? [DANXBOT_SERVER_NAME] : []),
    ...serverTools.keys(),
  ]);

  // Reject unknown servers up front for a clean 400 before any build() runs.
  for (const server of requiredServers) {
    if (!registry[server]) {
      throw new McpResolveError(
        `unknown MCP server "${server}" in allow_tools (registered: ${Object.keys(registry).join(", ")})`,
      );
    }
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const server of requiredServers) {
    const entry = registry[server];
    // Compute the per-server tool allowlist the factory receives. The factory
    // uses it (when the server's wire protocol supports per-tool gating) to
    // register ONLY the tools the caller asked for — unlisted tools never
    // appear in Claude's tool list. This is the real enforcement boundary;
    // `--allowed-tools` on the claude CLI is known to be leaky for MCP calls
    // when paired with `--dangerously-skip-permissions`, so we cannot rely on
    // it alone.
    //
    // Semantics:
    //   - Wildcard (caller asked for `mcp__<server>__*`)       → undefined
    //   - Specific tools (caller listed them explicitly)       → readonly[]
    //   - Server not mentioned in allow_tools (e.g. `danxbot`) → undefined
    //     (infrastructure servers aren't narrowed by caller allowlists)
    //
    // Caller-declared order is preserved so the computed `TRELLO_ENABLED_TOOLS`
    // (or equivalent) is deterministic — easier to diff in test expectations
    // and easier to reason about at the wire level.
    const bucket = serverTools.get(server);
    let serverEnabledTools: string[] | undefined;
    if (bucket && !bucket.has("*")) {
      const orderedTools: string[] = [];
      for (const entryStr of opts.allowTools) {
        if (!entryStr.startsWith(`mcp__${server}__`)) continue;
        const toolName = entryStr.slice(`mcp__${server}__`.length);
        if (toolName === "*") continue;
        if (!orderedTools.includes(toolName)) orderedTools.push(toolName);
      }
      serverEnabledTools = orderedTools;
    }
    try {
      mcpServers[server] = entry.build(opts, serverEnabledTools);
    } catch (err) {
      if (err instanceof McpResolveError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new McpResolveError(
        `failed to build MCP server "${server}": ${reason}`,
      );
    }
  }

  const allowedTools: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    allowedTools.push(name);
  };

  for (const name of builtIns) push(name);

  for (const [server, tools] of serverTools) {
    const entry = registry[server];
    if (tools.has("*")) {
      for (const t of entry.tools) push(`mcp__${server}__${t}`);
    }
    for (const t of tools) {
      if (t === "*") continue;
      push(`mcp__${server}__${t}`);
    }
  }

  // Infrastructure tool — paired with the server: present iff danxbot was
  // injected above. Stable suffix position when the caller didn't ask for it.
  if (includeDanxbot) {
    push(`mcp__${DANXBOT_SERVER_NAME}__${DANXBOT_COMPLETE_TOOL}`);
  }

  return { mcpServers, allowedTools };
}
