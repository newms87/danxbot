/**
 * Worker `GET /api/get-app/:dispatchId` — stream the bundle that the
 * in-sandbox MCP wrote to `/tmp/danxbot-app/<dispatchId>.tgz`.
 *
 * Part of the URL-pull bundle contract (DX-712 epic, this is Phase 1
 * DX-713). The in-sandbox MCP packages `source/` + `dist/` into one
 * opaque `tar.gz`, POSTs metadata + a `bundle_url` to the consumer, and
 * the consumer GETs the bundle from this route. Replaces the legacy
 * array-of-base64 callback channel.
 *
 * Auth: Bearer matches the active job's `apiToken` (timing-safe). 401
 * for missing/malformed bearer, unknown dispatch (no active job), and
 * token mismatch — all the same 401 so unauthenticated callers cannot
 * distinguish unknown-dispatch from wrong-token. The dispatch's
 * apiToken lives in memory on the `AgentJob` for the full run plus a
 * 1h grace TTL (`COMPLETED_JOB_TTL_MS` in `src/dispatch/core.ts`),
 * which comfortably covers the callback-then-fetch flow. The epic
 * (DX-712) calls this "the dispatches.api_token row" — that column
 * does not exist; using the in-memory job's apiToken keeps Phase 1
 * scope-bounded.
 *
 * Bundle producer = in-sandbox MCP (separate gpt-manager epic). The
 * worker never creates `BUNDLE_ROOT` on the read path — 404 when the
 * file is absent.
 *
 * Method allowlist: GET only. Anything else → 405.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "http";

import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { extractBearer } from "../dashboard/dispatch-proxy.js";
import { getActiveJob } from "../dispatch/core.js";

const log = createLogger("get-app-route");

export const BUNDLE_ROOT = "/tmp/danxbot-app";

export function bundlePath(dispatchId: string): string {
  return join(BUNDLE_ROOT, `${dispatchId}.tgz`);
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  // Length-mismatch early-return leaks length but Bearer tokens are
  // fixed-shape per dispatch — the leak is negligible vs the cost of
  // an always-constant-time compare across mismatched buffers.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function handleGetApp(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const bearer = extractBearer(req.headers["authorization"]);
  const job = getActiveJob(dispatchId);
  if (
    !bearer ||
    !job ||
    !job.apiToken ||
    !safeEqualStr(bearer, job.apiToken)
  ) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  const path = bundlePath(dispatchId);
  let st;
  try {
    st = await stat(path);
  } catch {
    json(res, 404, { error: "bundle not found" });
    return;
  }
  if (!st.isFile()) {
    json(res, 404, { error: "bundle not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": String(st.size),
    "Cache-Control": "private, no-store",
  });
  // Header-write race: if `createReadStream` errors after `writeHead`
  // (rare — stat-then-open EIO between the calls), the consumer sees a
  // 200 with a truncated body. `Content-Length` mismatch IS the signal
  // — HTTP clients hard-fail on short reads — so the truncation is not
  // silently masked. Deferring `writeHead` until first `data` would
  // require buffering the whole file in memory, which the streaming
  // contract specifically rejects.
  const stream = createReadStream(path);
  await new Promise<void>((resolve) => {
    stream.on("error", (err) => {
      log.error(`[${dispatchId}] bundle stream error: ${err.message}`);
      res.end();
      resolve();
    });
    stream.on("close", () => resolve());
    stream.pipe(res);
  });
}
