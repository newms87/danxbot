# Per-Repo Settings File

The per-repo operational state lives at `<repo>/.danxbot/settings.json`.
This file is the single source of truth for:

- **Feature toggles** (`overrides.slack`, `overrides.trelloPoller`,
  `overrides.dispatchApi`) — three-valued (`true` / `false` / `null`).
  `null` means "defer to the env default on `RepoContext`". `true` / `false`
  are explicit runtime overrides that win over the env var.
- **Masked config mirrors** (`display.*`) — safe, read-only projections of
  what the dashboard renders on the Agents tab. **Never contains raw secrets.**
- **Metadata** (`meta.updatedAt`, `meta.updatedBy`) — last write stamp.

The lock file `<repo>/.danxbot/.settings.lock` serializes concurrent writes
via `fs.open("wx")` with stale-steal at 30s. Both files are gitignored.

## Ownership

| Writer       | Touches                                | When                                               |
|--------------|----------------------------------------|----------------------------------------------------|
| `dashboard`  | `overrides.<feature>` + `meta`         | Operator clicks a toggle on the Agents tab        |
| `worker`     | `display` + `meta`                     | `syncSettingsFileOnBoot` on every worker start    |
| `deploy`     | `display` + `meta` (indirectly, via worker restart) | After secrets materialize + worker relaunch |
| `setup`      | `display` + `meta` (seed) + `overrides` reset to null | Initial `setup` skill run                   |

**Invariant:** a patch containing only `display` NEVER clobbers
`overrides`, and vice versa. `writeSettings` enforces this by merging each
section independently. Operator toggles survive every deploy and every
restart.

## Readers

One function: `isFeatureEnabled(ctx: RepoContext, feature: Feature)` —
the hot path called on every Slack message, every poller tick, and every
`/api/launch`. Never throws; falls back to `ctx`'s env default on any
failure (missing file, corrupt JSON, filesystem error).

Everything else (`readSettings`, the dashboard `GET /api/agents[/repo]`
handlers) goes through `readSettings` which returns the default
structure when the file is absent and logs-once-per-minute-per-path on
parse errors without throwing.

**Do not bypass `isFeatureEnabled` in the three enforcement paths** —
`src/slack/listener.ts`, `src/poller/index.ts`, and
`src/worker/dispatch.ts`. A direct `readSettings` call in those files
would skip the env-default fallback and open a race where a brief file
corruption can suppress messages or 503 live traffic.

## Why the worker refreshes `display` on every boot (instead of deploy writing it directly)

Deploy runs on the operator's host. Writing `settings.json` from deploy
would mean either (a) SSH-uploading JSON, or (b) reimplementing the
display-building logic in a remote shell script. Both duplicate the
worker's existing code.

The worker already knows everything needed to produce `display`: its
`RepoContext` has the masked values, `config.runtime` has the mode, and
`writeSettings` enforces the overrides-preservation invariant. Because
every deploy restarts the worker (`launchWorkers` recreates the
container), the worker's `syncSettingsFileOnBoot` naturally runs after
every deploy.

So the effective flow is:

1. Deploy materializes `.env` files on the instance.
2. Deploy recreates the worker container.
3. Worker boots, loads `RepoContext` from the new `.env`, calls
   `syncSettingsFileOnBoot`.
4. `writeSettings` merges fresh `display` on top of existing `overrides`.
5. Dashboard sees the refreshed masks on its next `/api/agents` poll.

No remote JSON-writing script, no drift between deploy and worker views
of the config, no duplicated display-building logic.

## Schema (abbreviated)

```
{
  "overrides": {
    "slack":        { "enabled": true | false | null },
    "trelloPoller": { "enabled": true | false | null },
    "dispatchApi":  { "enabled": true | false | null }
  },
  "display": {
    "worker":  { "port": 5562, "runtime": "docker" },
    "slack":   { "botToken": "xoxb-****abc", "channelId": "C0123...", "configured": true },
    "trello":  { "apiKey":   "abcd****7890", "boardId":   "69dd...", "configured": true },
    "github":  { "token":    "ghp_****xyz", "configured": true },
    "db":      { "host": "mysql", "database": "ssap_sail", "configured": true },
    "links":   { "trelloBoardUrl": "...", "slackChannelUrl": "", "githubUrl": "..." }
  },
  "meta": { "updatedAt": "...", "updatedBy": "dashboard" | "deploy" | "setup" | "worker" }
}
```

See `src/settings-file.ts` for the canonical TypeScript types and
`docs/superpowers/specs/2026-04-20-agents-tab-design.md` for the full
design document.
