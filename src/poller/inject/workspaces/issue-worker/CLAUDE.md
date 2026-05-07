# issue-worker workspace

This directory is the dispatched cwd for the danxbot poller. Operational rules,
skills, and tools live in `.claude/`. The danxbot MCP server is infrastructure
injected at dispatch time; any additional MCP servers (e.g. playwright) are
declared in `.mcp.json` and resolved from overlay placeholders. There is no
tracker MCP — issues are local YAMLs at `<repo>/.danxbot/issues/open/`.
