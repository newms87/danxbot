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
  handlePreviewProxy,
  makePreviewProxyDeps,
  parsePreviewPath,
  signPreviewUrl,
  verifyPreviewSignature,
  type PreviewProxyDeps,
  type PreviewDispatchInfo,
  type PreviewHmrInfo,
} from "./preview-proxy.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// requireUser reads cookies + DB; we never want that touched in this
// test. Default to "no user" so signature + bearer paths are exercised
// in isolation; individual tests opt-in to "valid user" via override.
let mockUserOk = false;
vi.mock("./auth-middleware.js", () => ({
  requireUser: async () => (mockUserOk
    ? { ok: true, user: { id: 1, username: "tester" } }
    : { ok: false, status: 401 }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────
//
// Real HTTP servers on 127.0.0.1 for both ends so binary payloads
// round-trip through real sockets, not a Buffer-as-string mock.

interface FakeVite {
  server: Server;
  port: number;
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
  ) => void;
}

async function startFakeVite(): Promise<FakeVite> {
  const requests: FakeVite["requests"] = [];
  let nextStatus = 200;
  let nextBody: Buffer = Buffer.from("<html>preview</html>", "utf-8");
  let nextContentType = "text/html";

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "?",
        url: req.url ?? "?",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(nextStatus, { "Content-Type": nextContentType });
      res.end(nextBody);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    server,
    port: (server.address() as AddressInfo).port,
    requests,
    respondWith: (status, body, contentType = "text/html") => {
      nextStatus = status;
      nextBody = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
      nextContentType = contentType;
    },
  };
}

interface ProxyHost {
  server: Server;
  port: number;
}

async function startProxyHost(deps: PreviewProxyDeps): Promise<ProxyHost> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://internal");
    const parsed = parsePreviewPath(url.pathname);
    if (!parsed) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    await handlePreviewProxy(req, res, parsed, deps);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return { server, port: (server.address() as AddressInfo).port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface ClientResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

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

// ── parsePreviewPath ─────────────────────────────────────────────────────

describe("parsePreviewPath", () => {
  it("parses a root preview path", () => {
    expect(parsePreviewPath("/preview/d-1/t-7")).toEqual({
      dispatchId: "d-1",
      templateId: "t-7",
      tailPath: "/",
    });
  });

  it("parses a tail under the preview path", () => {
    expect(parsePreviewPath("/preview/d-1/t-7/assets/main.js")).toEqual({
      dispatchId: "d-1",
      templateId: "t-7",
      tailPath: "/assets/main.js",
    });
  });

  it("URL-decodes path segments", () => {
    expect(parsePreviewPath("/preview/d%201/t-7")).toEqual({
      dispatchId: "d 1",
      templateId: "t-7",
      tailPath: "/",
    });
  });

  it("returns null for non-preview pathnames", () => {
    expect(parsePreviewPath("/api/launch")).toBeNull();
    expect(parsePreviewPath("/preview")).toBeNull();
    expect(parsePreviewPath("/preview/d-1")).toBeNull();
    expect(parsePreviewPath("/preview/d-1/")).toBeNull();
  });

  it("rejects path-traversal segments in the tail", () => {
    expect(parsePreviewPath("/preview/d-1/t-7/../etc/passwd")).toBeNull();
    expect(parsePreviewPath("/preview/d-1/t-7/foo/../bar")).toBeNull();
    expect(parsePreviewPath("/preview/d-1/t-7/foo/..")).toBeNull();
  });

  it("rejects NUL bytes in the tail", () => {
    expect(parsePreviewPath("/preview/d-1/t-7/foo%00bar")).toEqual({
      // %00 in path text is NOT a decoded NUL — the regex match treats it
      // as literal characters. This case verifies the literal `\0` guard
      // separately.
      dispatchId: "d-1",
      templateId: "t-7",
      tailPath: "/foo%00bar",
    });
    expect(parsePreviewPath("/preview/d-1/t-7/foo\0bar")).toBeNull();
  });

  it("returns null for malformed percent-escapes in id segments", () => {
    expect(parsePreviewPath("/preview/d%ZZ/t-7")).toBeNull();
  });
});

// ── signPreviewUrl / verifyPreviewSignature ──────────────────────────────

describe("signPreviewUrl + verifyPreviewSignature", () => {
  const secret = "test-token";

  it("a freshly minted sig + exp pair verifies", () => {
    const exp = Date.now() + 60_000;
    const sig = signPreviewUrl("d-1", "t-7", exp, secret);
    expect(
      verifyPreviewSignature("d-1", "t-7", sig, String(exp), secret),
    ).toBe(true);
  });

  it("rejects when exp has passed", () => {
    const exp = Date.now() - 1;
    const sig = signPreviewUrl("d-1", "t-7", exp, secret);
    expect(
      verifyPreviewSignature("d-1", "t-7", sig, String(exp), secret),
    ).toBe(false);
  });

  it("rejects when signature is tampered", () => {
    const exp = Date.now() + 60_000;
    const sig = signPreviewUrl("d-1", "t-7", exp, secret);
    const tampered = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(
      verifyPreviewSignature("d-1", "t-7", tampered, String(exp), secret),
    ).toBe(false);
  });

  it("rejects when dispatchId or templateId changes", () => {
    const exp = Date.now() + 60_000;
    const sig = signPreviewUrl("d-1", "t-7", exp, secret);
    expect(
      verifyPreviewSignature("d-OTHER", "t-7", sig, String(exp), secret),
    ).toBe(false);
    expect(
      verifyPreviewSignature("d-1", "t-OTHER", sig, String(exp), secret),
    ).toBe(false);
  });

  it("rejects malformed inputs", () => {
    expect(verifyPreviewSignature("d-1", "t-7", null, "1", secret)).toBe(false);
    expect(verifyPreviewSignature("d-1", "t-7", "deadbeef", null, secret)).toBe(false);
    expect(verifyPreviewSignature("d-1", "t-7", "not-hex!", "1", secret)).toBe(false);
    expect(verifyPreviewSignature("d-1", "t-7", "ab", "notnum", secret)).toBe(false);
    expect(verifyPreviewSignature("d-1", "t-7", "ab", "1", "")).toBe(false);
  });

  it("rejects when secret differs", () => {
    const exp = Date.now() + 60_000;
    const sig = signPreviewUrl("d-1", "t-7", exp, secret);
    expect(
      verifyPreviewSignature("d-1", "t-7", sig, String(exp), "different-secret"),
    ).toBe(false);
  });
});

// ── handlePreviewProxy ───────────────────────────────────────────────────

describe("handlePreviewProxy", () => {
  let vite: FakeVite;
  let host: ProxyHost;
  let getDispatchMock: ReturnType<typeof vi.fn>;
  let resolveWorkerMock: ReturnType<typeof vi.fn>;
  let fetchHmrMock: ReturnType<typeof vi.fn>;

  const DEFAULT_DISPATCH: PreviewDispatchInfo = {
    id: "d-1",
    repoName: "demo",
    status: "running",
  };

  function buildDeps(overrides: Partial<PreviewProxyDeps> = {}): PreviewProxyDeps {
    return {
      token: "tok",
      getDispatch: getDispatchMock as unknown as PreviewProxyDeps["getDispatch"],
      resolveWorker: resolveWorkerMock as unknown as PreviewProxyDeps["resolveWorker"],
      fetchHmrInfo: fetchHmrMock as unknown as PreviewProxyDeps["fetchHmrInfo"],
      timeoutMs: 2_000,
      ...overrides,
    };
  }

  beforeAll(async () => {
    vite = await startFakeVite();
  });

  afterAll(async () => {
    await closeServer(vite.server);
  });

  beforeEach(async () => {
    mockUserOk = false;
    vite.requests.length = 0;
    vite.respondWith(200, "<html>preview</html>", "text/html");
    getDispatchMock = vi.fn(async () => DEFAULT_DISPATCH);
    resolveWorkerMock = vi.fn(async () => ({ host: "127.0.0.1", port: vite.port }));
    fetchHmrMock = vi.fn(async (): Promise<PreviewHmrInfo> => ({
      port: vite.port,
      refDispatchIds: ["d-1"],
    }));
    host = await startProxyHost(buildDeps());
  });

  afterEach(async () => {
    await closeServer(host.server);
  });

  it("rejects a request with no auth (no header, no signature, no user) with 401", async () => {
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
    });
    expect(res.status).toBe(401);
    expect(vite.requests).toHaveLength(0);
    expect(getDispatchMock).not.toHaveBeenCalled();
  });

  it("rejects a request with a wrong bearer token with 401 (does NOT fall through to user/sig)", async () => {
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
    expect(getDispatchMock).not.toHaveBeenCalled();
  });

  it("returns 500 with a clear error when DANXBOT_DISPATCH_TOKEN is unset", async () => {
    await closeServer(host.server);
    host = await startProxyHost(buildDeps({ token: "" }));
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(500);
    expect(res.body.toString("utf-8")).toMatch(/DANXBOT_DISPATCH_TOKEN/);
  });

  it("accepts a valid bearer token", async () => {
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    expect(res.body.toString("utf-8")).toBe("<html>preview</html>");
  });

  it("accepts a valid dashboard user session (cookie path)", async () => {
    mockUserOk = true;
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
    });
    expect(res.status).toBe(200);
  });

  it("accepts a valid signed query (?sig + ?exp)", async () => {
    const exp = Date.now() + 60_000;
    const sig = signPreviewUrl("d-1", "t-7", exp, "tok");
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: `/preview/d-1/t-7?sig=${sig}&exp=${exp}`,
    });
    expect(res.status).toBe(200);
    // The signed-URL params MUST NOT leak onward to Vite — they're a
    // dashboard-only concern.
    expect(vite.requests).toHaveLength(1);
    expect(vite.requests[0].url).not.toMatch(/sig=/);
    expect(vite.requests[0].url).not.toMatch(/exp=/);
  });

  it("404s when the dispatch is unknown", async () => {
    getDispatchMock.mockResolvedValueOnce(null);
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-unknown/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString("utf-8")).error).toMatch(/dispatch/i);
    expect(vite.requests).toHaveLength(0);
  });

  it("404s when the dispatch is terminal", async () => {
    getDispatchMock.mockResolvedValueOnce({
      ...DEFAULT_DISPATCH,
      status: "completed",
    });
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(404);
    expect(vite.requests).toHaveLength(0);
  });

  it("404s when the worker has no active HMR for the templateId", async () => {
    fetchHmrMock.mockResolvedValueOnce(null);
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString("utf-8")).error).toMatch(/HMR/i);
    expect(vite.requests).toHaveLength(0);
  });

  it("404s when the dispatch is not in refDispatchIds for the active HMR", async () => {
    fetchHmrMock.mockResolvedValueOnce({
      port: vite.port,
      refDispatchIds: ["d-OTHER"],
    });
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString("utf-8")).error).toMatch(/attached/i);
    expect(vite.requests).toHaveLength(0);
  });

  it("502s when the worker cannot be resolved", async () => {
    resolveWorkerMock.mockResolvedValueOnce(null);
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(502);
  });

  it("forwards the tail path + query to Vite verbatim", async () => {
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7/assets/main.js?v=abc",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    expect(vite.requests).toHaveLength(1);
    expect(vite.requests[0].url).toBe("/assets/main.js?v=abc");
  });

  it("round-trips binary asset bytes byte-exact (no UTF-8 coercion)", async () => {
    // A minimal PNG header — every byte non-printable / non-UTF-8.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0x00, 0x01, 0x02,
    ]);
    vite.respondWith(200, pngBytes, "image/png");
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7/preview.png",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body.equals(pngBytes)).toBe(true);
  });

  it("forwards Vite's response status (e.g. 404 for missing asset)", async () => {
    vite.respondWith(404, "not found", "text/plain");
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7/missing.css",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(404);
    expect(res.body.toString("utf-8")).toBe("not found");
  });

  it("504s when Vite accepts the connection but never responds (timeout)", async () => {
    // Start a server that accepts the TCP connect, never writes a
    // response, never closes. The proxy's per-request timeout must
    // fire and produce a 504 (distinct from the 502 connect-refused
    // path). Tightened to 200ms so the test stays fast.
    const silent = createServer((_req, _res) => {
      // Black hole: no response, no end.
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const silentPort = (silent.address() as AddressInfo).port;
    try {
      await closeServer(host.server);
      host = await startProxyHost(buildDeps({ timeoutMs: 200 }));
      fetchHmrMock.mockResolvedValueOnce({
        port: silentPort,
        refDispatchIds: ["d-1"],
      });
      const res = await clientRequest({
        port: host.port,
        method: "GET",
        path: "/preview/d-1/t-7",
        headers: { authorization: "Bearer tok" },
      });
      expect(res.status).toBe(504);
      expect(JSON.parse(res.body.toString("utf-8")).error).toMatch(/timed out/i);
    } finally {
      // The silent server has the proxy's destroyed socket as its only
      // peer; closing it after the assertion lets the test process
      // unwind cleanly.
      await closeServer(silent);
    }
  });

  it("502s when Vite is unreachable", async () => {
    // Allocate a port, then immediately close it — TCP connect to a
    // never-listened port on 127.0.0.1 returns ECONNREFUSED, which is
    // what the proxy maps to 502. Picking an arbitrary literal port is
    // unreliable across CI hosts (some namespaces have surprise listeners).
    const ephemeral = createServer();
    await new Promise<void>((r) => ephemeral.listen(0, "127.0.0.1", () => r()));
    const refusedPort = (ephemeral.address() as AddressInfo).port;
    await closeServer(ephemeral);
    fetchHmrMock.mockResolvedValueOnce({
      port: refusedPort,
      refDispatchIds: ["d-1"],
    });
    const res = await clientRequest({
      port: host.port,
      method: "GET",
      path: "/preview/d-1/t-7",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(502);
  });
});

// ── makePreviewProxyDeps — production wiring ─────────────────────────────
//
// Production deps factory glues real DB + real HTTP into the deps shape
// the handler consumes. Handler tests above use hand-built mocks, so
// the factory is untested by those. These tests stand a fake worker on
// 127.0.0.1, point `makePreviewProxyDeps` at it, and exercise the
// `fetchHmrInfoOverHttp` path end-to-end.

interface FakeWorker {
  server: Server;
  port: number;
  /** Inspect the path the worker route was called with. */
  lastPath: { url: string | undefined };
  /** Set the response for the next call. */
  respondWith: (
    status: number,
    body: string,
    contentType?: string,
  ) => void;
}

async function startFakeWorker(): Promise<FakeWorker> {
  let nextStatus = 200;
  let nextBody = "";
  let nextContentType = "application/json";
  const lastPath = { url: undefined as string | undefined };
  const server = createServer((req, res) => {
    lastPath.url = req.url ?? undefined;
    res.writeHead(nextStatus, { "Content-Type": nextContentType });
    res.end(nextBody);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    lastPath,
    respondWith: (status, body, contentType = "application/json") => {
      nextStatus = status;
      nextBody = body;
      nextContentType = contentType;
    },
  };
}

describe("makePreviewProxyDeps + fetchHmrInfoOverHttp", () => {
  let worker: FakeWorker;
  let deps: PreviewProxyDeps;

  beforeEach(async () => {
    worker = await startFakeWorker();
    deps = makePreviewProxyDeps({
      token: "tok",
      getDispatchById: async () => null,
      resolveReachableHost: async () => "127.0.0.1",
      workerPortFor: () => worker.port,
      primaryHostFor: () => "127.0.0.1",
    });
  });

  afterEach(async () => {
    await closeServer(worker.server);
  });

  it("resolveWorker maps null workerPort to null without probing", async () => {
    const localDeps = makePreviewProxyDeps({
      token: "tok",
      getDispatchById: async () => null,
      resolveReachableHost: async () => "127.0.0.1",
      workerPortFor: () => null,
      primaryHostFor: () => "127.0.0.1",
    });
    expect(await localDeps.resolveWorker("repo-a")).toBeNull();
  });

  it("resolveWorker maps null probe result to null", async () => {
    const localDeps = makePreviewProxyDeps({
      token: "tok",
      getDispatchById: async () => null,
      resolveReachableHost: async () => null,
      workerPortFor: () => worker.port,
      primaryHostFor: () => "127.0.0.1",
    });
    expect(await localDeps.resolveWorker("repo-a")).toBeNull();
  });

  it("fetchHmrInfo: 200 with valid shape returns the parsed subset", async () => {
    worker.respondWith(
      200,
      JSON.stringify({
        templateId: "7",
        port: 12345,
        url: "http://x",
        refDispatchIds: ["d-1", "d-2"],
        startedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const info = await deps.fetchHmrInfo(
      { host: "127.0.0.1", port: worker.port },
      "7",
    );
    expect(info).toEqual({
      port: 12345,
      refDispatchIds: ["d-1", "d-2"],
    });
    expect(worker.lastPath.url).toBe("/api/template-hmr/active?templateId=7");
  });

  it("fetchHmrInfo: 404 returns null", async () => {
    worker.respondWith(404, JSON.stringify({ error: "no active HMR" }));
    const info = await deps.fetchHmrInfo(
      { host: "127.0.0.1", port: worker.port },
      "9999",
    );
    expect(info).toBeNull();
  });

  it("fetchHmrInfo: 500 returns null (broken worker)", async () => {
    worker.respondWith(500, "internal");
    const info = await deps.fetchHmrInfo(
      { host: "127.0.0.1", port: worker.port },
      "9999",
    );
    expect(info).toBeNull();
  });

  it("fetchHmrInfo: 200 with malformed JSON returns null without throwing", async () => {
    worker.respondWith(200, "not json {{", "application/json");
    const info = await deps.fetchHmrInfo(
      { host: "127.0.0.1", port: worker.port },
      "7",
    );
    expect(info).toBeNull();
  });

  it("fetchHmrInfo: 200 with wrong shape (missing fields) returns null", async () => {
    worker.respondWith(200, JSON.stringify({ port: 12345 }));
    expect(
      await deps.fetchHmrInfo({ host: "127.0.0.1", port: worker.port }, "7"),
    ).toBeNull();
  });

  it("fetchHmrInfo: 200 with non-string refDispatchIds element returns null", async () => {
    worker.respondWith(
      200,
      JSON.stringify({ port: 12345, refDispatchIds: ["d-1", 42] }),
    );
    expect(
      await deps.fetchHmrInfo({ host: "127.0.0.1", port: worker.port }, "7"),
    ).toBeNull();
  });

  it("fetchHmrInfo: connect-refused returns null without throwing", async () => {
    const ephemeral = createServer();
    await new Promise<void>((r) =>
      ephemeral.listen(0, "127.0.0.1", () => r()),
    );
    const refused = (ephemeral.address() as AddressInfo).port;
    await closeServer(ephemeral);
    expect(
      await deps.fetchHmrInfo({ host: "127.0.0.1", port: refused }, "7"),
    ).toBeNull();
  });

  it("fetchHmrInfo: URL-encodes templateId in the query string", async () => {
    worker.respondWith(
      200,
      JSON.stringify({ port: 1, refDispatchIds: ["d-1"] }),
    );
    await deps.fetchHmrInfo(
      { host: "127.0.0.1", port: worker.port },
      "weird id & value",
    );
    expect(worker.lastPath.url).toBe(
      "/api/template-hmr/active?templateId=weird%20id%20%26%20value",
    );
  });
});
