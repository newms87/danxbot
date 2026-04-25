# Workspace-Based Dispatch Configuration

**Status:** Phases 1-7 SHIPPED. **`allowed-tools.txt` was retired entirely (card 7WV0rDAA, 2026-04-25).** Every reference below to `allowed-tools.txt`, `--allowed-tools`, `POLLER_ALLOW_TOOLS`, or per-tool allowlists describes the as-shipped state of P3-P5; the post-7WV0rDAA system has no per-dispatch allowlist mechanism — the workspace's `.mcp.json` (with `--strict-mcp-config`) IS the agent's MCP surface, and built-ins are all available by default. See `src/workspace/resolve.ts` header for the rationale (claude's `--allowed-tools` is bypassed by `--dangerously-skip-permissions`).
**Epic:** [jAdeJgi5](https://trello.com/c/jAdeJgi5)
**External dependency:** [s9XdRLcz](https://trello.com/c/s9XdRLcz) (gpt-manager ships its workspace; blocks Phase 7)
**Date:** 2026-04-24
**Author:** Phase 0 investigation per epic [jAdeJgi5](https://trello.com/c/jAdeJgi5)

## Summary

Replace today's four-mechanism dispatch configuration model with a single named-workspace abstraction. Every dispatched agent runs in a workspace at `<repo>/.danxbot/workspaces/<name>/` that declares (statically, Git-trackable) everything the agent needs: tools, MCP servers, rules, skills, sub-agents, gates. Dispatch API collapses to `{repo, workspace, task, status_url, api_token, overlay?: Record<string,string>}` where `overlay` is opaque to danxbot.

The TypeScript MCP registry shrinks from four entries (`danxbot`, `schema`, `trello`, `playwright`) to two (`danxbot`, `playwright`) — schema and trello move into their respective workspaces' `.mcp.json` files. Danxbot ends up with **zero knowledge of any caller-specific concept** (no `schema_definition_id`, no `SCHEMA_API_TOKEN`, no `schema_role` in danxbot source).

## Problem

Today, a dispatched agent's behavior is the product of four fragmented configuration mechanisms with different ownership, injection timing, and testability:

1. **Inject pipeline** — `src/poller/index.ts#syncRepoFiles` writes rules/skills/tools from `src/poller/inject/` into `<repo>/.danxbot/workspace/.claude/` on every poll tick.
2. **Workspace generator** — `src/workspace/generate.ts` writes `CLAUDE.md`, `.gitignore`, `.mcp.json` stub, `.claude/settings.json` to the same dir.
3. **Dispatch profiles** — `src/dispatch/profiles.ts` hardcodes `POLLER_ALLOW_TOOLS` (10 tools), `HTTP_LAUNCH_ALLOW_TOOLS` (7 tools), `SLACK_ALLOW_TOOLS` (4 tools). `dispatchAllowTools(name, overrides)` is the entry point.
4. **MCP registry** — `src/agent/mcp-registry.ts` declares hardcoded TypeScript factories for four servers; `src/dispatch/core.ts#writeMcpSettingsFile` materializes the per-dispatch `.mcp.json` to a temp dir.

Plus inline `--agents <json>` from caller body shape and runtime-mode forks in `src/terminal.ts` for prompt delivery.

Two acute symptoms:

- **Adding a dispatch shape touches four places in three repos.** No single Git-diffable surface for "what does this dispatch look like."
- **Danxbot encodes caller-specific concepts.** The TypeScript registry contains a `SCHEMA_ENTRY` factory for gpt-manager's MCP server. The `/api/launch` body accepts `schema_definition_id`, `schema_role`, `api_url`, `api_token`. None belong in danxbot.

## Goals

1. One filesystem location declares everything about a dispatch's configuration.
2. Danxbot has zero knowledge of caller-specific concepts.
3. Every dispatch flows through one resolver function.
4. Existing callers keep working during migration (legacy adapter).
5. Prompt-delivery mechanism is universal across runtime modes and prompt sizes.

## Non-Goals

- Migrating gpt-manager's `schema-builder` / `behavior-builder` / `template-builder` (their responsibility — [s9XdRLcz](https://trello.com/c/s9XdRLcz)).
- Changing dispatched-agent runtime behavior. Same tools, same MCP servers, same rules — declared differently.
- Removing the inject pipeline. It stays; new job is to sync workspace directories.
- User-level `~/.claude/agents/` discovery. Unchanged.

## Configuration Source Catalog

Investigation enumerated **100 distinct configuration sources** influencing a dispatched agent. Grouped by category:

| Category | Count | Where it lives | When it changes | Final tier |
|---|---|---|---|---|
| **A. Worker process env** | 24 | `src/config.ts:69-155` from `process.env` | Worker restart | Worker-startup (separate from per-dispatch tiers) |
| **B. Per-repo `.env`** | 14 | `<repo>/.danxbot/.env` parsed in `src/repo-context.ts:65-131` | Worker restart | H — workspace declares `${PLACEHOLDER}`, repo context supplies value |
| **C. Per-repo config YAML/MD** | 6 | `<repo>/.danxbot/config/{config.yml,trello.yml,*.md}` | Poller tick (auto-synced) | S — version-controlled, lives in repo |
| **D. Inject pipeline outputs** | 13 artifacts | `src/poller/inject/{rules,skills,tools}/` | Poller tick (auto-synced) | S — moves into workspace dir |
| **E. Caller-supplied per-dispatch** | 11 fields | `/api/launch` body, poller constants, Slack message | Per call | D — overlay or worker-computed |
| **F. Worker-computed per-dispatch** | 13 values | `src/dispatch/core.ts#dispatch()`, `src/agent/launcher.ts#spawnAgent()` | Per call | D — worker-computed overlay entries |

Selected representative entries (full file:line catalog is in epic description):

| Source | Where | Tier (after refactor) |
|---|---|---|
| `ANTHROPIC_API_KEY` | `process.env`, `src/config.ts:107` | Worker-startup |
| `DANX_TRELLO_API_KEY` | `<repo>/.danxbot/.env`, read in `src/repo-context.ts:112` | H — `${TRELLO_API_KEY}` in workspace `.mcp.json` |
| `repo.workerPort` | `<repo>/.danxbot/.env` or `process.env.DANXBOT_WORKER_PORT`, read in `src/repo-context.ts:24-27` | H — `${DANXBOT_WORKER_PORT}` |
| `repo.trello.boardId` | `<repo>/.danxbot/config/trello.yml` | H — `${TRELLO_BOARD_ID}` |
| `POLLER_ALLOW_TOOLS` | `src/dispatch/profiles.ts:83-94` (hardcoded constant) | S — `<repo>/.danxbot/workspaces/trello-worker/allowed-tools.txt` |
| `SCHEMA_ENTRY` MCP factory | `src/agent/mcp-registry.ts:98-165` | (deleted) S — `<gpt-manager>/.danxbot/workspaces/schema-builder/.mcp.json` |
| `body.task` | `/api/launch` body, parsed in `src/worker/dispatch.ts:299` | D — caller-supplied |
| `body.api_token` (status callback bearer) | Same | D — caller-supplied; meaning unchanged |
| `body.schema_*` | Same | (removed) D — moves to `body.overlay.SCHEMA_*` |
| `DANXBOT_STOP_URL` | Constructed in `src/dispatch/core.ts:268` | D — worker-computed overlay entry |
| `DANXBOT_SLACK_REPLY_URL` | Constructed in `src/dispatch/core.ts:254` (slack-trigger branch) | D — worker-computed (slack-worker only) |
| `dispatch tag` | `randomUUID()` in `src/agent/launcher.ts:405` | D — worker-computed |
| `prompt content` | `<repo>/.danxbot/.env`-derived poller skill text or HTTP body | D — caller-supplied; delivered via `@file` (Phase 6) |

## Tier Classification

| Tier | Definition | Where it lives | Failure mode |
|---|---|---|---|
| **S — Static** | Same value every dispatch; version-controlled; no secrets | `<repo>/.danxbot/workspaces/<name>/` (committed in connected repo) | Reviewed via Git diff |
| **H — Hybrid** | Workspace declares `${PLACEHOLDER}`; resolver substitutes at dispatch from trusted repo context | Workspace declares slot; `<repo>/.danxbot/.env` or YAML supplies value | Resolver throws on missing required-placeholders |
| **D — Dynamic** | Caller-supplied or worker-computed per dispatch; never in workspace dir | `/api/launch` body `overlay`, or worker-computed | Same throw path as H |
| **G — Gate** | Repo-state precondition that blocks dispatch entirely | Workspace `required-gates`; resolver short-circuits | Loud error, no spawn |

The S/D/H/G boundary is the single design decision that determines whether this refactor reduces drift or recreates it. Tier mistakes reintroduce hardcoded values to TypeScript, or force callers to redeclare values danxbot should compute.

## Workspace Directory Shape

```
<repo>/.danxbot/workspaces/<name>/
  workspace.yml              # name, description, required-placeholders[], optional-placeholders[], required-gates[]
  allowed-tools.txt          # one entry per line → --allowed-tools CSV
  .mcp.json                  # MCP server declarations with ${placeholder} env refs
  .claude/
    settings.json            # { "env": { "DANXBOT_WORKER_PORT": "${DANXBOT_WORKER_PORT}", ... } }
    rules/*.md               # workspace-specific rules
    skills/*/SKILL.md        # workspace-specific skills
    tools/*                  # workspace-specific tool scripts
    agents/*.md              # first-class sub-agent definitions (replaces inline --agents JSON)
  CLAUDE.md                  # workspace marker
```

`workspace.yml` is the manifest. Schema:

```yaml
name: <workspace-name>
description: <one-line>
required-placeholders:
  - PLACEHOLDER_A
  - PLACEHOLDER_B
optional-placeholders:
  - OPTIONAL_PLACEHOLDER
required-gates:
  - "<gate description string>"
```

The `prompt-delivery` field originally proposed in the epic was DROPPED — the `@file` mechanism (Phase 6) is universal across all sizes and runtime modes. No per-workspace branching needed.

## Two Danxbot-Owned Workspaces

### `trello-worker`

Poller dispatches (`/danx-next`, `/danx-ideate`, `/danx-start`, `/danx-triage`).

| Field | Value |
|---|---|
| `allowed-tools.txt` | `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`, `TodoWrite`, `Agent`, `Task`, `mcp__trello__*` |
| `required-placeholders` | `DANXBOT_STOP_URL`, `DANXBOT_WORKER_PORT`, `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID` |
| `optional-placeholders` | `TRELLO_ENABLED_TOOLS` |
| `required-gates` | `repo.trelloEnabled = true`, no `CRITICAL_FAILURE` flag |
| `.mcp.json` declares | `trello` server (with placeholder env refs) |

`.claude/rules/danx-halt-flag.md` and `.claude/skills/danx-{next,ideate,start,triage}/` move from `src/poller/inject/` into this workspace.

### `slack-worker`

Slack listener deep-agent dispatches.

| Field | Value |
|---|---|
| `allowed-tools.txt` | `Read`, `Glob`, `Grep`, `Bash`, `mcp__danxbot__danxbot_slack_reply`, `mcp__danxbot__danxbot_slack_post_update` |
| `required-placeholders` | `DANXBOT_STOP_URL`, `DANXBOT_WORKER_PORT`, `DANXBOT_SLACK_REPLY_URL`, `DANXBOT_SLACK_UPDATE_URL` |
| `required-gates` | `settings.slack.enabled ≠ false` |
| `.mcp.json` declares | empty `mcpServers` (danxbot is infrastructure, declared by resolver) |

`.claude/rules/danx-slack-agent.md` moves from `src/poller/inject/rules/` into this workspace.

### `http-launch-default` (Phase 5)

Default workspace for HTTP-dispatched agents that haven't shipped their own.

| Field | Value |
|---|---|
| `allowed-tools.txt` | `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`, `TodoWrite` (mirrors today's `HTTP_LAUNCH_ALLOW_TOOLS`) |
| `required-placeholders` | `DANXBOT_STOP_URL`, `DANXBOT_WORKER_PORT` |
| `.mcp.json` declares | empty (danxbot infrastructure auto-injected) |

External callers can pass `workspace: "http-launch-default"` to get a known surface without writing their own.

## MCP Registry Collapse

Today's `src/agent/mcp-registry.ts` declares four entries. After this epic, two:

| Server | Today | After | Why |
|---|---|---|---|
| `danxbot` | TypeScript factory | TypeScript factory (unchanged) | Infrastructure — calls back to danxbot worker endpoints (`/api/stop`, `/api/slack/reply`); dynamic per-trigger tool list |
| `playwright` | TypeScript factory | TypeScript factory (unchanged) | Infrastructure — wraps the Playwright container danxbot deploys on `danxbot-net` |
| `trello` | TypeScript factory | Workspace `.mcp.json` | Used only by danxbot's own `trello-worker` workspace; declared there |
| `schema` | TypeScript factory | Workspace `.mcp.json` (in gpt-manager) | Caller-specific; danxbot has zero knowledge of schema concepts |

The `ResolveDispatchToolsOptions` type loses its `schema: {...}` and `trello: {...}` typed blocks; gains a generic `overlay: Record<string, string>` for placeholder substitution.

## Prompt Delivery — `@file` Syntax (Phase 6)

### Investigation summary

The original epic framing claimed today's `Read $PROMPT_FILE and execute the task described in it` first-message pattern is "one hop removed" and should be retired in favor of inline positional. Empirical investigation refuted this:

**Hard limits encountered:**

| Mechanism | Limit | Source |
|---|---|---|
| Inline argv positional | **128KB hard kernel cap** (Linux MAX_ARG_STRLEN) — fails `E2BIG` errno 7 | Verified empirically; documented in [claude-code#4488](https://github.com/anthropics/claude-code/issues/4488), [Auto-Claude#1414](https://github.com/AndyMik90/Auto-Claude/issues/1414) |
| `claude -p` internal check | "Prompt is too long" rejection client-side, ~120k tokens | [claude-code#12312](https://github.com/anthropics/claude-code/issues/12312) (closed not planned) |
| `stdin` plain pipe (older CLI) | Silent empty output >7KB in headless mode | [claude-code#7263](https://github.com/anthropics/claude-code/issues/7263) — fixed in 2.1.119 (verified) |
| `SessionStart` hook `additionalContext` | 10KB hard cap | [claude-code/hooks docs](https://code.claude.com/docs/en/hooks) |

**Mechanisms that work at any size, tested empirically on claude CLI 2.1.119:**

| Mechanism | Verified at 80B | Verified at 150KB | Notes |
|---|---|---|---|
| `@file` positional | ✅ inlined | ✅ Read-tool fallback (transparent) | **Universal — winner.** Works in both `-p` and interactive TUI modes |
| stdin pipe (`cat file \| claude -p`) | ✅ | ✅ | Works in `-p` only; breaks interactive TUI keyboard |
| Pre-built JSONL + `--resume` | ✅ | ✅ | Works, but content becomes prior history — positional drives inference, meta-instruction still needed |
| `--input-format stream-json` | (not tested) | ⚠️ no response in 120s | Protocol unclear; not pursued |

### Decision: `@file` positional in both runtime modes

```typescript
// src/agent/claude-invocation.ts — new firstMessage template
const firstMessage =
  `${DISPATCH_TAG_PREFIX}${options.jobId} --> @${promptFile}${tracking}`;
```

The `--dangerously-skip-permissions` flag (already passed on every danxbot dispatch per `src/agent/claude-invocation.ts:100`) auto-allows the Read-tool fallback when claude CLI internally chooses that path for large files.

### Empirical evidence

```
=== @file 150KB with --dangerously-skip-permissions ===
real    0m37.735s
exit: 0
YES YES YES   <-- agent identified all three embedded markers (start, mid, end)
```

The `prompt.md` temp file lifecycle is unchanged. The runtime-mode fork (docker `-p` vs host bash script + positional) is unchanged. What changes: seven words in `firstMessage` (`Read $X and execute the task described in it` → `@$X`).

## Claude Code Conventions Research

| Topic | Finding | Source |
|---|---|---|
| CLAUDE.md loading order | Walks UP from cwd; all files concatenated; conflicts resolved last-write-wins | [memory.md](https://code.claude.com/docs/en/memory.md) |
| `.claude/rules/*.md` first-class | Yes — auto-discovered; unconditional rules load at startup; path-scoped via `paths:` frontmatter | Same |
| Rule-file alphabetical ordering | **NOT guaranteed.** The epic's original `primary-task.md loaded LAST via filename` proposal was abandoned. | Empirically confirmed |
| Sub-agent precedence | `--agents` JSON > `.claude/agents/*.md` (project) > `~/.claude/agents/*.md` (user); merge on name collision | [sub-agents.md](https://code.claude.com/docs/en/sub-agents.md) |
| `--allowed-tools` syntax | `Tool` (built-ins); `mcp__server__tool` or `mcp__server__*`; `Bash(cmd *)` for bash patterns; gitignore globs for Read/Edit | [permissions.md](https://code.claude.com/docs/en/permissions.md) |
| Real CLI flag list (claude 2.1.119) | No `--system-prompt-file` / `--prompt-file` / `--message` / `@file` argv expander as a flag — but `@file` syntax works in positional arg | `claude --help` |

## Phase Plan

| # | Card | Title | Depends on | BLOCKED on |
|---|---|---|---|---|
| **P1** | [xgqXKLXW](https://trello.com/c/xgqXKLXW) | Resolver + manifest + placeholders | — | — |
| **P2** | [VKJzZjk9](https://trello.com/c/VKJzZjk9) | `injectDanxWorkspaces` inject pipeline | P1 | — |
| **P3** | [q5aFuINM](https://trello.com/c/q5aFuINM) | trello-worker workspace + poller migration + drop TRELLO_ENTRY | P1, P2 | — |
| **P4** | [gAeJBEDr](https://trello.com/c/gAeJBEDr) | slack-worker workspace + listener migration | P1, P2, P3 | — |
| **P5** | [mGrHNHWM](https://trello.com/c/mGrHNHWM) | `{workspace, overlay}` API + legacy adapter + `http-launch-default` | P1-P4 | — |
| **P6** | [WWYKnQhc](https://trello.com/c/WWYKnQhc) | Prompt delivery via `@file` syntax | (independent) | — |
| **P7** | [LWpUE0sk](https://trello.com/c/LWpUE0sk) | Retire MCP registry + profiles + legacy adapter schema branch | P5 | [s9XdRLcz](https://trello.com/c/s9XdRLcz) (gpt-manager workspace shipped) |

## Decisions Made

1. **Zero schema knowledge in danxbot source.** All schema-related concepts (`SCHEMA_ENTRY`, `body.schema_*`, the `schema: {...}` options block) move to gpt-manager via a workspace declaration. Captured by [s9XdRLcz](https://trello.com/c/s9XdRLcz) and Phase 7.
2. **Playwright stays as danxbot-provided infrastructure.** The Playwright container is on `danxbot-net` and danxbot deploys it. Reasonable as infra factory in `src/agent/mcp-registry.ts`.
3. **Legacy adapter contains transitional schema knowledge.** Marked for deletion at Phase 7; gated on gpt-manager migration. The one place that still knows about schema during the transition.
4. **Prompt delivery via `@file` positional.** Universal across runtime modes and prompt sizes (verified empirically). Drops the `Read $FILE` meta-instruction framing while preserving file-backed delivery.
5. **`prompt-delivery` workspace.yml field DROPPED.** Originally proposed in the epic; no longer needed since `@file` is universal.
6. **Workspace directory location: `<repo>/.danxbot/workspaces/<name>/`** (plural `workspaces`). The legacy `<repo>/.danxbot/workspace/` (singular) directory and its generator stay in place during the migration; cleanup is implicit when nothing reads it.

## Open Questions (Deferred)

1. **`@file` inline-vs-Read-tool size threshold** — exact CLI-internal cutoff is unknown. Treated as transparent implementation detail. If a future optimization wants to pin it, a 60-second binary-search test will measure it.
2. **`stream-json` input-format protocol shape** — first attempt didn't trigger inference within 120s timeout. Not pursued because `@file` is sufficient. Worth revisiting if a future use case wants no Read-tool overhead at any size.
3. **`body.agents` JSON deletion** — Phase 7 keeps `--agents` flag support since other callers may still use it. Future cleanup if/when sub-agents universally migrate to `.claude/agents/*.md` files.

## References

### Code
- `src/dispatch/profiles.ts` — current profile registry (P7 deletes)
- `src/agent/mcp-registry.ts` — current MCP server registry (P3, P7 collapse)
- `src/dispatch/core.ts#dispatch()` — current dispatch core (P5 collapses to single shape)
- `src/agent/claude-invocation.ts` — current first-message construction (P6 swaps to `@file`)
- `src/poller/index.ts#syncRepoFiles` — current inject pipeline (P2 extends with workspaces)
- `src/workspace/generate.ts` — current workspace generator (folded into resolver pattern)

### Trello
- Epic: [jAdeJgi5](https://trello.com/c/jAdeJgi5)
- Phase cards: P1 [xgqXKLXW](https://trello.com/c/xgqXKLXW), P2 [VKJzZjk9](https://trello.com/c/VKJzZjk9), P3 [q5aFuINM](https://trello.com/c/q5aFuINM), P4 [gAeJBEDr](https://trello.com/c/gAeJBEDr), P5 [mGrHNHWM](https://trello.com/c/mGrHNHWM), P6 [WWYKnQhc](https://trello.com/c/WWYKnQhc), P7 [LWpUE0sk](https://trello.com/c/LWpUE0sk)
- gpt-manager dependency: [s9XdRLcz](https://trello.com/c/s9XdRLcz)
- Prior agent-isolation epic (already shipped): `7ha2CSpc` (referenced in `.claude/rules/agent-dispatch.md`)

### External docs
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Memory / CLAUDE.md loading](https://code.claude.com/docs/en/memory.md)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Sub-agents reference](https://code.claude.com/docs/en/sub-agents.md)
- [Permissions / `--allowed-tools` syntax](https://code.claude.com/docs/en/permissions.md)

### Bug reports informing the prompt-delivery research
- [claude-code#4488](https://github.com/anthropics/claude-code/issues/4488) — E2BIG argument list too long
- [claude-code-action#332](https://github.com/anthropics/claude-code-action/issues/332) — Same E2BIG in GH Actions
- [Auto-Claude#1414](https://github.com/AndyMik90/Auto-Claude/issues/1414) — `MAX_ARG_STRLEN = 128KB` cited
- [claude-code#12312](https://github.com/anthropics/claude-code/issues/12312) — `claude -p` hardcoded prompt-size limit
- [claude-code#7263](https://github.com/anthropics/claude-code/issues/7263) — stdin silent empty in headless mode (fixed in 2.1.119)
- [claude-code#46348](https://github.com/anthropics/claude-code/issues/46348) — "Prompt is too long" instead of auto-compact
- [claude-code#38937](https://github.com/anthropics/claude-code/issues/38937) — 20MB conversation context limit
