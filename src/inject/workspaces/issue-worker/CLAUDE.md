# issue-worker workspace

This directory is the dispatched cwd for the danxbot poller. Operational rules,
skills, and tools live in `.claude/`. The danxbot MCP server is infrastructure
injected at dispatch time; any additional MCP servers (e.g. playwright) are
declared in `.mcp.json` and resolved from overlay placeholders. There is no
tracker MCP — issues are local YAMLs at `<worktree>/.danxbot/issues/open/`.

## Path placeholder convention — `<worktree>`

Every absolute path in the rules and skills shipped to this workspace uses
`<worktree>` as the placeholder for the agent's persistent worktree dir. Its
literal value lands in your dispatch prompt's persona block on the line
`Your worktree: <absolute path>`. Use that exact string for every Read /
Edit / Write / Bash absolute path you produce.

Do NOT substitute `<worktree>` with `<repo>/.danxbot/worktrees/<name>` or
walk through `repos/<name>` symlinks — Claude's read-before-edit gate keys
on the literal path string, so an aliased spelling that resolves to the
same inode still fails because the gate sees a different string than the
one you Read from. The worktree-guard PreToolUse hook
(`DANX_AGENT_WORKTREE`) also rejects writes whose literal prefix is not
under your worktree; aliased spellings can trip it depending on which
symlinks resolve where.

Issue YAMLs live at `<worktree>/.danxbot/issues/{open,closed}/<id>.yml` —
the `<worktree>/.danxbot/issues` subtree is a symlink back to the main
clone so every agent shares one canonical issue store, but you always
address it via your worktree path.

## Skill triggers (invoke via Skill tool)

| Trigger | Skill |
|---|---|
| About to set `status: "Blocked"`, populate `blocked: {reason, ...}`, append `## Blocked` comment, OR call `danxbot_complete({status: "failed", ...})` with operator-must-X framing | `danxbot:issue-blocker` (8-item gating checklist; refuses the move if any item fails) |
| About to mark a card Blocked because of "pre-existing flaky test," "manual UI smoke," or "post-`danxbot_complete` self-derived state" | `danxbot:no-false-blockers` (the three patterns with programmatic substitutes) |
| Picking up any card whose `status: Blocked` or `waiting_on` is non-null | `danxbot:unblock` |

DX-272 moved the operational rules + skills that used to live under
`.claude/rules/danx-*.md` and `.claude/skills/{danx-*,issue-blocker}/`
into the `danxbot@newms-plugins` plugin. The plugin auto-installs in
every dispatched session via the workspace `.claude/settings.json`
`enabledPlugins` entry, so loading by `<plugin>:<skill>` form is
equivalent to (and faster than) reading the old inject paths. The
inject pipeline no longer ships those files; the per-tick prune
deletes any stale copy.

## Tools you have for "operator-only-looking" verification

Before moving a card to Blocked because of "manual UI smoke," "pre-existing
flaky test," or "post-save behavior I can't observe," invoke the
`danxbot:no-false-blockers` skill. None of those are valid blockers;
programmatic substitutes exist for each.

- **Dashboard auth** (host-mode dispatch): persistent bearer token at
  `~/.config/danxbot/dashboard-token` (read with `cat`). Use against
  `http://localhost:5566/api/*` (Vite proxy) or `http://localhost:5555/api/*`
  (direct API). Sanity check: `curl -H "Authorization: Bearer $(cat ~/.config/danxbot/dashboard-token)" http://localhost:5555/api/auth/me` returns `{"user":{"username":"monitor"}}`.
- **Playwright MCP** for browser-driven smoke (`mcp__playwright__*` tools
  declared in `.mcp.json`). Inject the bearer / cookie before navigating.
- **Dashboard component tests** for "renders X when state Y" ACs:
  `cd dashboard && npx vitest run <path>` mounts the SFC with
  `@vue/test-utils` — deterministic + browser-free.
