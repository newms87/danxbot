# issue-worker workspace

This directory is the dispatched cwd for the danxbot poller. Operational rules,
skills, and tools live in `.claude/`. The danxbot MCP server is infrastructure
injected at dispatch time; the trello MCP server is declared in `.mcp.json` and
resolved from overlay placeholders.
