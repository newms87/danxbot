# issue-worker workspace

This directory is the dispatched cwd for the danxbot poller. Operational rules,
skills, and tools live in `.claude/`. The danxbot MCP server is infrastructure
injected at dispatch time; any additional MCP servers (e.g. playwright) are
declared in `.mcp.json` and resolved from overlay placeholders. There is no
tracker MCP — issues are local YAMLs at `<repo>/.danxbot/issues/open/`.

## Skill triggers (invoke via Skill tool)

| Trigger | Skill |
|---|---|
| About to set `status: "Blocked"`, populate `blocked: {reason, ...}`, append `## Blocked` comment, OR call `danxbot_complete({status: "failed", ...})` with operator-must-X framing | `issue-blocker` (8-item gating checklist; refuses the move if any item fails) |

## Tools you have for "operator-only-looking" verification

Before moving a card to Blocked because of "manual UI smoke," "pre-existing
flaky test," or "post-save behavior I can't observe," read
`.claude/rules/danx-no-false-blockers.md`. None of those are valid
blockers; programmatic substitutes exist for each.

- **Dashboard auth** (host-mode dispatch): persistent bearer token at
  `~/.config/danxbot/dashboard-token` (read with `cat`). Use against
  `http://localhost:5566/api/*` (Vite proxy) or `http://localhost:5555/api/*`
  (direct API). Sanity check: `curl -H "Authorization: Bearer $(cat ~/.config/danxbot/dashboard-token)" http://localhost:5555/api/auth/me` returns `{"user":{"username":"monitor"}}`.
- **Playwright MCP** for browser-driven smoke (`mcp__playwright__*` tools
  declared in `.mcp.json`). Inject the bearer / cookie before navigating.
- **Dashboard component tests** for "renders X when state Y" ACs:
  `cd dashboard && npx vitest run <path>` mounts the SFC with
  `@vue/test-utils` — deterministic + browser-free.
