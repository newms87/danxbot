# Danxbot Service Surface (3rd-Party Contract)

This rule pins the **3rd-party-facing API** of danxbot. A "3rd party" here is any consumer service (gpt-manager today; future fork consumers) that integrates with danxbot via HTTP. Internal-only routes (dashboard UI, worker bookkeeping, the dashboard's own preview proxy when called by the dashboard's own browser) are NOT contract surface and may change without consumer sign-off.

## The contract surface

Three caller / surface pairs. Any new 3rd-party-facing endpoint requires a contract change AND consumer sign-off — not just a route registration.

| Caller | Surface | Verbs |
|---|---|---|
| 3rd-party consumer service → danxbot worker | `POST /api/launch`, `POST /api/resume`, `POST /api/cancel/:job` | Launch / resume / cancel a dispatch. The launch payload carries `callback_url` + `callback_token` so the in-sandbox agent can return finished work to the consumer. |
| Browser → danxbot dashboard | `<dashboard>/preview/<dispatch>/<template>` | Iframe-friendly preview URL pattern. End-user browsers (typically embedded in the consumer's UI) load this URL directly. The dashboard handles its own auth on this path. |
| In-sandbox agent / MCP → 3rd-party consumer | `POST <callback_url>` (consumer-owned URL passed in via `/api/launch` body) | The agent POSTs finished `{source[], dist[], hashes}` back to the consumer's receiver. The URL is opaque to danxbot — danxbot forwards it verbatim and never parses it. Auth is the `callback_token` from the launch payload. |

That is the whole 3rd-party surface. Everything else is internal.

## Internal-only routes (NOT contract surface)

These exist for danxbot's own operation. Document each one's intended caller inline; 3rd-party consumers MUST NOT call them — if a consumer is calling one of these, that is a boundary leak in the consumer (see `<gpt-manager>/.claude/rules/danxbot-boundary.md` for the gpt-manager-side rule).

- `POST /api/template-build` — historical: gpt-manager called this before SG-194. Retained for transitional fallback only; the new flow runs vite inside the MCP sandbox and POSTs to the consumer's callback. No new consumers may bind to this endpoint.
- `GET /api/template-build/recent` — debug surface; dashboard-only.
- `POST /api/restage/:dispatchId` — mid-dispatch source restage; intended for the worker's own use during retry.
- `GET /api/template-hmr/active` — sandbox-internal HMR state probe; dashboard-only for the preview proxy.
- `GET|POST /api/playwright/*` — dashboard preview proxy's binary-safe path; consumer browsers do NOT hit this directly. The dashboard owns it.
- `GET /api/health`, `GET /api/jobs`, `POST /api/cancel`, `POST /api/stop`, `POST /api/clear-critical-failure`, `POST /api/restart`, `POST /api/slack/*` — operator + worker bookkeeping.

## Adding a new 3rd-party-facing endpoint

1. The endpoint must satisfy a use case the three contract verbs + the callback channel cannot.
2. The contract change ships first as a doc edit (here + a mirrored note in the consumer's boundary rule).
3. Consumer sign-off is recorded on the contract-change card.
4. Only then does the route land.

## Why this surface exists

danxbot's value is "launch a dispatched Claude Code session and return finished work." Three verbs cover the entire lifecycle of that responsibility. Any consumer reaching for a fourth verb is either reinventing the contract (back-channel) or asking danxbot to do something outside its responsibility — push back, do not extend.
