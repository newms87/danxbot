# Dashboard

## How It Works

The dashboard is a single HTML file (`src/dashboard/index.html`) served by a Node.js HTTP server (`src/dashboard/server.ts`) on port 5555.

- **Frontend**: Vue 3 + Tailwind CSS loaded from CDN, all inline in the HTML file
- **Data**: REST endpoints (`/api/events`, `/api/analytics`) + Server-Sent Events (`/api/stream`) for live updates
- **State**: In-memory `MessageEvent[]` array in `src/dashboard/events.ts`, max 500 events

## HTML is Served from src/

The server reads `index.html` from disk on every request using a path relative to `import.meta.url`. Since the bot runs via `tsx` (not compiled JS), this resolves to `src/dashboard/index.html`.

HTML changes are visible immediately on browser refresh — no restart needed.

TypeScript changes (`events.ts`, `server.ts`) require a container restart.

## Event Data Flow

1. `src/slack/listener.ts` calls `createEvent()` when a message arrives
2. `updateEvent()` is called at each stage: routing → routed → agent_running → complete
3. Each `updateEvent()` broadcasts via SSE to all connected dashboard clients
4. The Vue app updates the table and detail panel in real-time
