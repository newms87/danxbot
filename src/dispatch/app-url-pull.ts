/**
 * App-URL pull (DX-714 / parent epic DX-712).
 *
 * `/api/launch` accepts an optional `app_url` pointing to a gzipped tarball
 * on the consumer's host. The worker GETs the URL with the dispatch bearer,
 * validates content-type and size, then streams the body into
 * `extractTarballToDir(stream, sandboxCwd)` BEFORE spawning the agent.
 *
 * Replaces the historical array-of-base64 `app_files[]` channel: bytes
 * stream once, JSON ceiling becomes irrelevant, the dist walker bug class
 * (subdirectories silently dropped) collapses because the tarball is one
 * opaque artifact.
 *
 * The helper itself is pure (no global state) — caller passes URL, bearer,
 * destination dir, and (optionally) overrides for the size cap, fetch
 * timeout, and the localhost-http allow flag the system tests rely on.
 *
 * Phase-2 residue caveat (DX-714 only): a mid-extract failure leaves a
 * partial tree under `sandboxCwd`. The workspace dir is rendered fresh
 * by the poller's per-tick `renderPerRepoFilesIntoWorkspaces`, so the
 * residue is overwritten before the next dispatch picks the same
 * workspace. A future phase may introduce a per-dispatch sandbox dir +
 * temp-then-rename — this helper is the seam.
 */
import { Readable, Transform, type TransformCallback } from "node:stream";
import { extractTarballToDir, TarballError } from "../template-build/tarball.js";

/**
 * Default size cap for the pulled tarball — 200 MB. Overridable via
 * `DANXBOT_APP_URL_MAX_BYTES`. The cap is enforced two ways:
 *
 *   - Pre-stream check against the response's `Content-Length` header.
 *   - Running byte counter on the streamed body (defense vs missing or
 *     lying Content-Length — the upstream is the consumer, but the
 *     contract still treats it as untrusted input).
 *
 * 200 MB ~ 10× the realistic ceiling of a built Vite bundle (the SG-194 /
 * DX-712 workload) to absorb future bundle-size growth without forcing
 * an env change. Lower it only after measuring real consumer payloads.
 */
export const DEFAULT_APP_URL_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Default total-fetch timeout. Stall detector backs this on the agent
 * side; this cap bounds the worker-side dispatch latency so a hung
 * consumer host fails fast instead of holding a dispatch slot open
 * until the stall window elapses.
 */
export const DEFAULT_APP_URL_TIMEOUT_MS = 60_000;

/**
 * Caller-fixable bad payload (validation, fetch, extract). The HTTP handler
 * maps `validation` → 400 (body bug — bad URL scheme, mutex with other
 * fields, missing bearer) and `fetch` / `extract` → 502 (downstream
 * failed — upstream 4xx, wrong content-type, oversize body, bad
 * tarball bytes). `upstreamStatus` + `upstreamBodySnippet` are populated
 * on `fetch` errors so the launch response surfaces enough context for
 * the caller to diagnose.
 */
export type AppUrlPullErrorKind = "validation" | "fetch" | "extract";

export class AppUrlPullError extends Error {
  readonly kind: AppUrlPullErrorKind;
  readonly upstreamStatus?: number;
  readonly upstreamBodySnippet?: string;

  constructor(
    kind: AppUrlPullErrorKind,
    message: string,
    opts: {
      upstreamStatus?: number;
      upstreamBodySnippet?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AppUrlPullError";
    this.kind = kind;
    if (opts.upstreamStatus !== undefined) {
      this.upstreamStatus = opts.upstreamStatus;
    }
    if (opts.upstreamBodySnippet !== undefined) {
      this.upstreamBodySnippet = opts.upstreamBodySnippet;
    }
  }
}

const ACCEPTED_CONTENT_TYPES = new Set([
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
]);

/**
 * Validate the URL string and return the parsed URL. Throws
 * `AppUrlPullError("validation")` for any unacceptable scheme.
 *
 * Acceptable: `https://`. Also accepts `http://localhost` / `http://127.0.0.1`
 * / `http://[::1]` when `allowHttpLocalhost` is true — the system-test
 * fixture serves tarballs from a local capture server, and forcing TLS
 * there would require shipping a CA bundle the tests do not need.
 *
 * Rejected: `file://`, `data:`, plain `http://` (non-localhost), anything
 * else.
 */
export function validateAppUrl(
  raw: string,
  opts: { allowHttpLocalhost?: boolean } = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppUrlPullError("validation", `app_url is not a valid URL: ${raw}`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (opts.allowHttpLocalhost && isLoopback) return parsed;
    throw new AppUrlPullError(
      "validation",
      `app_url must use https:// (got ${parsed.protocol}//${host})`,
    );
  }
  throw new AppUrlPullError(
    "validation",
    `app_url scheme not allowed: ${parsed.protocol}`,
  );
}

/**
 * Read up to `maxBytes` from the response body via `.text()`, returning
 * the first `maxBytes` UTF-8 characters of the buffered body. Used to
 * surface a snippet of an upstream 4xx body in the launch error
 * response. `fetch().text()` defaults to streaming the whole body —
 * fine for the 4xx case (consumer errors are typically <1 KB JSON).
 */
async function readSnippet(response: Response, maxBytes: number): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, maxBytes);
  } catch {
    return "";
  }
}

/**
 * Build a `Transform` that increments a byte counter on every chunk and
 * destroys the pipeline when the running total exceeds `maxBytes`. This
 * is the streaming-side defense against a missing / lying
 * `Content-Length` header. Returns the running total via `onBytes`
 * after the source ends cleanly.
 */
function makeCapTransform(
  maxBytes: number,
  onBytes: (n: number) => void,
): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback: TransformCallback) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        callback(
          new AppUrlPullError(
            "fetch",
            `app_url body exceeded cap (${maxBytes} bytes) — aborted at ${total} bytes`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      onBytes(total);
      callback();
    },
  });
}

/**
 * Inputs for {@link pullAppUrl}. `fetchImpl` is injectable so tests run
 * against a capture server without monkey-patching the global.
 */
export interface PullAppUrlInput {
  readonly url: string;
  readonly token: string;
  readonly sandboxCwd: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly allowHttpLocalhost?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface PullAppUrlResult {
  readonly bytes: number;
  readonly durationMs: number;
  readonly host: string;
}

/**
 * GET `url` with `Authorization: Bearer ${token}`, validate response
 * metadata, stream the body into `sandboxCwd` via `extractTarballToDir`.
 *
 * Errors:
 *   - URL scheme rejected → `AppUrlPullError("validation")`.
 *   - Empty token → `AppUrlPullError("validation")`. The bearer must be
 *     present; an empty string would silently send `Authorization: Bearer `
 *     and look like a consumer-side auth bug.
 *   - Network failure / timeout / non-2xx → `AppUrlPullError("fetch")`
 *     carrying `upstreamStatus` (when known) + a body snippet.
 *   - Unexpected `Content-Type` → `AppUrlPullError("fetch")`.
 *   - Size cap exceeded → `AppUrlPullError("fetch")`.
 *   - `tar -xz` failure (corrupt bytes, path traversal) →
 *     `AppUrlPullError("extract")` carrying the tar stderr.
 *
 * Redirects: `redirect: "error"` — any 3xx response throws fail-loud.
 * The bearer is dispatch-scoped; following a redirect to a different
 * host would replay the bearer to whatever the consumer points at, so
 * we refuse the redirect and force the consumer to publish a stable
 * URL on the original host.
 */
export async function pullAppUrl(
  input: PullAppUrlInput,
): Promise<PullAppUrlResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_APP_URL_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_APP_URL_TIMEOUT_MS;
  const parsed = validateAppUrl(input.url, {
    allowHttpLocalhost: input.allowHttpLocalhost ?? false,
  });
  if (input.token.length === 0) {
    throw new AppUrlPullError(
      "validation",
      "app_url requires a non-empty bearer token (set api_token on the launch body)",
    );
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  const startedAt = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${input.token}` },
      redirect: "error",
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || abort.signal.aborted);
    throw new AppUrlPullError(
      "fetch",
      isAbort
        ? `app_url fetch timed out after ${timeoutMs} ms`
        : `app_url fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  clearTimeout(timer);

  if (!response.ok) {
    const snippet = await readSnippet(response, 256);
    throw new AppUrlPullError(
      "fetch",
      `app_url upstream returned ${response.status}: ${snippet.trim() || "<empty body>"}`,
      { upstreamStatus: response.status, upstreamBodySnippet: snippet },
    );
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new AppUrlPullError(
      "fetch",
      `app_url unexpected content-type "${contentType || "<missing>"}" — expected application/gzip`,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new AppUrlPullError(
        "fetch",
        `app_url Content-Length ${declared} exceeds cap ${maxBytes}`,
      );
    }
  }

  if (!response.body) {
    throw new AppUrlPullError("fetch", "app_url response had no body");
  }

  // Pipe: web ReadableStream → Node Readable → cap Transform → tar -xz.
  // The cap Transform counts bytes and destroys itself + propagates an
  // AppUrlPullError downstream when the running total exceeds `maxBytes`.
  // We capture that error via a single 'error' listener on the Transform
  // so we can surface it as the truthful root cause when tar reports a
  // downstream "unexpected EOF" symptom.
  const nodeBody = Readable.fromWeb(
    response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  let observedBytes = 0;
  const capTransform = makeCapTransform(maxBytes, (n) => {
    observedBytes = n;
  });
  let capError: AppUrlPullError | null = null;
  capTransform.on("error", (err) => {
    if (err instanceof AppUrlPullError) capError = err;
  });
  // Single pipe — extractTarballToDir takes ownership of the readable
  // side (`capTransform`) and consumes it into tar's stdin.
  const cappedStream = nodeBody.pipe(capTransform);

  try {
    await extractTarballToDir(cappedStream, input.sandboxCwd);
  } catch (err) {
    if (capError) throw capError;
    if (err instanceof AppUrlPullError) throw err;
    if (err instanceof TarballError) {
      throw new AppUrlPullError(
        "extract",
        `app_url tarball extract failed: ${err.message}${err.stderr ? ` — ${err.stderr.trim()}` : ""}`,
        { cause: err },
      );
    }
    throw new AppUrlPullError(
      "extract",
      `app_url extract failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (capError) throw capError;

  return {
    bytes: observedBytes,
    durationMs: Date.now() - startedAt,
    host: parsed.host,
  };
}
