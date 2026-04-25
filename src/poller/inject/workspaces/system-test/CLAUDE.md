# system-test workspace

Dispatched cwd for `make test-system-*`. Minimal read-only surface:
Read/Glob/Grep/Bash/LS plus the auto-appended `mcp__danxbot__danxbot_complete`.
No external MCP servers — individual tests that need Trello declare the
`system-test-restricted` workspace instead.
