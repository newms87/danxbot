# Template Build Callback Contract

**Status.** Phase 1 schema-only deliverable for epic SG-194 (Decouple gpt-manager ↔ danxbot template build flow). No code changes ship with this doc — Phase 2 (Laravel receiver) and Phase 3 (MCP build + callback) implement against it.

**Shared.** This document is the canonical source. The danxbot repo mirrors it verbatim at `<danxbot>/docs/specs/launch-callback-contract.md`. Any change here MUST be mirrored there in the same PR.

## 1. Why a callback channel exists

gpt-manager launches a danxbot agent session via `POST /api/launch` (and `POST /api/resume` for continuations). Inside the sandbox the agent edits source files, runs a build, and reaches a "save" moment.

Before this contract: gpt-manager polled or the agent called a pre-existing schema MCP endpoint to deliver finished work — multiple paths, no single source of truth, brittle.

After this contract: when the agent saves, it POSTs one atomic `{source[], dist[], hashes}` payload from inside the sandbox back to gpt-manager via the `callback_url` carried on the launch. One channel, one shot, well-defined retry + idempotency.

## 2. Endpoints

| direction | endpoint | added/changed |
|---|---|---|
| gpt-manager → danxbot | `POST /api/launch` | body adds `callback_url` + `callback_token` (REQUIRED) |
| gpt-manager → danxbot | `POST /api/resume` | body inherits `callback_url` + `callback_token` identically |
| MCP-in-sandbox → gpt-manager | `POST <callback_url>` | NEW receiver, implemented in Phase 2 |

The `<callback_url>` value is opaque to danxbot — danxbot forwards it to the agent verbatim and never parses it. By convention gpt-manager issues it as `https://<gpt-manager-host>/api/template-callback/<dispatch_id>`, but the contract does not depend on path shape.

## 3. Launch payload additions

`POST /api/launch` body (gpt-manager → danxbot). Existing fields preserved; two new REQUIRED fields:

```jsonc
{
  "task": "<user prompt>",
  "workspace": "schema-builder",
  "app_files": [
    { "path": "App.vue", "content": "..." }
  ],

  // NEW — required for any launch that may invoke template_save:
  "callback_url":   "https://<gpt-manager-host>/api/template-callback/<dispatch_id>",
  "callback_token": "<bearer>"
}
```

| field | type | required | notes |
|---|---|---|---|
| `callback_url` | string (absolute URL) | yes | Where the agent POSTs `{source[], dist[]}` on save. Opaque to danxbot. |
| `callback_token` | string | yes | Bearer credential. Reuses the existing `AgentDispatch.api_token` value gpt-manager issues for the dispatch — no separate token issuance. Same secret authorizes both directions (gpt-manager → danxbot MCP reads + MCP → gpt-manager callback writes). |

### 3.1 Resume payload inheritance

`POST /api/resume` body MUST accept and forward the same two fields identically. A resume preserves callback identity — the agent in the resumed sandbox calls the same `callback_url` with the same `callback_token` as the original launch.

If a resume body omits the fields, danxbot SHOULD reject with `400 missing_callback_fields` (cannot infer from prior launch — stateless API surface).

## 4. Callback request shape (MCP → gpt-manager)

```jsonc
POST <callback_url>
Authorization: Bearer <callback_token>
Content-Type: application/json
{
  "source": [
    { "path": "App.vue",       "content": "..." },
    { "path": "components/Foo.vue", "content": "..." }
  ],
  "dist": [
    { "path": "index.html",          "content_base64": "..." },
    { "path": "assets/index-abc.js", "content_base64": "..." }
  ],
  "source_hash": "sha256:<hex>",
  "build_hash":  "sha256:<hex>",
  "ok":          true,
  "error":       null,
  "build_duration_ms": 4231
}
```

| field | type | required | notes |
|---|---|---|---|
| `source[]` | array of `{path, content}` | yes when `ok=true` | Every source file the agent considers part of the template, relative paths (forward slashes). Plain UTF-8 strings — JSON-safe. |
| `dist[]` | array of `{path, content_base64}` | yes when `ok=true` | Build output. Base64-encoded to safely carry binary (images, fonts, sourcemaps) without per-file content-type negotiation. |
| `source_hash` | string `sha256:<hex>` | yes when `ok=true` | sha256 over a deterministic serialization of `source[]` (path-sorted, `\n`-joined `path\0content` records). Used for source-equality checks. |
| `build_hash` | string `sha256:<hex>` | yes when `ok=true` | sha256 over a deterministic serialization of `dist[]` (path-sorted, `\n`-joined `path\0base64(content)` records). **Idempotency key — see §6.** |
| `ok` | bool | yes | Whether the build succeeded. `false` = build failed inside sandbox; receiver records the failure and does not persist artifacts. |
| `error` | string \| null | yes | Human-readable error message when `ok=false`. Null when `ok=true`. |
| `build_duration_ms` | int | yes | Wall-clock build time in ms. Telemetry only — receiver does not gate on this. |

### 4.1 Receiver response

```jsonc
// 200 OK — accepted (new or idempotent duplicate)
{ "ok": true, "build_hash": "sha256:<hex>", "duplicate": false }

// 200 OK — duplicate of a previously-accepted build (see §6)
{ "ok": true, "build_hash": "sha256:<hex>", "duplicate": true }

// 4xx — validation failure
{ "ok": false, "errors": ["payload_too_large", "missing_source_hash"] }

// 5xx — receiver internal error (retryable, see §7)
{ "ok": false, "error": "<message>" }
```

Receiver MUST be deterministic on a given `build_hash` — same hash in twice returns `duplicate: true` the second time, regardless of payload body.

## 5. Payload size ceiling

**5 MB** total JSON body size. Decided after weighing:

- Typical SFC template source + dist after base64 sits well under 1 MB.
- Headroom for larger templates (image assets, multiple chunks) without forcing tarball streaming this phase.
- Above ~5 MB, JSON parsing latency + memory pressure on the receiver become real; if templates routinely exceed it we revisit with a tarball / multipart upload variant rather than raising the JSON ceiling.

Receiver behavior on oversize:

- danxbot's reverse proxy and the receiver's Laravel route both cap `client_max_body_size` / `post_max_size` at 5 MB.
- Receiver returns `413 Payload Too Large` (NOT 4xx with `payload_too_large`) so size violations are distinguishable from schema validation failures in agent retry logic.

Agent behavior on `413`: do NOT retry the same payload. Surface the failure on `template_save` envelope; operator path is to split the template or revisit the ceiling.

## 6. Idempotency

**Natural key: `build_hash`.** No separate idempotency-key header.

Receiver semantics:

- First `build_hash` seen → persist `source[]` + `dist[]` to S3, update `last_build_hash` on the owning template row, return `{ok: true, duplicate: false}`.
- Same `build_hash` again on the same dispatch (or any dispatch for the same template) → no writes, return `{ok: true, duplicate: true}`. Receiver MUST NOT re-upload identical bytes.
- Build failures (`ok: false`) are NOT keyed — the receiver records the failure attempt independently. Two consecutive failures with the same error are two distinct records.

Why `build_hash` and not a separate uuid:

- The hash is a structural property of the artifact, not the call. A retried callback after a network blip carries the same hash and SHOULD be idempotent.
- Reduces agent state — no need to remember "which uuid did I send last time?" across resume boundaries.
- Source-changed-but-dist-identical is rare in practice (Vite emits same dist on same source); when it happens, treating it as duplicate is the desired outcome (no churn).

Receiver storage rules:

- `source_hash` is recorded alongside `build_hash` but is NOT the idempotency key — two different source trees CAN produce the same dist (whitespace-only source diff), and we want a write in that case.
- Therefore the dedup check is `build_hash` only. If a duplicate `build_hash` arrives with a different `source_hash`, log a warning + return `duplicate: true` (keep first-write-wins on `source[]`).

## 7. Retry policy

**Agent (callback caller).** When the receiver returns 5xx OR a transport-level failure (connect timeout, read timeout, TLS error):

- Attempts: 3 total (1 initial + 2 retries).
- Backoff: exponential, 1 s → 2 s → 4 s, with up to 250 ms jitter on each interval.
- Per-attempt timeout: 30 s.
- Total budget: ~40 s wall clock.

After the third failure, surface the failure on the `template_save` MCP envelope:

```jsonc
{ "ok": false, "error": "callback_unreachable", "details": { "attempts": 3, "last_status": 502 } }
```

The agent does NOT retry on:

- 2xx (success — terminal).
- 4xx (validation — payload is malformed; retrying without changing it is pointless).
- `413` (size cap — see §5).

The agent DOES retry on:

- 5xx (5 series of any kind).
- Connection / TLS / DNS errors (status code = 0 equivalent).
- Receiver returning `{ok: false, error}` with HTTP 5xx envelope (the JSON body is informative; the status code is the gate).

**Receiver (gpt-manager).** Does not retry by itself; the agent owns the retry side. The receiver MUST be safely retryable — idempotency via `build_hash` (§6) is what makes that safe.

## 8. Auth

`Authorization: Bearer <callback_token>`. The token value equals the `callback_token` field gpt-manager sent on the original launch (or resume).

- Receiver validates the token against the dispatch row identified by the URL's `<dispatch_id>` segment. Mismatch → `401 invalid_callback_token`.
- Tokens are scoped per dispatch — leaking one token leaks one dispatch's callback channel, not the whole tenant.
- Rotation on resume: the token MAY rotate on resume if gpt-manager issues a new `api_token`; the resume body carries the new value, and the receiver accepts EITHER the old or the new for a short overlap window (decided in Phase 2 implementation — recommend 60 s).

## 9. Open questions resolved

| question | resolution |
|---|---|
| Payload size ceiling | 5 MB JSON body cap (§5). Tarball / multipart variant deferred to a follow-up if real templates exceed it. |
| Error response shape on build failure | `{ok: false, error: "<msg>"}` in the callback body when the SANDBOX build failed; receiver still 200s the request because the call itself succeeded (telemetry write). 4xx/5xx is reserved for transport / validation / receiver-side errors. |
| Retry behavior on callback 5xx | 3 attempts, exponential backoff 1/2/4 s, 30 s per-attempt timeout (§7). |
| Idempotency key | `build_hash` natural key, no separate uuid (§6). |
| Resume body shape | Inherits `callback_url` + `callback_token` identically (§3.1). |
| Auth model | `Bearer <callback_token>` = reused `AgentDispatch.api_token`; receiver validates against the dispatch row identified by URL (§8). |

## 10. Out of scope for Phase 1

- Receiver implementation (Phase 2 — Laravel route, S3 write paths, `last_build_hash` column update, validation tests).
- MCP `template_save` rework — vite build + callback POST (Phase 3).
- Deletion of the legacy `POST /api/template-build` worker route, `DanxbotBuildClient`, `SfcTemplateBuilder::runRemoteBuild` (Phases 4/5).

## 11. Verification (Phase 1 done-when)

- This file exists at `docs/guides/TEMPLATE_BUILD_CALLBACK.md` in gpt-manager.
- An identical copy exists at `docs/specs/launch-callback-contract.md` in danxbot (mirrored verbatim — see §0).
- Every open question listed in §9 has a one-row resolution.
- No code shipped in this phase — `git diff --stat` is docs-only on both repos.

## 12. Cross-repo mirror reminder

When editing this contract, the operator (or a follow-up action-item card) MUST mirror the change to `<danxbot>/docs/specs/launch-callback-contract.md`. Identical content; divergence is a contract violation.
