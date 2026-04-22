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
 * `/api/launch` continues to accept a body-level `allow_tools` during
 * the Phase 2→Phase 4 transition (Phase 4 formalizes the override
 * shape). The HTTP-launch profile starts empty by design: the request
 * body is the authoritative source for HTTP dispatch surfaces, and the
 * profile exists to name the baseline.
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
 * Names of every built-in dispatch profile. Additions require a
 * corresponding entry in `DISPATCH_PROFILES` below — the `satisfies`
 * clause enforces exhaustiveness at compile time, so forgetting either
 * side is a `tsc --noEmit` error.
 */
export type DispatchProfileName = "poller" | "http-launch";

export interface DispatchProfile {
  /** Profile name. Matches the `DispatchProfileName` union. */
  readonly name: DispatchProfileName;
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
 * significant: `resolveDispatchTools` preserves caller-declared order
 * when emitting the final `--allowed-tools` CSV, so pollers get Read
 * first / mcp__trello__* last, matching the pre-Phase-2 behavior.
 *
 * `as const` + `satisfies` gives readonly inference + exhaustiveness
 * without runtime casts. Object.freeze on the outer object is still
 * applied below so runtime mutation throws (belt + suspenders).
 */
const DISPATCH_PROFILES_RAW = {
  poller: {
    name: "poller",
    allowTools: POLLER_ALLOW_TOOLS,
  },
  "http-launch": {
    name: "http-launch",
    // Empty baseline — every HTTP dispatch supplies its own tool surface
    // via the request body today. Phase 4 will introduce the explicit
    // override shape; until then, the effective allowlist is
    // `[...profile.allowTools, ...body.allow_tools]` computed at the
    // worker boundary.
    allowTools: [] as readonly string[],
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
