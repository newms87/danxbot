# slack-worker workspace

This directory is the dispatched cwd for the Slack deep-agent. The
operational rules + skills the Slack worker needs ship via the
`danxbot@newms-plugins` plugin (`enabledPlugins` in
`.claude/settings.json`). The required-tool-call sequence,
intermediate-update discipline, and thread-scope invariant live in the
`danxbot:slack-agent` plugin skill — invoke it via the Skill tool when
running inside this workspace. DX-272 retired the previous inject-side
`.claude/rules/danx-slack-agent.md` in favor of the plugin source.

The danxbot MCP server is infrastructure injected at dispatch time —
its Slack-specific tools (`danxbot_slack_reply`,
`danxbot_slack_post_update`) are wired from overlay placeholders, not
declared here.
