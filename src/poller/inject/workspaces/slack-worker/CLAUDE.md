# slack-worker workspace

This directory is the dispatched cwd for the Slack deep-agent. Operational
rules (including `danx-slack-agent.md`) live under `.claude/rules/`. The
danxbot MCP server is infrastructure injected at dispatch time — its
Slack-specific tools (`danxbot_slack_reply`, `danxbot_slack_post_update`)
are wired from overlay placeholders, not declared here.
