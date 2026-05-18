/**
 * DX-670 — Dashboard `/preview/:dispatchId/:templateId/<tail>` reverse proxy.
 *
 * Public, dispatch-scoped iframe entry point for the live template preview
 * served by the worker's per-template Vite dev server (`src/template-hmr/`).
 * Third-party consumers (gpt-manager's `TemplatePreviewService`) embed the
 * URL directly in an `<iframe>`; the dashboard resolves the dispatch, finds
 * the worker running it, asks that worker for the active HMR server keyed
 * by `templateId`, and forwards the request to the Vite child binary-safely.
 *
 * Why this exists: before DX-670, gpt-manager called `GET <worker>/api/
 * template-hmr/active?templateId=X` to discover the Vite port, then
 * constructed an iframe URL pointing directly at the worker's exposed port.
 * That coupled the consumer to danxbot's internal network topology (worker
 * hostnames, port allocations, dispatch-token routing) and forced the
 * worker to expose Vite externally. After DX-670 the URL is stable and
 * topology-free: `<dashboard>/preview/<dispatch>/<template>` is the only
 * surface a 3rd party knows.
 *
 * # Auth — three accepted forms
 *
 * 1. **`Authorization: Bearer <DANXBOT_DISPATCH_TOKEN>`** — programmatic
 *    callers (curl, server-side fetches). Same band as the dispatch proxy.
 * 2. **Authenticated dashboard session** — operator browsing the preview
 *    directly. `requireUser` is consulted; any valid user passes.
 * 3. **Signed query: `?sig=<hex>&exp=<epoch-ms>`** — iframe-friendly. The
 *    consumer (gpt-manager) holds the dispatch token, computes
 *    `HMAC-SHA256(token, "${dispatchId}:${templateId}:${exp}")`, appends
 *    `sig` + `exp` to the URL, hands the URL to the end user's browser.
 *    Browser opens the iframe; dashboard re-derives the HMAC, constant-
 *    time compares, and admits the request if `Date.now() <= exp`. The
 *    end user never sees the dispatch token — only the per-(dispatch,
 *    template, exp) signature. Default lifetime: consumer-controlled;
 *    typical 1h.
 *
 * The signed-query path is recommended for production iframe embedding —
 * sharing the raw dispatch token via a URL query param risks
 * web-server-log leakage and browser-history retention. The Bearer + user
 * session paths exist for direct programmatic / operator use.
 *
 * Use `signPreviewUrl()` (exported) to generate the `sig` / `exp` pair on
 * the consumer side. Same routine, same secret, same delimiter — using
 * the export keeps consumers in sync with the verifier mechanically.
 *
 * # Lifecycle / 404 semantics
 *
 * | Cause | Status |
 * |---|---|
 * | Auth fails (no header / bad bearer / bad signature / expired exp) | `401` |
 * | Dispatch ID unknown | `404` |
 * | Dispatch is terminal (completed / failed / cancelled / recovered / throttled) | `404` |
 * | Worker has no HMR server for the templateId | `404` |
 * | HMR is up but THIS dispatch is not in `refDispatchIds[]` | `404` |
 * | Worker resolves but TCP connect to Vite port fails | `502` |
 * | Vite responds with an error status | passed through verbatim |
 *
 * Note 404 is intentionally **not** distinguished — the iframe consumer
 * only needs "live preview?" yes/no. Verbose error bodies leak internal
 * topology; a tight `{error}` JSON keeps the surface narrow.
 *
 * # Binary safety
 *
 * Vite serves HTML, JS, CSS, fonts, images (.svg, .png, .woff2). PNG/woff2
 * bytes MUST round-trip byte-exact through the proxy. This module follows
 * the same pattern as `playwright-proxy.ts`: every body crosses the wire
 * as `Buffer`, never coerced through UTF-8. Do NOT route any preview
 * traffic through `dispatch-proxy.ts#proxyToWorker` — that path
 * `.toString("utf-8")`s the upstream body and silently corrupts non-text
 * payloads.
 *
 * # WebSocket / HMR live-reload
 *
 * This module is HTTP-only. Vite's HMR transport uses a WebSocket upgrade
 * on the same port; this proxy does NOT forward the `Upgrade: websocket`
 * handshake. Practical impact: the iframe loads the live preview and
 * picks up file changes via full reload (HMR client falls back to a
 * polling reload when its WS can't connect to the proxy origin), but
 * does NOT receive hot-module updates without a full page refresh.
 * Acceptable for the v1 contract; a follow-up phase adds WS upgrade
 * support if the operator-side experience needs hot updates.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { request as httpRequest } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { createLogger } from "../logger.js";
import { json } from "../http/helpers.js";
import { checkAuth, extractBearer } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";

const log = createLogger("preview-proxy");

/** Default per-request overall timeout (connect + read). Vite asset
 * loads + HTML render are typically <100ms on a warm dev server; 30s is
 * generous headroom for a cold restart racing the first iframe load. */
export const PREVIEW_DEFAULT_TIMEOUT_MS = 30_000;

/** Terminal dispatch statuses — preview is rejected for these. Mirrors
 * `dispatches.ts#TERMINAL_STATUSES` but inlined to avoid a cross-module
 * import that pulls in the DB layer for tests of this module. */
const TERMINAL_DISPATCH_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "recovered",
  "throttled",
]);

/** Minimal dispatch shape this proxy needs. The dashboard's full
 * `Dispatch` interface carries dozens of fields — the proxy only
 * cares about repo routing + terminal-state gating. */
export interface PreviewDispatchInfo {
  id: string;
  repoName: string;
  status: string;
}

/** Worker location for a given repo. */
export interface PreviewWorkerLocation {
  host: string;
  port: number;
}

/** HMR-info subset returned by the worker's `/api/template-hmr/active`. */
export interface PreviewHmrInfo {
  port: number;
  refDispatchIds: readonly string[];
}

export interface PreviewProxyDeps {
  /** Shared with dispatch-proxy — the `DANXBOT_DISPATCH_TOKEN`. */
  token: string;
  /** Resolve a dispatch by id from the DB. Returns null when the id is unknown. */
  getDispatch: (id: string) => Promise<PreviewDispatchInfo | null>;
  /** Resolve the reachable `{host, port}` for the named repo's worker.
   * Returns null when the repo is unknown OR every candidate host failed
   * the reachability probe. */
  resolveWorker: (repoName: string) => Promise<PreviewWorkerLocation | null>;
  /** Ask the worker for the active HMR record keyed by templateId. Returns
   * null when the worker has no active HMR for that templateId. */
  fetchHmrInfo: (
    worker: PreviewWorkerLocation,
    templateId: string,
  ) => Promise<PreviewHmrInfo | null>;
  /** Optional override; defaults to `PREVIEW_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Compute the HMAC-SHA256 signature carried in the `?sig=` query param.
 * Exported so consumers (gpt-manager's `TemplatePreviewService`) can sign
 * URLs using the same routine the verifier runs — single source of truth
 * for the digest input ordering and delimiter.
 */
export function signPreviewUrl(
  dispatchId: string,
  templateId: string,
  expEpochMs: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${dispatchId}:${templateId}:${expEpochMs}`)
    .digest("hex");
}

/**
 * Verify a `?sig=<hex>&exp=<epoch-ms>` pair against the dispatch token.
 * Returns true iff both fields are well-formed, `exp` is in the future,
 * and the HMAC matches in constant time. Any malformed input → false.
 */
export function verifyPreviewSignature(
  dispatchId: string,
  templateId: string,
  sig: string | null,
  expRaw: string | null,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !sig || !expRaw) return false;
  if (!/^[0-9a-f]+$/i.test(sig)) return false;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (nowMs > exp) return false;
  const expected = signPreviewUrl(dispatchId, templateId, exp, secret);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf-8"),
    Buffer.from(sig, "utf-8"),
  );
}

/** Authorization outcome — pre-computed so the handler can branch once. */
type AuthOutcome =
  | { ok: true; via: "bearer" | "user" | "signature" }
  | { ok: false; status: 401 | 500; message: string };

async function authorize(
  req: IncomingMessage,
  url: URL,
  dispatchId: string,
  templateId: string,
  deps: PreviewProxyDeps,
): Promise<AuthOutcome> {
  if (!deps.token) {
    return {
      ok: false,
      status: 500,
      message:
        "DANXBOT_DISPATCH_TOKEN is not configured on this dashboard — preview is disabled",
    };
  }

  // Form 1: Bearer header against the dispatch token. checkAuth is
  // constant-time and returns a structured failure reason.
  const bearer = extractBearer(req.headers["authorization"]);
  if (bearer) {
    const verdict = checkAuth(req, deps.token);
    if (verdict.ok) return { ok: true, via: "bearer" };
    // Wrong bearer → 401. Falling through to user/signature is allowed
    // only when the bearer is ABSENT; an explicit bad bearer is rejected
    // so token-typo attacks don't shop the three auth bands.
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  // Form 2: dashboard user session (cookie). Browsers visiting the
  // preview URL directly with an active dashboard tab open get in this
  // way without the consumer needing to mint anything.
  const userAuth = await requireUser(req);
  if (userAuth.ok) return { ok: true, via: "user" };

  // Form 3: signed query param. The consumer pre-mints a URL with
  // `?sig` + `?exp` and hands it to the end user; the dashboard
  // re-derives the HMAC and constant-time compares.
  const sig = url.searchParams.get("sig");
  const exp = url.searchParams.get("exp");
  if (
    verifyPreviewSignature(dispatchId, templateId, sig, exp, deps.token)
  ) {
    return { ok: true, via: "signature" };
  }

  return { ok: false, status: 401, message: "Unauthorized" };
}

/**
 * Strip the signed-URL params from a query string before forwarding to
 * the upstream Vite. Vite doesn't care about them, but leaking them
 * onward bloats the request and risks accidental log retention upstream.
 */
function stripSignatureParams(search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  next.delete("sig");
  next.delete("exp");
  const out = next.toString();
  return out ? `?${out}` : "";
}

/**
 * Handle a `GET /preview/:dispatchId/:templateId/<tail>` request. The
 * caller is responsible for parsing the path params + tail; this
 * function owns auth, dispatch resolution, HMR lookup, and binary-safe
 * forwarding.
 */
export async function handlePreviewProxy(
  req: IncomingMessage,
  res: ServerResponse,
  params: { dispatchId: string; templateId: string; tailPath: string },
  deps: PreviewProxyDeps,
): Promise<void> {
  const url = new URL(req.url || "/", "http://internal");
  const auth = await authorize(
    req,
    url,
    params.dispatchId,
    params.templateId,
    deps,
  );
  if (!auth.ok) {
    json(res, auth.status, { error: auth.message });
    return;
  }

  // Resolve dispatch → repo. 404 for unknown id AND for terminal id;
  // the iframe consumer doesn't need to distinguish "never existed"
  // from "already ended" — both render the same fallback.
  const dispatch = await deps.getDispatch(params.dispatchId);
  if (!dispatch) {
    json(res, 404, { error: "Unknown dispatch" });
    return;
  }
  if (TERMINAL_DISPATCH_STATUSES.has(dispatch.status)) {
    json(res, 404, { error: "Dispatch is terminal" });
    return;
  }

  // Resolve the repo's reachable worker host. resolveReachableHost in
  // production walks the cached-host → primary → host.docker.internal
  // candidate list; null means every candidate failed TCP probe.
  const worker = await deps.resolveWorker(dispatch.repoName);
  if (!worker) {
    json(res, 502, {
      error: `Worker for repo "${dispatch.repoName}" is not reachable`,
    });
    return;
  }

  // Ask the worker which Vite port owns this templateId. Worker returns
  // null when no entry exists; the proxy maps that to 404.
  const hmr = await deps.fetchHmrInfo(worker, params.templateId);
  if (!hmr) {
    json(res, 404, { error: "No active HMR server for this template" });
    return;
  }
  // Dispatch scope check: even if SOME dispatch is holding the HMR
  // entry open, the iframe URL must belong to a dispatch that is
  // CURRENTLY a ref. Otherwise a stale link from a long-dead dispatch
  // could ride a fresh sibling's HMR entry — surfaces wrong content
  // to the wrong consumer.
  if (!hmr.refDispatchIds.includes(params.dispatchId)) {
    json(res, 404, {
      error: "Dispatch is not currently attached to the template HMR",
    });
    return;
  }

  const tail = params.tailPath || "/";
  const tailWithQuery = `${tail}${stripSignatureParams(url.searchParams)}`;
  const timeout = deps.timeoutMs ?? PREVIEW_DEFAULT_TIMEOUT_MS;

  await forwardToVite(req, res, {
    host: worker.host,
    port: hmr.port,
    path: tailWithQuery,
    method: req.method ?? "GET",
    timeoutMs: timeout,
  });
}

/**
 * Pipe a single incoming HTTP request to a Vite dev server hosted at
 * `target` and stream the response back. Buffers body in/out as raw
 * `Buffer`s — no UTF-8 coercion at any step.
 */
async function forwardToVite(
  req: IncomingMessage,
  res: ServerResponse,
  target: {
    host: string;
    port: number;
    path: string;
    method: string;
    timeoutMs: number;
  },
): Promise<void> {
  // Buffer the inbound body. Vite GETs carry no body; non-GET methods
  // (rare for an iframe-driven preview, but possible for POST asset
  // queries) are still preserved byte-exact.
  const inboundChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => inboundChunks.push(chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("end", () => resolve());
      req.on("error", reject);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Inbound request body read error: ${message}`);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Request body read failed: ${message}` }));
    } else {
      res.end();
    }
    return;
  }
  const inboundBody = Buffer.concat(inboundChunks);

  // Forward the caller-declared Content-Type verbatim. Critical for any
  // non-text upload; harmless for plain GETs.
  const outgoingHeaders: Record<string, string> = {};
  const incomingContentType = req.headers["content-type"];
  if (typeof incomingContentType === "string") {
    outgoingHeaders["Content-Type"] = incomingContentType;
  }
  if (inboundBody.length > 0) {
    outgoingHeaders["Content-Length"] = inboundBody.length.toString();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const upstreamReq = httpRequest(
      {
        host: target.host,
        port: target.port,
        path: target.path,
        method: target.method,
        headers: outgoingHeaders,
        timeout: target.timeoutMs,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        // Forward Vite's Content-Type verbatim. Vite serves a wide
        // mix — text/html, application/javascript, text/css, image/png,
        // font/woff2, image/svg+xml — and the iframe needs each
        // declared correctly for correct browser handling.
        const responseHeaders: Record<string, string> = {};
        const upstreamContentType = upstreamRes.headers["content-type"];
        if (typeof upstreamContentType === "string") {
          responseHeaders["Content-Type"] = upstreamContentType;
        }
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          if (!res.headersSent) res.writeHead(status, responseHeaders);
          // Buffer.concat → res.end(Buffer). No `.toString()`. This is
          // the load-bearing line — binary asset bytes (PNG, woff2)
          // round-trip byte-exact only because the entire pipeline
          // stays on Buffer.
          res.end(Buffer.concat(chunks));
          settle();
        });
        upstreamRes.on("error", (err) => {
          log.error(`Vite upstream read error: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: `Upstream read failed: ${err.message}` }),
            );
          } else {
            res.end();
          }
          settle();
        });
      },
    );

    // Timeout-vs-other-error distinction: `timeout` fires before
    // `error` (Node API contract); we flip a flag and destroy. The
    // error handler reads the flag to pick 504 vs 502.
    let timedOut = false;
    upstreamReq.on("timeout", () => {
      timedOut = true;
      upstreamReq.destroy(new Error("Upstream timeout"));
    });

    upstreamReq.on("error", (err) => {
      if (timedOut) {
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Vite upstream timed out after ${target.timeoutMs}ms`,
            }),
          );
        } else {
          res.end();
        }
      } else {
        log.warn(
          `Vite upstream unreachable (${target.host}:${target.port}): ${err.message}`,
        );
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Vite upstream unreachable: ${err.message}`,
            }),
          );
        } else {
          res.end();
        }
      }
      settle();
    });

    if (inboundBody.length > 0) upstreamReq.write(inboundBody);
    upstreamReq.end();
  });
}

/**
 * Production factory — wires `handlePreviewProxy` against the live DB
 * lookup, the dispatch-proxy worker-host resolver, and a real HTTP
 * fetch against the worker's `/api/template-hmr/active` route. Tests
 * inject a hand-built deps object directly; server.ts uses this.
 */
export function makePreviewProxyDeps(opts: {
  token: string;
  getDispatchById: (id: string) => Promise<{
    id: string;
    repoName: string;
    status: string;
  } | null>;
  resolveReachableHost: (
    repoName: string,
    primaryHost: string,
    port: number,
  ) => Promise<string | null>;
  workerPortFor: (repoName: string) => number | null;
  primaryHostFor: (repoName: string) => string;
}): PreviewProxyDeps {
  return {
    token: opts.token,
    getDispatch: async (id) => {
      const row = await opts.getDispatchById(id);
      if (!row) return null;
      return { id: row.id, repoName: row.repoName, status: row.status };
    },
    resolveWorker: async (repoName) => {
      const workerPort = opts.workerPortFor(repoName);
      if (!workerPort) return null;
      const reachable = await opts.resolveReachableHost(
        repoName,
        opts.primaryHostFor(repoName),
        workerPort,
      );
      if (!reachable) return null;
      return { host: reachable, port: workerPort };
    },
    fetchHmrInfo: async (worker, templateId) =>
      fetchHmrInfoOverHttp(worker.host, worker.port, templateId),
  };
}

/** HTTP GET to the worker's `/api/template-hmr/active?templateId=X`.
 * Parses JSON, returns the subset the proxy needs, or `null` on 404
 * / parse error. Errors other than 404 (5xx, network) surface as
 * `null` too — the proxy's caller treats null as "no HMR" → 404.
 *
 * The worker route returns `{port, refDispatchIds, ...}` on hit,
 * `{error}` JSON with status 404 on miss. */
async function fetchHmrInfoOverHttp(
  host: string,
  port: number,
  templateId: string,
): Promise<PreviewHmrInfo | null> {
  const path = `/api/template-hmr/active?templateId=${encodeURIComponent(templateId)}`;
  return new Promise<PreviewHmrInfo | null>((resolve) => {
    const req = httpRequest(
      {
        host,
        port,
        path,
        method: "GET",
        timeout: 5_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            // Distinguish "worker has no HMR" (a 404 — normal) from
            // "worker is broken" (5xx — actionable for ops). The proxy
            // returns null in both cases so the caller's 404 contract
            // holds; only the log asymmetry matters here.
            if (status >= 500) {
              log.warn(
                `Worker HMR control plane returned ${status} for templateId=${templateId} at ${host}:${port}`,
              );
            }
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (
              typeof parsed?.port === "number" &&
              Array.isArray(parsed?.refDispatchIds) &&
              parsed.refDispatchIds.every(
                (s: unknown) => typeof s === "string",
              )
            ) {
              resolve({
                port: parsed.port,
                refDispatchIds: parsed.refDispatchIds as string[],
              });
              return;
            }
            log.warn(
              `Worker HMR response shape unexpected (templateId=${templateId}); expected {port:number, refDispatchIds:string[]}`,
            );
            resolve(null);
          } catch {
            log.warn(
              `Worker HMR response was not parseable JSON (templateId=${templateId})`,
            );
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Parse a `/preview/:dispatchId/:templateId/<tail>` pathname into its
 * three pieces. Returns null when the path doesn't match the expected
 * shape — server.ts uses that to fall through to its 404.
 *
 * Strict shape — both IDs are URL-segment safe (no slashes) and
 * non-empty. The tail (if present) is normalized to `/` when omitted
 * so the proxy hits Vite root.
 */
export function parsePreviewPath(pathname: string): {
  dispatchId: string;
  templateId: string;
  tailPath: string;
} | null {
  // Match `/preview/<dispatchId>/<templateId>` optionally followed by `/<tail>`.
  const match = pathname.match(
    /^\/preview\/([^/]+)\/([^/]+)(?:(\/.*))?$/,
  );
  if (!match) return null;
  const tail = match[3] ?? "/";
  // Defense-in-depth: reject any tail containing parent-directory segments
  // or NUL bytes. Vite's own dev server has protections against arbitrary
  // file reads, but the proxy MUST NOT silently pass `../` through — a
  // future Vite config drift / dev-only `@fs/...` allowance would turn
  // into a path-traversal vector via this iframe URL.
  if (
    tail.includes("/../") ||
    tail.endsWith("/..") ||
    tail.includes("\0")
  ) {
    return null;
  }
  try {
    return {
      dispatchId: decodeURIComponent(match[1]),
      templateId: decodeURIComponent(match[2]),
      tailPath: tail,
    };
  } catch {
    // Malformed `%XX` escape in either id segment. The top-level
    // server.ts has a catch-all 500 fallback if we let the throw
    // propagate; returning null instead lets server.ts emit a clean
    // 404 via its `!handled` branch.
    return null;
  }
}
