# Preview URL — `/preview/:dispatchId/:templateId/<tail>`

Public, dispatch-scoped iframe entry point for the live template preview served by a worker's per-template Vite dev server. Documented as **the** contract surface for 3rd-party iframe embeds; no other danxbot URL is supported for that purpose.

## URL Shape

```
GET https://<dashboard>/preview/<dispatchId>/<templateId>[/<tail>][?sig=<hex>&exp=<epochMs>]
```

| Segment | Meaning |
|---|---|
| `<dispatchId>` | Dispatch row id (UUID) — the dispatch that owns / co-owns the active HMR session for this template. Surfaces to 3rd parties via the dispatch row (`TemplateDefinition.live_preview_dispatch_id` in gpt-manager). |
| `<templateId>` | Numeric template id (matches what the worker keys HMR entries on). |
| `<tail>` | Optional path forwarded verbatim to the Vite dev server (HTML, assets, source files). Empty tail → `/`. |
| `?sig=<hex>` + `?exp=<epochMs>` | Optional signed-URL params. See **Auth** below. |

Example iframe embed (gpt-manager side):

```php
$exp = (now()->addHour())->getTimestampMs();
$sig = hash_hmac(
    'sha256',
    "{$dispatchId}:{$templateId}:{$exp}",
    config('services.danxbot_gpt_manager.dispatch_token'),
);
$url = "https://danxbot.sageus.ai/preview/{$dispatchId}/{$templateId}?sig={$sig}&exp={$exp}";

// <iframe src="{$url}"></iframe>
```

## Auth — three accepted forms

The proxy admits any one of:

1. **`Authorization: Bearer <DANXBOT_DISPATCH_TOKEN>`** — server-to-server calls (curl, gpt-manager backend probes). Same bearer the dispatch proxy uses; a bad bearer is rejected outright (no silent fall-through to other forms).
2. **Authenticated dashboard session cookie** — operators browsing `https://<dashboard>/preview/...` directly. Any valid user is admitted.
3. **Signed query: `?sig=<hex>&exp=<epoch-ms>`** — iframe-friendly. The consumer holds the dispatch token, computes `HMAC-SHA256(token, "${dispatchId}:${templateId}:${exp}")`, appends `sig` + `exp` to the URL, and hands the URL to the end-user's browser. The dashboard re-derives the HMAC and constant-time compares; admits the request iff `Date.now() <= exp`. End users never see the raw token — only a single-purpose per-(dispatch, template, exp) signature.

**Pick the signed-query form for production iframe embedding.** Passing the raw dispatch token in a URL query risks web-server-log leakage + browser-history retention. The signed form expires; the raw bearer does not.

`exp` lifetime is **consumer-controlled** — pick the shortest value your UX allows. Typical: 1 h for a session-lifetime preview iframe.

## Lifecycle / Status Codes

| Cause | Status |
|---|---|
| Auth fails (no header / bad bearer / bad signature / expired `exp`) | `401` |
| Dispatch ID unknown | `404` |
| Dispatch is terminal (`completed` / `failed` / `cancelled` / `recovered` / `throttled`) | `404` |
| Worker has no active HMR server for the templateId | `404` |
| HMR is up but the request's `dispatchId` is NOT a current ref-holder | `404` |
| Worker resolves but TCP connect to Vite port fails | `502` |
| Vite responds with an error status | passed through verbatim |
| Vite is up but slow (> 30 s per request) | `504` |

All 404 responses carry the same JSON shape (`{error: "<reason>"}`); iframe consumers render their own fallback regardless of the inner cause. The error text is intentionally generic — verbose distinctions leak internal topology.

## Binary Safety

The proxy passes request and response bodies through as raw `Buffer`s — no UTF-8 coercion anywhere on the path. Vite assets (PNG, woff2, JPEG, etc.) round-trip byte-exact. This matches `playwright-proxy.ts`; **do not** route preview traffic through `dispatch-proxy.ts#proxyToWorker` (JSON-only).

## WebSocket / HMR Live-Reload — Known Limitation

The v1 proxy is **HTTP-only**. Vite's HMR transport uses a WebSocket upgrade on the same port; the proxy does NOT forward `Upgrade: websocket` handshakes today.

Practical impact:

- The iframe loads the live preview HTML + assets normally.
- File changes on the worker side trigger Vite to push a reload to its WS subscribers. With no proxied WS connection, the iframe falls back to Vite's polling-reload behavior, which is a full page refresh on the next navigation event.
- The iframe does **not** receive hot-module-replacement deltas without a full reload.

If hot-module-replacement is needed end-to-end, a follow-up phase adds WS upgrade forwarding (Node's `'upgrade'` event on the HTTP server, raw socket pipe). The v1 contract is sufficient for "iframe shows current state on load, refreshes on demand."

## Comparison to the Pre-DX-670 Pattern

Before DX-670:

1. Consumer (gpt-manager `TemplatePreviewService`) called `GET <worker>/api/template-hmr/active?templateId=X` to discover the Vite port.
2. Consumer constructed an iframe URL pointing directly at the worker's exposed Vite port.

After DX-670:

1. Consumer constructs `<dashboard>/preview/<dispatch>/<template>` deterministically from data it already holds (`live_preview_dispatch_id` + `template_id`).
2. Dashboard handles dispatch lookup, worker resolution, HMR discovery, and proxy internally.

Reasons:

- Worker probe was a back-channel call — removed in Epic SG-194 Phase 4.
- Direct iframe-to-worker URL leaked worker network topology (container hostnames, port allocations) to the end-user's browser.

## Related Files

- `src/dashboard/preview-proxy.ts` — handler + signature helpers + production deps factory.
- `src/dashboard/preview-proxy.test.ts` — unit tests covering auth, lifecycle, binary safety.
- `src/dashboard/server.ts` — route wiring (`GET /preview/...`).
- `src/worker/template-hmr-route.ts` — upstream `GET /api/template-hmr/active` the dashboard calls.
- `src/template-hmr/server.ts` — Vite child lifecycle + ref-counting.
