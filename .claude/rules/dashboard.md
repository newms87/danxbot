# Dashboard

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

## Two Dev URLs

| URL | Serves | When to use |
|-----|--------|-------------|
| `http://localhost:5566` | Vite dev server — live source with HMR | Active development; changes appear immediately |
| `http://localhost:5555` | API + the baked `dashboard/dist/` bundle | Verify production-style behavior; API testing |

5566 proxies API calls to 5555, so the Agents tab, dispatches list, auth — everything functions at :5566 identically to :5555.

## When to Restart / Rebuild

- **Vue/CSS changes**: Handled by Vite HMR — no restart
- **Backend TypeScript** (`src/dashboard/*.ts`): `docker compose up -d --force-recreate dashboard` (HMR doesn't cover the API)
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
