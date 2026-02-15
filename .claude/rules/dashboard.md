# Dashboard

## Architecture

The dashboard is a Vite + Vue 3 + Tailwind CSS 4 SPA in the `dashboard/` directory, with the API server in `src/dashboard/server.ts` on port 5555.

- **Frontend**: `dashboard/` — Vite app with Vue 3 SFCs, TypeScript, Tailwind CSS 4
- **API server**: `src/dashboard/server.ts` — serves REST endpoints, SSE, and built static assets
- **Data**: REST endpoints (`/api/events`, `/api/analytics`) + Server-Sent Events (`/api/stream`)
- **State**: In-memory `MessageEvent[]` array in `src/dashboard/events.ts`, max 500 events

## Development Workflow

1. `docker compose up -d` — starts backend API on port 5555
2. `npm run dashboard:dev` — starts Vite dev server on port 5173 with HMR
3. Open `http://localhost:5173` — full HMR development, API proxied to 5555
4. Edit `.vue` files — changes appear instantly via HMR (no refresh needed)

## When to Restart

- **Vue/CSS changes**: Handled by Vite HMR — no restart needed
- **Backend TypeScript** (`src/dashboard/*.ts`): `docker compose up -d --force-recreate`
- **New dependencies**: `docker compose up -d --build`

## Production Build

Port 5555 serves the last production build from `dashboard/dist/`. The Docker build step runs `cd dashboard && npm run build` automatically.

To rebuild manually: `npm run dashboard:build`

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
