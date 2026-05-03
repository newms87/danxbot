# issue-worker workspace

This directory is the dispatched cwd for the danxbot poller. Operational rules,
skills, and tools live in `.claude/`. The danxbot MCP server is infrastructure
injected at dispatch time; the trello MCP server is declared in `.mcp.json` and
resolved from overlay placeholders.

The workspace name was `trello-worker` before Phase 5 of the tracker-agnostic-
agents epic; the poller writes a one-release symlink alias at
`<repo>/.danxbot/workspaces/trello-worker → issue-worker` so existing
hardcoded dispatches keep resolving. Drop the alias one release after Phase 5
ships (see the Action Items card filed alongside the rename commit).
