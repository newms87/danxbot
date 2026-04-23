/**
 * Dispatch profiles — the named, registry-backed tool surfaces every
 * danxbot-dispatched claude agent runs inside. Phase 2 of the
 * agent-isolation epic (Trello card 7ha2CSpc). A profile pins down:
 *
 *   - Which MCP servers the dispatched agent can reach (via the tool
 *     allowlist + the `resolveDispatchTools` registry — servers activate
 *     automatically when any of their tools appear in `allowTools`)
 *   - Which built-in + MCP tools claude will expose to the agent (fed
 *     directly to `--allowed-tools`)
 *
 * Callers never hand-roll `allowTools` arrays anymore. They name a
 * profile (`"poller"` / `"http-launch"`) and read its `allowTools`; the
 * profile's allowlist flows through `dispatch()` →
 * `resolveDispatchTools()` → claude.
 *
 * This module is the SINGLE SOURCE OF TRUTH for named tool surfaces.
 * `src/poller/constants.ts` intentionally does NOT define
 * `POLLER_ALLOW_TOOLS` anymore — callers that used to import it now
 * reach `DISPATCH_PROFILES.poller.allowTools` here.
 *
 * Every dispatcher (Trello poller, HTTP `/api/launch` + `/api/resume`,
 * Slack listener) derives its final allowlist via `dispatchAllowTools`,
 * the single entry point exported below. Callers never import
 * `resolveProfile` + `mergeProfileWithBody` directly in production —
 * that path exists only for the helper's own tests. Routing every
 * consumer through one function eliminates the drift risk of
 * reinlining the "resolve profile, merge overrides" sequence at each
 * callsite.
 *
 * `/api/launch` and `/api/resume` accept a body-level `allow_tools`
 * that is merged with the `http-launch` profile baseline via
 * `dispatchAllowTools("http-launch", body.allow_tools)`. There is no
 * separate "override shape" — the body field IS the override. The
 * `http-launch` baseline is empty today, so effective callers own
 * their full surface; a future baseline addition propagates through
 * the helper without any callsite changes.
 *
 * `--strict-mcp-config` is applied at the spawn layer
 * (`src/agent/claude-invocation.ts`), not here. Profiles are about the
 * tool surface; the strict-config flag is about which `.mcp.json`
 * claude reads. Both are required for isolation — neither is
 * sufficient alone.
 */

/**
 * Hardcoded tool allowlist for every poller-spawned dispatch.
 *
 * Covers the union of the `/danx-next` and `/danx-ideate` skill surfaces:
 *   - Built-ins the orchestrator needs to read, implement, and commit code.
 *   - `mcp__trello__*` so the orchestrator can pick up / move / comment on
 *     cards (the canonical danx-next pickup sequence).
 *   - The resolver auto-injects `mcp__danxbot__danxbot_complete` — don't list
 *     it here (the resolver treats an explicit `mcp__danxbot__*` request as a
 *     registry lookup, not infrastructure).
 *
 * Kept `Agent` + `Task` together because Claude Code currently accepts both
 * as the subagent-dispatch built-in (see `.claude/rules/agent-dispatch.md`
 * sub-agent layout). The resolver treats each entry as opaque and forwards
 * it to `--allowed-tools`.
 *
 * Schema tools (`mcp__schema__*`) are deliberately NOT in the poller surface —
 * the `/danx-next` and `/danx-ideate` skills don't use them. A connected repo
 * that wants schema tools in its poller dispatches needs to opt in explicitly
 * (future work; currently scoped to HTTP dispatch callers like gpt-manager).
 */
const POLLER_ALLOW_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "TodoWrite",
  "Agent",
  "Task",
  "mcp__trello__*",
] as const);

/**
 * Hardcoded tool allowlist for the Slack deep-agent dispatch. Limited to
 * read-only built-ins needed to answer a codebase question:
 *
 *   - Read / Glob / Grep — explore source files
 *   - Bash — read-only inspection (`ls`, `cat`, `git log`); the system
 *     prompt instructs the agent to avoid mutating commands
 *
 * Notably absent:
 *   - Edit / Write — Slack agents never modify the codebase
 *   - mcp__trello__* / mcp__schema__* — not needed for Slack Q&A
 *
 * The Slack dispatch additionally gets the `danxbot_slack_reply` and
 * `danxbot_slack_post_update` MCP tools injected by the resolver when the
 * dispatch input carries `apiDispatchMeta.trigger === "slack"`.
 */
const SLACK_ALLOW_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Bash",
] as const);

/**
 * Names of every built-in dispatch profile. Additions require a
 * corresponding entry in `DISPATCH_PROFILES` below — the `satisfies`
 * clause enforces exhaustiveness at compile time, so forgetting either
 * side is a `tsc --noEmit` error.
 */
export type DispatchProfileName = "poller" | "http-launch" | "slack";

export interface DispatchProfile {
  /**
   * Baseline tool allowlist handed to `resolveDispatchTools`. Each
   * entry is a built-in name (`Read`, `Bash`) or an MCP tool spec
   * (`mcp__<server>__<tool>` or `mcp__<server>__*`). Never include
   * `mcp__danxbot__danxbot_complete` — the resolver injects it as
   * infrastructure.
   */
  readonly allowTools: readonly string[];
}

/**
 * Authoritative profile registry. Order within `allowTools` is
 * significant: `resolveDispatchTools` emits `--allowed-tools` entries
 * in registry order, so changing the order changes the CSV claude
 * sees. For the poller this means Read first, mcp__trello__* last.
 *
 * `as const` + `satisfies` gives readonly inference + exhaustiveness
 * without runtime casts. Object.freeze on the outer object is still
 * applied below so runtime mutation throws (belt + suspenders).
 */
const DISPATCH_PROFILES_RAW = {
  poller: {
    allowTools: POLLER_ALLOW_TOOLS,
  },
  "http-launch": {
    // Empty baseline by design: every HTTP dispatch supplies its own
    // tool surface via `body.allow_tools`. The effective allowlist
    // equals `dispatchAllowTools("http-launch", body.allow_tools)` —
    // profile entries first, body entries second, deduped by first
    // appearance. When the baseline changes in the future, HTTP
    // callers inherit the new entries automatically without a callsite
    // change. Frozen for symmetry with `POLLER_ALLOW_TOOLS`.
    allowTools: Object.freeze([] as readonly string[]),
  },
  slack: {
    allowTools: SLACK_ALLOW_TOOLS,
  },
} as const satisfies Record<DispatchProfileName, DispatchProfile>;

export const DISPATCH_PROFILES: Record<DispatchProfileName, DispatchProfile> =
  Object.freeze(DISPATCH_PROFILES_RAW);

/**
 * Look up a profile by name. Throws on unknown names — that is a
 * programming error at the caller (wrong spelling, stale string
 * literal) and silencing it with a fallback would mask a configuration
 * bug. Matches the fail-loud rule from `.claude/rules/code-quality.md`.
 *
 * Prefer `resolveProfile("poller")` at call sites over indexing
 * `DISPATCH_PROFILES` directly — the helper keeps typo-at-call-site
 * errors loud and centralizes the error message.
 */
export function resolveProfile(name: DispatchProfileName): DispatchProfile {
  const profile = DISPATCH_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown dispatch profile: "${name}" (registered: ${Object.keys(DISPATCH_PROFILES).join(", ")})`,
    );
  }
  return profile;
}

/**
 * Merge a profile's baseline allowlist with caller-supplied override entries
 * into a single, order-preserving, deduplicated array. Profile entries come
 * first; overrides are appended; first appearance wins on dedupe.
 *
 * The helper is total: empty profile → returns the (deduped) overrides; empty
 * overrides → returns the (deduped) profile; both empty → empty array. Inputs
 * are not mutated. Callers never need to pre-dedupe.
 *
 * Prefer `dispatchAllowTools(profileName, overrides)` at call sites — it
 * resolves the profile by name AND applies this merge in one step. This
 * helper is exported for direct use by tests that want to exercise merge
 * semantics against synthetic profiles without going through the registry.
 *
 * Note that MCP server activation is driven by `mcp__<server>__*` entries
 * appearing ANYWHERE in the merged list (profile or overrides) — the
 * resolver looks them up against the registry. There is intentionally no
 * separate `mcpOptIn` field on `DispatchProfile`: the allowlist is the
 * single source of truth for both "what tools claude exposes" and "which
 * servers the per-dispatch `.mcp.json` contains."
 */
export function mergeProfileWithBody(
  profile: DispatchProfile,
  overrideAllowTools: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of profile.allowTools) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  for (const entry of overrideAllowTools) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged;
}

/**
 * The one entry point every dispatcher calls to derive its final allowlist.
 * Resolves the named profile from the registry (fail-loud on typos) and
 * merges the caller's override entries via `mergeProfileWithBody`.
 *
 * Every consumer — the Trello poller (`src/poller/index.ts`), the HTTP
 * launch/resume handlers (`src/worker/dispatch.ts`), and the Slack
 * listener (`src/slack/listener.ts`) — funnels through this function.
 * Callers never import `resolveProfile` + `mergeProfileWithBody` directly
 * except this helper's own tests; routing any new consumer through a
 * different shape would re-introduce the drift risk this helper was built
 * to eliminate. The poller has no overrides today and passes nothing; the
 * HTTP handler passes the validated `body.allow_tools`; Slack passes its
 * profile's existing baseline (zero overrides — same shape as the poller).
 *
 * Part of the agent-isolation epic (Trello `7ha2CSpc`), Phase 4.
 */
export function dispatchAllowTools(
  profileName: DispatchProfileName,
  overrideAllowTools: readonly string[] = [],
): readonly string[] {
  return mergeProfileWithBody(resolveProfile(profileName), overrideAllowTools);
}
