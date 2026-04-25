# system-test-restricted workspace

Dispatched cwd for `test-system-allow-tools`. The workspace declares the
trello MCP server but only `mcp__trello__get_lists` appears in
`allowed-tools.txt` — every other Trello tool, plus all built-ins
(Read/Bash/Edit/Write/Glob/Grep), is blocked at the dispatch boundary.
The auto-appended `mcp__danxbot__danxbot_complete` is the only other tool
the agent has.

This workspace is the post-P5 replacement for the retired caller-supplied
`allow_tools` field. The test verifies that a write tool absent from
`allowed-tools.txt` cannot land a side effect on Trello — direct empirical
proof that the workspace's declared surface is the runtime gate.
