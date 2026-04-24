/**
 * Binary-safe /api/playwright/* proxy for the dashboard.
 *
 * External callers (e.g. the Lambda-hosted gpt-manager Laravel app) cannot
 * resolve `http://playwright:3000` because Playwright sits on the private
 * `danxbot-net` bridge. Caddy already fronts the dashboard wholesale on
 * 443, so any route the dashboard exposes is automatically reachable at
 * `https://danxbot.sageus.ai` — this module is the auth'd tunnel that
 * lets those external callers reach Playwright through the dashboard.
 *
 * **Why not reuse `proxyToWorker`:** `src/dashboard/dispatch-proxy.ts`'s
 * `proxyToWorker` hardcodes the outbound request `Content-Type` to
 * `application/json` and calls `Buffer.concat(chunks).toString("utf-8")`
 * on the upstream response body. Running PNG screenshot bytes through
 * UTF-8 coercion silently corrupts them. This forwarder preserves request
 * and response bytes end-to-end as `Buffer`s, never coerces to string,
 * and passes the caller's declared `Content-Type` through verbatim.
 *
 * **Auth:** the same `DANXBOT_DISPATCH_TOKEN` bearer as the worker-proxy
 * routes — `checkAuth` and `rejectUnauthorized` are imported from
 * `dispatch-proxy.ts` so the auth semantics stay identical.
 *
 * **Route registration:** server.ts wires every method of
 * `/api/playwright/<tail>` through `handlePlaywrightProxy`. The tail
 * (including query string) is forwarded to `${upstreamUrl}<tail>`
 * unchanged.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { request as httpRequest } from "http";
import { optional } from "../env.js";
import { createLogger } from "../logger.js";
import { checkAuth, rejectUnauthorized } from "./dispatch-proxy.js";

const log = createLogger("playwright-proxy");

/** Default per-request overall timeout (connect + read). */
export const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 30_000;

export interface PlaywrightProxyDeps {
  /** Shared with dispatch-proxy — the DANXBOT_DISPATCH_TOKEN. */
  token: string;
  /** Base URL of the Playwright service (no trailing slash), e.g. `http://playwright:3000`. */
  upstreamUrl: string;
  /** Overall per-request timeout; defaults to `PLAYWRIGHT_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Read `DANXBOT_PLAYWRIGHT_URL` from env. Defaults to
 * `http://playwright:3000` — the container hostname inside `danxbot-net`.
 */
export function loadPlaywrightUrl(): string {
  return optional("DANXBOT_PLAYWRIGHT_URL", "http://playwright:3000");
}

/**
 * Proxy an incoming `/api/playwright/<tail>` request to
 * `${deps.upstreamUrl}<tail>`. Returns when the response is fully
 * written or an error response has been emitted.
 *
 * `tailPath` is the portion of the URL after `/api/playwright`, including
 * any query string — e.g. `/screenshot?full_page=true`. server.ts is
 * responsible for slicing the prefix off and passing the rest here.
 */
export async function handlePlaywrightProxy(
  req: IncomingMessage,
  res: ServerResponse,
  tailPath: string,
  deps: PlaywrightProxyDeps,
): Promise<void> {
  const auth = checkAuth(req, deps.token);
  if (!auth.ok) {
    rejectUnauthorized(res, auth);
    return;
  }

  const upstream = new URL(deps.upstreamUrl);
  const timeout = deps.timeoutMs ?? PLAYWRIGHT_DEFAULT_TIMEOUT_MS;

  // Buffer the inbound body. `Buffer.concat` preserves every byte; a
  // `.toString()` here would silently corrupt non-UTF-8 payloads (binary
  // uploads, pre-encoded images), which is the exact regression that
  // justifies a separate forwarder from `proxyToWorker`.
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

  // Forward the caller-declared Content-Type verbatim (critical for binary
  // payloads). Only set Content-Length when a body is present so GETs
  // don't ship a "Content-Length: 0" that some servers reject.
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
        host: upstream.hostname,
        port: upstream.port
          ? parseInt(upstream.port, 10)
          : upstream.protocol === "https:"
            ? 443
            : 80,
        path: tailPath || "/",
        method: req.method ?? "GET",
        headers: outgoingHeaders,
        timeout,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const responseHeaders: Record<string, string> = {};
        const upstreamContentType = upstreamRes.headers["content-type"];
        if (typeof upstreamContentType === "string") {
          responseHeaders["Content-Type"] = upstreamContentType;
        }
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          if (!res.headersSent) res.writeHead(status, responseHeaders);
          // `res.end(Buffer)` — NO `.toString()` anywhere in the return
          // path. This is the load-bearing line of the whole module.
          res.end(Buffer.concat(chunks));
          settle();
        });
        upstreamRes.on("error", (err) => {
          log.error(`Playwright upstream read error: ${err.message}`);
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

    // Distinguish timeout-triggered errors (504) from every other connect
    // or read error (502). The `timeout` event fires before `error`; we
    // flip the flag and then destroy the request, which causes `error` to
    // fire with the message we pass. The error handler reads the flag to
    // decide which status to return.
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
              error: `Playwright upstream timed out after ${timeout}ms`,
            }),
          );
        } else {
          res.end();
        }
      } else {
        log.warn(
          `Playwright upstream unreachable (${upstream.hostname}:${upstream.port || "?"}): ${err.message}`,
        );
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Playwright upstream unreachable: ${err.message}`,
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
