import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { AddressInfo } from "node:net";
import {
  handlePlaywrightProxy,
  loadPlaywrightUrl,
  PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
  type PlaywrightProxyDeps,
} from "./playwright-proxy.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────
//
// Both sides of the proxy are real HTTP servers on 127.0.0.1:
//
//   client ──► outer host (our route handler calls handlePlaywrightProxy)
//                         │
//                         ▼
//                     fake Playwright
//
// This matters because PNG bytes must round-trip byte-exact. A mock that
// types `end(data?: string)` would coerce Buffer → UTF-8 string and
// silently corrupt non-UTF-8 sequences — exactly the bug this card exists
// to prevent. Two real servers give us real socket I/O and expose that
// bug immediately if it creeps back in.

interface FakePlaywright {
  server: Server;
  url: string;
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>;
  respondWith: (
    status: number,
    body: Buffer | string,
    contentType?: string,
    options?: { hangForeverNoResponse?: boolean },
  ) => void;
}

async function startFakePlaywright(): Promise<FakePlaywright> {
  const requests: FakePlaywright["requests"] = [];
  let nextStatus = 200;
  let nextBody: Buffer = Buffer.from("ok", "utf-8");
  let nextContentType = "text/plain";
  let hangForeverNoResponse = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "?",
        url: req.url ?? "?",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (hangForeverNoResponse) {
        // Intentional black hole: never write a response, never call res.end.
        // Used by the timeout test to force the proxy to trip its own clock.
        return;
      }
      res.writeHead(nextStatus, { "Content-Type": nextContentType });
      res.end(nextBody);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (status, body, contentType = "application/json", options) => {
      nextStatus = status;
      nextBody = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
      nextContentType = contentType;
      hangForeverNoResponse = options?.hangForeverNoResponse ?? false;
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface ProxyHost {
  server: Server;
  port: number;
}

/**
 * Start an HTTP server that treats every incoming request as
 * /api/playwright/<tail> and forwards it through handlePlaywrightProxy.
 * Returns the live port the test client should hit.
 */
async function startProxyHost(deps: PlaywrightProxyDeps): Promise<ProxyHost> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://internal");
    // Route prefix normalization: tests hit /api/playwright/<tail> so the
    // path shape matches what server.ts will pass in production.
    const tailPath =
      url.pathname.slice("/api/playwright".length) + url.search;
    await handlePlaywrightProxy(req, res, tailPath, deps);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

interface ClientResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Make an HTTP request to the proxy host and collect the raw response. */
function clientRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
}): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── loadPlaywrightUrl ───────────────────────────────────────────────────

describe("loadPlaywrightUrl", () => {
  const original = process.env.DANXBOT_PLAYWRIGHT_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DANXBOT_PLAYWRIGHT_URL;
    else process.env.DANXBOT_PLAYWRIGHT_URL = original;
  });

  it("defaults to http://playwright:3000 when unset", () => {
    delete process.env.DANXBOT_PLAYWRIGHT_URL;
    expect(loadPlaywrightUrl()).toBe("http://playwright:3000");
  });

  it("returns the env value when set", () => {
    process.env.DANXBOT_PLAYWRIGHT_URL = "http://other-host:9999";
    expect(loadPlaywrightUrl()).toBe("http://other-host:9999");
  });
});

// ── handlePlaywrightProxy ───────────────────────────────────────────────

describe("handlePlaywrightProxy", () => {
  let playwright: FakePlaywright;
  let host: ProxyHost;

  beforeAll(async () => {
    playwright = await startFakePlaywright();
  });

  afterAll(async () => {
    await closeServer(playwright.server);
  });

  beforeEach(async () => {
    playwright.requests.length = 0;
    playwright.respondWith(200, "ok", "text/plain");
    host = await startProxyHost({
      token: "tok",
      upstreamUrl: playwright.url,
      timeoutMs: 2_000,
    });
  });

  afterEach(async () => {
    await closeServer(host.server);
  });

  // 1. Rejects a request with no Authorization header with 401
  it("rejects a request with no Authorization header with 401", async () => {
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
    });
    expect(res.status).toBe(401);
    expect(playwright.requests).toHaveLength(0);
  });

  // 2. Rejects a request with a wrong bearer token with 401
  it("rejects a request with a wrong bearer token with 401", async () => {
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
    expect(playwright.requests).toHaveLength(0);
  });

  // 3. Returns 500 when DANXBOT_DISPATCH_TOKEN is unset on the dashboard
  it("returns 500 with a clear error when the dashboard has no token configured", async () => {
    await closeServer(host.server);
    host = await startProxyHost({
      token: "", // dashboard missing DANXBOT_DISPATCH_TOKEN
      upstreamUrl: playwright.url,
      timeoutMs: 2_000,
    });
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(500);
    expect(res.body.toString("utf-8")).toMatch(/DANXBOT_DISPATCH_TOKEN/);
    expect(playwright.requests).toHaveLength(0);
  });

  // 4. Forwards POST /api/playwright/screenshot to upstream /screenshot
  it("forwards POST /api/playwright/screenshot to the upstream /screenshot endpoint", async () => {
    playwright.respondWith(
      200,
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "image/png",
    );
    await clientRequest({
      port: host.port,
      method: "POST",
      path: "/api/playwright/screenshot",
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
      },
      body: Buffer.from(JSON.stringify({ url: "https://example.com" }), "utf-8"),
    });
    expect(playwright.requests).toHaveLength(1);
    expect(playwright.requests[0].method).toBe("POST");
    expect(playwright.requests[0].url).toBe("/screenshot");
  });

  // 5. Forwards GET /api/playwright/health to upstream /health
  it("forwards GET /api/playwright/health to the upstream /health endpoint", async () => {
    playwright.respondWith(200, `{"ok":true}`, "application/json");
    await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
      headers: { authorization: "Bearer tok" },
    });
    expect(playwright.requests).toHaveLength(1);
    expect(playwright.requests[0].method).toBe("GET");
    expect(playwright.requests[0].url).toBe("/health");
  });

  // 6. Preserves request body bytes verbatim (JSON round-trip)
  it("preserves request body bytes verbatim (JSON round-trip)", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        url: "https://example.com",
        waitForSelector: "h1",
        viewport: { width: 1920, height: 1080 },
      }),
      "utf-8",
    );
    await clientRequest({
      port: host.port,
      method: "POST",
      path: "/api/playwright/screenshot",
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
      },
      body: payload,
    });
    expect(playwright.requests).toHaveLength(1);
    // Byte-for-byte match — not JSON.parse+compare, since the card's
    // invariant is preserved BYTES not preserved VALUES.
    expect(playwright.requests[0].body.equals(payload)).toBe(true);
  });

  // 7. Preserves response binary bytes verbatim (PNG byte-exact round-trip)
  it("preserves response binary bytes verbatim (PNG byte-exact round-trip)", async () => {
    // PNG signature + some deliberately non-UTF-8 bytes (0xff, 0xfe, 0xc2
    // without a continuation byte). UTF-8 coercion turns these into
    // U+FFFD replacement chars, so a byte-exact match is the ONLY way
    // this test passes without a binary-safe forwarder.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc2, 0x00,
      0x01, 0x02, 0x03, 0xee, 0xab, 0x55, 0xaa,
    ]);
    playwright.respondWith(200, pngBytes, "image/png");
    const res = await clientRequest({
      port: host.port,
      method: "POST",
      path: "/api/playwright/screenshot",
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
      },
      body: Buffer.from(`{"url":"https://example.com"}`, "utf-8"),
    });
    expect(res.status).toBe(200);
    expect(res.body.equals(pngBytes)).toBe(true);
  });

  // 8. Passes upstream Content-Type through unchanged
  it("passes upstream Content-Type through unchanged", async () => {
    playwright.respondWith(200, Buffer.from([0xff, 0x00]), "image/png");
    const png = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/screenshot",
      headers: { authorization: "Bearer tok" },
    });
    expect(png.headers["content-type"]).toBe("image/png");

    playwright.respondWith(200, `{"ok":true}`, "application/json");
    const json = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
      headers: { authorization: "Bearer tok" },
    });
    expect(json.headers["content-type"]).toBe("application/json");
  });

  // 9. Passes upstream status code through unchanged (4xx/5xx)
  it("passes upstream status code through unchanged (4xx)", async () => {
    playwright.respondWith(422, `{"error":"bad url"}`, "application/json");
    const res = await clientRequest({
      port: host.port,
      method: "POST",
      path: "/api/playwright/screenshot",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: Buffer.from(`{"url":"junk"}`, "utf-8"),
    });
    expect(res.status).toBe(422);
    expect(res.body.toString("utf-8")).toBe(`{"error":"bad url"}`);
  });

  it("passes upstream status code through unchanged (5xx)", async () => {
    playwright.respondWith(500, `{"error":"boom"}`, "application/json");
    const res = await clientRequest({
      port: host.port,
      method: "POST",
      path: "/api/playwright/screenshot",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: Buffer.from(`{"url":"x"}`, "utf-8"),
    });
    expect(res.status).toBe(500);
  });

  // 10. Preserves query string on forwarded URL
  it("preserves the query string on the forwarded URL", async () => {
    await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/search?q=hello%20world&limit=5",
      headers: { authorization: "Bearer tok" },
    });
    expect(playwright.requests).toHaveLength(1);
    expect(playwright.requests[0].url).toBe("/search?q=hello%20world&limit=5");
  });

  // 11. Returns 502 when upstream is unreachable
  it("returns 502 with a clear error when the Playwright upstream is unreachable", async () => {
    // Acquire a real TCP port and immediately release it. The kernel now
    // returns ECONNREFUSED for any connect attempt, which is deterministic
    // across environments — a literal "unreachable" port (e.g. :1) can
    // silently be filtered and trigger the timeout path instead.
    const placeholder = createServer();
    await new Promise<void>((resolve) =>
      placeholder.listen(0, "127.0.0.1", () => resolve()),
    );
    const deadPort = (placeholder.address() as AddressInfo).port;
    await closeServer(placeholder);

    await closeServer(host.server);
    host = await startProxyHost({
      token: "tok",
      upstreamUrl: `http://127.0.0.1:${deadPort}`,
      timeoutMs: 2_000,
    });
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(502);
  });

  // 12. Returns 504 after the configured timeout when the upstream hangs
  it("returns 504 after the configured timeout when the upstream hangs", async () => {
    playwright.respondWith(200, "never-sent", "text/plain", {
      hangForeverNoResponse: true,
    });
    // Tight per-request timeout to keep the test fast.
    await closeServer(host.server);
    host = await startProxyHost({
      token: "tok",
      upstreamUrl: playwright.url,
      timeoutMs: 150,
    });
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/api/playwright/health",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(504);
  });

  // 13. Forwards the caller-declared Content-Type on the upstream request.
  // Binary safety guard: if the forwarder silently rewrites Content-Type to
  // application/json (the regression that bit dispatch-proxy), Playwright
  // would mis-parse a non-JSON upload. Assert the outbound header matches
  // the inbound header.
  it("forwards the request Content-Type header verbatim", async () => {
    await clientRequest({
      port: host.port,
      method: "POST",
      path: "/api/playwright/screenshot",
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/octet-stream",
      },
      body: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    });
    expect(playwright.requests).toHaveLength(1);
    expect(playwright.requests[0].headers["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(playwright.requests[0].body).toEqual(
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    );
  });

  // Default-timeout sanity: the module's exported default is a real value,
  // so server.ts callers that omit timeoutMs get a sane fallback.
  it("exposes a non-zero PLAYWRIGHT_DEFAULT_TIMEOUT_MS", () => {
    expect(PLAYWRIGHT_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  // Method-forwarding contract: the forwarder must pass the request method
  // verbatim. GET/POST are exercised elsewhere — DELETE pins the generic
  // case so a future regression (e.g. hardcoding the outbound method like
  // proxyToWorker does) fails here instead of in production.
  it("forwards the request method verbatim for non-GET/POST methods", async () => {
    await clientRequest({
      port: host.port,
      method: "DELETE",
      path: "/api/playwright/resource/123",
      headers: { authorization: "Bearer tok" },
    });
    expect(playwright.requests).toHaveLength(1);
    expect(playwright.requests[0].method).toBe("DELETE");
    expect(playwright.requests[0].url).toBe("/resource/123");
  });
});
