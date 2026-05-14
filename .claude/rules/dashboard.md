# Dashboard

## Component Library Mandate — `@thehammer/danx-ui` First

**Default to DanxUI for every UI primitive.** Before hand-rolling a button, dialog, popover, tooltip, toggle, slider, tabs panel, scroll container, code viewer, markdown editor, icon — check `@thehammer/danx-ui` exports first. The library ships themed, accessible, dark-mode-aware versions of the common pieces; reaching past it to a raw `<button>`, `<dialog>`, browser-native `title=` tooltip, or one-off CSS modal forks the dashboard's look-and-feel.

Current canonical mappings (extend as the library grows):

| UI need | Use | Never use |
|---|---|---|
| Hover/focus tooltip | `<DanxTooltip :tooltip="…">` with `#trigger` slot | Native `title=` / `:title=` on a raw HTML element |
| Modal / confirmation | `<DanxDialog>` (or repo-local `AgentConfirmModal` which wraps it) | Custom `<div class="modal">` overlays, native `<dialog>` |
| Button | `<DanxButton>` | Raw `<button>` for any branded surface (raw `<button>` is OK only inside compound widgets like `IssueCard` where button = the whole card) |
| Icon | `<DanxIcon>` (registry or raw SVG); for FA glyphs source via `danx-icon` `?raw` import | Inline `<svg>` literals, Unicode glyphs, emoji-as-icon |
| Tabs | `<DanxTabs>` | Hand-rolled tab state |
| Scrollable column | `<DanxScroll>` | Raw `overflow:auto` divs when the page already lives inside a DanxScroll context |
| Toggle / switch | `<DanxToggle>` | Native checkbox styled to look like a switch |
| Code block | `<CodeViewer>` | Raw `<pre><code>` |
| Markdown rendering / editing | `<MarkdownEditor>` | Hand-rolled markdown rendering |

**Tooltip rule, hard.** Zero raw `title=` HTML attributes on any element in `dashboard/src/components/**/*.vue`. Component-prop `title=` on PascalCase tags (`<DanxDialog title="…">`, `<AgentConfirmModal title="…">`) is fine — that's a dialog header, not a hover tooltip. Browser-native `title=` ignores theme, ignores reduced-motion, has no focus path, and disagrees with the rest of the dashboard's hover-popover UX. Use:

```vue
<DanxTooltip :tooltip="reasonExpr">
  <template #trigger>
    <span class="x">{{ label }}</span>
  </template>
</DanxTooltip>
```

The `tooltip` prop accepts `string | undefined`; an undefined value renders no panel, so the conditional-tooltip pattern (`:tooltip="maybeReason ?? undefined"`) works directly.

**Test guard (planned).** A repo-level sweep that walks every `.vue` file under `dashboard/src/components/`, parses each `<template>` block, and fails the build on raw HTML tags carrying `title=` / `:title=` (PascalCase component tags exempt — their `title` is a component prop). Lands once the in-flight Triage UI rewrite + this rule's first sweep converge. Until then, the rule is doc-only — convert on sight when touching a component.

**When DanxUI does not yet have what you need:** open an issue in `~/web/gpt-manager/danx-ui/` (the source repo of `@thehammer/danx-ui`). Ship the missing primitive THERE, publish, then consume here. Do not fork a one-off in the dashboard.

## Real-time Updates Are Mandatory (DX-227)

Every dashboard composable that owns server state subscribes to `/api/stream` via `useStream`. **No `setInterval` may call into `api.ts`** — server state updates flow through the SSE bus, not a client clock.

The backend pattern: in-process `eventBus` → `/api/stream` SSE topic → composable reducer. New panels must follow this chain — see `useDispatches.ts` (canonical reference), `useAgents.ts`, `useIssues.ts` (post-DX-226).

If the server can't push the event (e.g. external-system pull): add an event source on the worker / dashboard that observes the change (chokidar for files, dispatch-tracker for in-process state, etc.) and publishes through the bus. **Do not add a polling fallback.**

**Allowed:** purely-cosmetic local timers that re-render existing data without a server call. Current allowed examples:

- `dashboard/src/composables/useNowTick.ts` — 60s `setInterval` refreshing `Date.now()` for elapsed-time labels (`AgentCard`'s "running 5m" badge AND broken-banner "Set Nm ago" both share the same ref). Never imports `api.ts`.
- `dashboard/src/components/agents/CriticalFailureBanner.vue` — 1s `setInterval` powering the amber throttle-countdown ("resumes in Nh Nm Ns"). Updates `now.value = Date.now()` only; no fetch.

These never call `fetch*` from `api.ts`. Adding a new cosmetic timer is fine; if it ever needs to call the server, you've crossed the line — convert to SSE.

**Test guards (mandatory, dual layer):**

- **Per-file source check.** Every server-state composable test file carries `expect(source).not.toMatch(/setInterval\s*\(/)` against its own composable file (`useDispatches.test.ts`, `useAgents.test.ts`, `useIssues.test.ts`). Author-local failure message at the composable's eye level — fires the moment a regression lands in a known composable.
- **Repo-level sweep.** `dashboard/src/__tests__/no-poll-imports.test.ts` walks `dashboard/src/composables/*.ts` AND `dashboard/src/components/**/*.vue`, failing the build for any non-allowlisted file that contains `setInterval(` OR a polling-shaped `setTimeout(...fetch|reload|refresh|poll...)`. The exempt allowlist is `useNowTick.ts` + `CriticalFailureBanner.vue` only; allowlisted files are additionally asserted to NOT import from `api.ts` (static or dynamic). The sweep catches new composables / components nobody remembered to lock down.
- **Cosmetic-only escape-hatch lock.** `AgentCard.test.ts` carries a source-check that `AgentCard.vue` does NOT import from `api` — locks the cosmetic-only contract for the canonical client of `useNowTick`.

Both layers stay. The per-file check fires fast on a known regression site; the sweep catches anything new. Removing either reduces signal.

## Architecture

The dashboard is a Vite + Vue 3 + Tailwind CSS 4 SPA in the `dashboard/` directory, with the API server in `src/dashboard/server.ts` on port 5555.

- **Frontend**: `dashboard/` — Vite app with Vue 3 SFCs, TypeScript, Tailwind CSS 4
- **API server**: `src/dashboard/server.ts` — serves REST endpoints, SSE, and built static assets
- **Data**: REST endpoints (`/api/events`, `/api/analytics`) + Server-Sent Events (`/api/stream`)
- **State**: In-memory `MessageEvent[]` array in `src/dashboard/events.ts`, max 500 events

## Development Workflow

ONE command brings the whole dev stack up:

1. `docker compose up -d` — starts MySQL + `dashboard` (API on 5555) + `dashboard-dev` (Vite HMR on **5566**)
2. Open `http://localhost:5566` — HMR-enabled dashboard; `/api/*` + `/health` proxied to the `dashboard` service at `http://dashboard:5555` via the `danxbot-net` network.
3. Edit `.vue` files — changes appear instantly via HMR (no refresh needed)

**Do not** run `npm run dashboard:dev` on the host — the `dashboard-dev` container does it inside compose so the dev stack is reproducible (`VITE_API_TARGET` points at the API service by DNS, not localhost). Running it on the host is redundant and would bind the same 5566.

**Danxbot dev is permanently on 5566.** 5173 is Vite's default and collides with every other Vite-based project on the host (e.g. gpt-manager). 5566 is owned by danxbot and never moves. Do not change `DASHBOARD_DEV_PORT` in docs, scripts, or bookmarks.

## Agent API Access — Auth Token

Dashboard endpoints require `Authorization: Bearer <token>`. Agents working in this repo use a persistent local-dev token at `~/.config/danxbot/dashboard-token` (mode 0600, gitignored by virtue of `$HOME` placement).

### Quick usage

```bash
TOKEN=$(cat ~/.config/danxbot/dashboard-token)
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:5566/api/issues?repo=danxbot
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:5555/api/auth/me   # sanity: {"user":{"username":"monitor"}}
```

### One-time create / rotate

If the token file is missing or `/api/auth/me` returns `401`:

```bash
DANXBOT_CREATE_USER_PASSWORD='<any-password>' make create-user LOCALHOST=1 USERNAME=monitor
# Capture the printed token (shown once), then persist:
mkdir -p ~/.config/danxbot
echo '<token>' > ~/.config/danxbot/dashboard-token
chmod 600 ~/.config/danxbot/dashboard-token
```

Re-running the make target rotates the token (old one invalidated). The `monitor` user is the conventional service account for autonomous agent monitoring; humans should use their own usernames (e.g. `make create-user LOCALHOST=1 USERNAME=dan`).

### Production targets

For `gpt`/etc., swap `LOCALHOST=1` → `TARGET=<t>` and store the token at `~/.config/danxbot/dashboard-token-<target>`. The dashboard host is the Caddy-fronted public URL (e.g. `https://danxbot.sageus.ai`).

## Issue Write API — `PATCH /api/issues/:id?repo=<name>` (DX-236)

Human-driven write surface for issue YAMLs. Auth-gated by per-user bearer (NOT the dispatch token). Allowlisted patch fields:

| Field | Type | Notes |
|---|---|---|
| `status` | `IssueStatus` | Terminal (`Done`/`Cancelled`) moves the file `open/` → `closed/`. Patching to `Blocked` auto-stamps `blocked: {reason: "Manually moved to Blocked via dashboard", timestamp}`; patching off `Blocked` auto-clears `blocked`. `waiting_on` is independent of `status` (pure dispatch gate, durable record) — it is NEVER auto-cleared by a status change. |
| `title` | non-empty `string` | |
| `description` | `string` | |
| `ac` | `IssueAcItem[]` | Full array replace. The SPA round-trips existing `check_item_id`s so the worker's tracker push edits in place. |
| `comments_append` | `{text}` | Server stamps `author` (auth user) + `timestamp` (now ISO). Client-supplied `author`/`timestamp`/`id` are ignored. |
| `requires_human` | `RequiresHuman \| null` | Server stamps `set_by: "human"` + `set_at: now`; client cannot fake `set_by`. |
| `reopen` | `true` | Move `closed/<id>.yml` → `open/<id>.yml`. Defaults `status: "ToDo"` unless paired with one of `Review`/`ToDo`/`In Progress`/`Blocked`. |

Any other field returns `400 {error: "Field not patchable: <name>"}`. Empty patch returns `400`. Atomic temp+rename — no partial-state residue on validation failure. Per-id mutex inside the dashboard process serializes concurrent writers on the SAME card; cross-process (agent + dashboard) is last-writer-wins, same as agent-vs-poller.

Successful writes publish the `issue:updated` SSE topic with the post-patch `Issue` so subscribers update without a refetch — the worker's chokidar mirror still fires later (5s `awaitWriteFinish` debounce) and re-affirms via DB; subscribers MUST be idempotent.

Quick smoke:

```bash
TOKEN=$(cat ~/.config/danxbot/dashboard-token)
curl -sS -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Renamed"}' \
  "http://localhost:5566/api/issues/DX-1?repo=danxbot"
```

## Two Dev URLs

| URL | Serves | When to use |
|-----|--------|-------------|
| `http://localhost:5566` | Vite dev server — live source with HMR | Active development; changes appear immediately |
| `http://localhost:5555` | API + the baked `dashboard/dist/` bundle | Verify production-style behavior; API testing |

5566 proxies API calls to 5555, so the Agents tab, dispatches list, auth — everything functions at :5566 identically to :5555.

## When to Restart / Rebuild

- **Vue/CSS changes**: Handled by Vite HMR — no restart
- **Backend TypeScript** (any `src/**/*.ts` the dashboard container imports — `src/dashboard/*.ts`, `src/agent/*.ts`, etc.): NO restart needed. The dashboard container runs `tsx watch src/index.ts` (default cmd in `entrypoint.sh:116` → `npm start`); `./src` is bind-mounted RW into the container; tsx watch auto-reloads the node process on file change. Confirm with `docker exec danxbot-dashboard-1 ps -ef | grep tsx`. Only force-recreate when something OUTSIDE `src/` changes (entrypoint.sh, tsconfig.json, env-file values not re-read at runtime).
- **New dependencies** (package.json): `docker compose up -d --build`
- **Dashboard dist/ for :5555**: `npm run dashboard:build` from repo root (or `docker compose up -d --build dashboard` to rebake the image)

## Production

Prod uses `deploy/templates/docker-compose.prod.yml`, which has NO `dashboard-dev` service. Prod serves the SPA directly from the API container via the baked `dashboard/dist/` bundle. Dev-only Vite is never shipped to prod.

## Testing

The dashboard has its own `vitest.config.ts` in the `dashboard/` directory (happy-dom environment, `include: ["src/**/*.test.ts"]`). Running vitest from the repo root only picks up backend tests at `src/**/*.test.ts` — dashboard tests are invisible from there.

- Run all dashboard tests: `cd dashboard && npx vitest run`
- Run one dashboard test file: `cd dashboard && npx vitest run src/composables/useAuth.test.ts`
- Type-check Vue SFCs: `cd dashboard && npx vue-tsc --noEmit`

Full pipeline verification should hit BOTH suites:

    npx vitest run                            # backend (~1600 tests)
    cd dashboard && npx vitest run            # dashboard (~50 tests)
    npx tsc --noEmit                          # backend types
    cd dashboard && npx vue-tsc --noEmit      # SPA types

The dashboard vitest config sets `restoreMocks: true`, so `vi.spyOn` mocks auto-reset between tests — unlike the backend config. Don't add redundant `vi.restoreAllMocks()` in dashboard test `afterEach` unless you're also clearing explicit `mockImplementation`s.

## Key Files

| Path | Purpose |
|------|---------|
| `dashboard/src/App.vue` | Root component, wires composables to components |
| `dashboard/src/composables/useEvents.ts` | Core state: events, SSE, filtering |
| `dashboard/src/composables/useTheme.ts` | Dark mode toggle + persistence |
| `dashboard/src/components/` | All UI components (SFCs) |
| `dashboard/src/api.ts` | Typed fetch wrappers + SSE connection |
| `dashboard/src/types.ts` | Re-exports types from backend |
| `src/dashboard/server.ts` | HTTP server: API routes + static file serving |
| `src/dashboard/events.ts` | Event state, SSE broadcasting, analytics |

## Event Data Flow

1. `src/slack/listener.ts` calls `createEvent()` when a message arrives
2. `updateEvent()` is called at each stage: routing → routed → agent_running → complete
3. Each `updateEvent()` broadcasts via SSE to all connected dashboard clients
4. The Vue app updates the table and detail panel in real-time
