# Agents Tab — Per-Repo Settings & Feature Toggles

## Problem

Danxbot runs one worker per connected repo. Each worker exposes three trigger surfaces: Slack listener, Trello poller, and the dispatch API (`POST /api/launch`). Today the only way to enable or disable any of those per repo is by editing `<repo>/.danxbot/.env` and restarting the worker. There is no runtime visibility into which repos have which features on, which keys are configured, or how many dispatches each repo has served.

The goal is a new top-level "Agents" tab on the dashboard that shows every connected repo and lets an operator toggle Slack / Trello poller / dispatch API on or off, view masked config, see recent activity, and jump out to related tools — all without editing files or restarting workers.

## Non-goals

- Editing secrets or API keys from the UI. Config display is read-only.
- Auth mechanism. Mutation endpoints reuse the existing `checkAuth` + `DANXBOT_DISPATCH_TOKEN` bearer flow being built in parallel.
- Audit trail, "pause all", "cancel all running", or recent-failures panel. These are out of scope for v1. The existing Dispatches tab already covers per-repo filtering and failure inspection.
- New database tables. State lives in a per-repo JSON file on disk.

## Architecture

### Source of truth — per-repo settings file

A new gitignored file at `<repo>/.danxbot/settings.json` holds per-repo operational state and display metadata. The file is owned jointly by three writers (dashboard, deploy, setup) and read by one consumer (the worker). The schema is:

```
{
  "overrides": {
    "slack":        { "enabled": true | false | null },
    "trelloPoller": { "enabled": true | false | null },
    "dispatchApi":  { "enabled": true | false | null }
  },
  "display": {
    "worker":  { "port": 5562, "runtime": "docker" },
    "slack":   { "botToken": "xoxb-****abc", "channelId": "C0123ABCDEF", "configured": true },
    "trello":  { "apiKey": "abcd****7890", "boardId": "69ddc215...", "configured": true },
    "github":  { "token": "ghp_****xyz", "configured": true },
    "db":      { "host": "mysql", "database": "ssap_sail", "configured": true },
    "links":   { "trelloBoardUrl": "...", "slackChannelUrl": "...", "githubUrl": "..." }
  },
  "meta": {
    "updatedAt": "2026-04-20T12:00:00Z",
    "updatedBy": "dashboard" | "deploy" | "setup"
  }
}
```

`overrides.<feature>.enabled` is three-valued. `null` means "defer to the env default" (current behavior — e.g. `DANX_TRELLO_ENABLED` for the poller). `true` or `false` is an explicit runtime override that wins over the env var. No secrets are stored in this file at any time. Only masked mirrors of existing secrets live under `display`, solely for the SPA.

The file lives alongside `<repo>/.danxbot/.env` so its location is stable across dev (bind-mounted into dashboard and worker containers) and AWS prod (one repo per instance, mounted into both containers on `danxbot-net`). `.danxbot/settings.json` is added to the per-repo gitignore alongside `.env`.

### Worker enforcement — read on every event

A new module `src/settings-file.ts` exposes three entry points:

- `readSettings(localPath): Settings` — atomic read, returns default structure on missing file, logs and falls through to defaults on parse error.
- `writeSettings(localPath, patch): void` — atomic read-modify-write (write to `settings.json.tmp`, `fs.rename`), merges `patch` into the current file, stamps `meta.updatedAt`/`meta.updatedBy`, and serializes under a per-file lock at `<repo>/.danxbot/.settings.lock`.
- `isFeatureEnabled(ctx: RepoContext, feature: Feature): boolean` — the single hot path. Reads the file, applies override if non-null, else falls back to the env default carried on `RepoContext`. Never throws; on any failure it logs once per minute and returns the env default.

Workers call `isFeatureEnabled` at the last moment before a feature would take effect:

- `src/slack/listener.ts` — at the top of the message handler, before routing. When disabled: add the `:no_entry_sign:` reaction to the triggering message and post a single-line reply ("Danxbot is currently disabled for this repo. Re-enable in the dashboard."). Skip router and agent entirely.
- `src/poller/index.ts` — at the start of each tick loop iteration. When disabled: log once at info level per tick ("poller disabled via settings — skipping") and return. This replaces the existing boot-time `trelloEnabled` branch so toggling takes effect on the next tick (60s default).
- `src/worker/dispatch.ts` — at the top of the `/api/launch` handler, before dispatch bookkeeping. When disabled: return `503 {error: "Dispatch API is disabled for repo <name>"}`. The dashboard proxy in `src/dashboard/dispatch-proxy.ts` forwards that status and body verbatim to the external caller.

Because workers read the file on every event, toggles take effect with zero propagation lag and no worker restart. The file system call is tens of microseconds — negligible compared to the work being gated.

### Dashboard API

A new module `src/dashboard/agents-routes.ts` exposes three routes on the existing dashboard HTTP server:

| Route | Method | Auth | Behavior |
|-------|--------|------|----------|
| `/api/agents` | `GET` | open (parity with existing `/api/dispatches`) | Aggregates per-repo state: reads each repo's `settings.json`, joins dispatch counts from the `dispatches` MySQL table (total / 24h / today, broken out by trigger), probes each worker's `/health` endpoint with a 2-second timeout. Returns an array ordered by `REPOS` env var. |
| `/api/agents/:repo` | `GET` | open | Same shape, single repo. Used by the SPA after a toggle round-trip to refresh one card without re-fetching all. |
| `/api/agents/:repo/toggles` | `PATCH` | bearer (`DANXBOT_DISPATCH_TOKEN` via existing `checkAuth`) | Body `{feature: "slack" \| "trelloPoller" \| "dispatchApi", enabled: true \| false \| null}`. Validates shape, rewrites only `overrides.<feature>` + `meta` — never touches `display`. Responds with the refreshed aggregated record for the repo. |

Worker health probing uses the existing `workerHost(repoName)` from `dispatch-proxy.ts` plus the `workerPort` on `RepoConfig`. Unreachable workers return `{worker: {reachable: false, lastSeenMs: null}}` so the UI can render a red pill without breaking the page. The route file contains no secrets and never reads `.env`.

### SPA — Agents tab

The dashboard gets a second top-level tab. `dashboard/src/App.vue` introduces a minimal `activeTab` ref (values `"dispatches"` and `"agents"`) — no vue-router dependency is added. `DashboardHeader.vue` renders the two tabs and emits tab changes.

New components under `dashboard/src/components/agents/`:

- `AgentsPage.vue` — tab root; consumes `useAgents()`; renders one `RepoCard` per repo.
- `RepoCard.vue` — status pill (worker reachable/unreachable), last-activity timestamp, three `FeatureToggle` instances, dispatch counts broken out by trigger, quick links (Trello board / Slack channel / GitHub), and a collapsible `ConfigTable`.
- `FeatureToggle.vue` — the toggle control. Optimistically flips on click, PATCHes the API, rolls back on non-2xx and surfaces the error inline.
- `ConfigTable.vue` — read-only masked-config table keyed off `display.*`.

A new composable `dashboard/src/composables/useAgents.ts` fetches `/api/agents`, holds state, drives a 10-second refresh timer while the tab is visible, and manages the bearer-token prompt. On the first mutation the UI prompts for the dispatch token, stores it in `sessionStorage`, and re-prompts on 401.

### Deploy and setup integration

Two existing write paths learn to produce `settings.json`:

- `deploy/cli.ts` — after SSM secrets materialize into the target instance's `.env`, call a new `writeSettingsDisplay(target, maskedConfig)` helper that merges fresh `display` values into the settings file. This never overwrites `overrides` — operators' runtime toggles survive redeploys.
- The `setup` skill — during initial install, seed the file with `display` values pulled from the freshly generated `.env` and all `overrides` set to `null`.

A shared `mask(value, visible=4)` helper in `src/settings-file.ts` keeps the mask format consistent across all writers.

The worker also self-seeds on first boot: if `settings.json` is missing, `loadRepoContext` populates `display` from the live `RepoContext`, writes the file, and continues. This is the recovery path for repos that existed before this feature shipped.

### Error handling

- **Missing file** — worker self-seeds, dashboard treats as "all overrides null" and still renders.
- **Corrupt JSON** — worker logs once and falls back to env defaults; dashboard surfaces `"settings_parse_error"` on the affected card so the operator can delete the file to force a reseed.
- **Concurrent writes** — per-file lock at `<repo>/.danxbot/.settings.lock`, 5-second timeout with exponential backoff. All three writers (dashboard, deploy, setup) go through `writeSettings`.
- **Worker unreachable from dashboard** — card shows red pill and last-heartbeat age; toggles still work (they mutate the file, worker picks up on next event when it comes back).
- **PATCH on unknown feature or unknown repo** — `400` with an explicit error string.

### Testing

Unit tests land alongside each module:

- `src/settings-file.test.ts` — read/write/merge/atomic/corrupt-JSON/lock-contention.
- `src/feature-toggle.test.ts` (or colocated in `settings-file.test.ts`) — `isFeatureEnabled` null/true/false × env-default matrix for each feature.
- `src/slack/listener.test.ts` — disabled path posts the reply and reaction and does not invoke the router.
- `src/poller/index.test.ts` — disabled tick is a no-op, not a crash.
- `src/worker/dispatch.test.ts` — disabled `/api/launch` returns `503` with the documented body.
- `src/dashboard/agents-routes.test.ts` — auth enforcement on PATCH, aggregation shape, worker-unreachable path, validation errors.

Integration tests in `src/__tests__/integration/` extend the existing dispatch pipeline with "disabled dispatch API returns 503" and "poller tick skipped when disabled" cases.

SPA gets component tests for `FeatureToggle.vue` (optimistic flip + rollback on 4xx) and `useAgents.ts` (10s refresh, token prompt).

### Docs

The following files are updated when their touching phase lands:

- `CLAUDE.md` — add a short section describing the Agents tab and pointing at this spec.
- `.claude/rules/agent-dispatch.md` — document the 503-when-disabled behavior of `/api/launch`.
- A new `.claude/rules/settings-file.md` — the per-repo settings-file contract: location, schema, ownership, reader/writer rules, lock behavior. This is the doc future agents will read before touching the toggle path.

## Rollout

Four phases, each a single commit with its own test suite. Each phase ends with a working system — no phase leaves the repo in a half-done state.

1. **Settings file module + worker enforcement.** Adds `src/settings-file.ts`, wires `isFeatureEnabled` into Slack / poller / dispatch API, ships the Slack disabled reply. No UI changes yet — operators can toggle by editing `settings.json` by hand.
2. **Dashboard API.** Adds `/api/agents*` routes with bearer auth on PATCH. No UI yet — operators can toggle via `curl`.
3. **Dashboard SPA — Agents tab.** Ships the tab, cards, toggles, and config table against the API from phase 2.
4. **Deploy and setup integration + docs.** Wires deploy and setup to seed `display`, adds the shared `mask()` helper, updates `CLAUDE.md`, `agent-dispatch.md`, and the new `settings-file.md`.
