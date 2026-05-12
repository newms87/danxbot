# skill-eval workspace

This directory is the dispatched cwd for `/skill-eval` probe runs (DX-276).
Each probe is a one-shot dispatch whose ONLY job is to surface what the
agent would have done in response to a single user query — the harness
inspects the resulting JSONL for a `Skill(<plugin>:<skill>)` tool-use to
assert the trigger landed.

## Why isolated

Probes share the danxbot host's `~/.claude/projects/` JSONL store with
`issue-worker` and `system-test`. Disambiguating by `cwd` is the cheapest
way to keep probe JSONLs out of the operational session logs — claude
encodes the cwd into the JSONL directory name. Routing every probe
through `<repo>/.danxbot/workspaces/skill-eval/` puts probe sessions in
their own directory:
`~/.claude/projects/-home-newms-web-danxbot--danxbot-workspaces-skill-eval/`.

## Plugin surface

`.claude/settings.json` enables the same plugin set as `issue-worker`
(`base`, `investigate`, `dev`, `pipeline`, `danxbot`). The harness is
asserting whether those plugin skills load on a given prompt; the
plugins must be available to load.
