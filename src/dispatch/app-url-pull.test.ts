import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createTarballBuffer } from "../template-build/tarball.js";
import {
  AppUrlPullError,
  pullAppUrl,
  validateAppUrl,
} from "./app-url-pull.js";

interface ServeOpts {
  body?: Buffer;
  status?: number;
  contentType?: string;
  contentLength?: number | null;
  authCheck?: (header: string | undefined) => { ok: boolean; reason?: string };
}

interface RunningServer {
  server: Server;
  port: number;
  hits: Array<{ url: string; auth?: string }>;
  close: () => Promise<void>;
}

function startServer(opts: ServeOpts): Promise<RunningServer> {
  return new Promise((resolve) => {
    const hits: Array<{ url: string; auth?: string }> = [];
    const server = createServer((req, res) => {
      hits.push({ url: req.url ?? "", auth: req.headers.authorization });
      const authResult = opts.authCheck
        ? opts.authCheck(req.headers.authorization)
        : { ok: true };
      if (!authResult.ok) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(authResult.reason ?? "Unauthorized");
        return;
      }
      const body = opts.body ?? Buffer.alloc(0);
      const headers: Record<string, string> = {
        "content-type": opts.contentType ?? "application/gzip",
      };
      if (opts.contentLength !== null) {
        headers["content-length"] = String(opts.contentLength ?? body.length);
      }
      res.writeHead(opts.status ?? 200, headers);
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        hits,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("validateAppUrl", () => {
  it("accepts https", () => {
    expect(validateAppUrl("https://example.com/foo.tgz").host).toBe("example.com");
  });
  it("rejects plain http", () => {
    expect(() => validateAppUrl("http://example.com/foo.tgz")).toThrowError(
      AppUrlPullError,
    );
  });
  it("accepts http://localhost when explicitly allowed", () => {
    expect(
      validateAppUrl("http://localhost:5000/foo.tgz", {
        allowHttpLocalhost: true,
      }).host,
    ).toBe("localhost:5000");
    expect(
      validateAppUrl("http://127.0.0.1:9999/x.tgz", {
        allowHttpLocalhost: true,
      }).host,
    ).toBe("127.0.0.1:9999");
  });
  it("rejects http://localhost when not allowed", () => {
    expect(() =>
      validateAppUrl("http://localhost:5000/foo.tgz"),
    ).toThrowError(AppUrlPullError);
  });
  it("rejects file://", () => {
    expect(() => validateAppUrl("file:///etc/passwd")).toThrowError(
      AppUrlPullError,
    );
  });
  it("rejects data:", () => {
    expect(() => validateAppUrl("data:text/plain,hi")).toThrowError(
      AppUrlPullError,
    );
  });
  it("rejects garbage", () => {
    expect(() => validateAppUrl("not a url at all")).toThrowError(
      AppUrlPullError,
    );
  });
});

describe("pullAppUrl", () => {
  let sandboxRoot: string;
  let sandboxCwd: string;
  let srcDir: string;
  let tarball: Buffer;
  let running: RunningServer | null = null;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "app-url-pull-"));
    sandboxCwd = join(sandboxRoot, "sandbox");
    await mkdir(sandboxCwd, { recursive: true });
    srcDir = join(sandboxRoot, "src");
    await mkdir(join(srcDir, "nested"), { recursive: true });
    await writeFile(join(srcDir, "a.txt"), "alpha");
    await writeFile(join(srcDir, "nested", "b.txt"), "beta");
    tarball = await createTarballBuffer(srcDir);
  });

  afterEach(async () => {
    if (running) {
      await running.close();
      running = null;
    }
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("pulls + extracts a tarball, passes bearer token", async () => {
    let sawAuth: string | undefined;
    running = await startServer({
      body: tarball,
      authCheck: (h) => {
        sawAuth = h;
        return h === "Bearer secret-token"
          ? { ok: true }
          : { ok: false, reason: "bad token" };
      },
    });
    const result = await pullAppUrl({
      url: `http://127.0.0.1:${running.port}/bundle.tgz`,
      token: "secret-token",
      sandboxCwd,
      allowHttpLocalhost: true,
    });

    expect(sawAuth).toBe("Bearer secret-token");
    expect(result.bytes).toBe(tarball.length);
    expect(result.host).toBe(`127.0.0.1:${running.port}`);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(await readFile(join(sandboxCwd, "a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(sandboxCwd, "nested", "b.txt"), "utf8")).toBe(
      "beta",
    );
  });

  it("rejects file:// scheme without making any HTTP call", async () => {
    const err = await pullAppUrl({
      url: "file:///etc/passwd",
      token: "t",
      sandboxCwd,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("validation");
  });

  it("maps 401 upstream to a fetch error with status + body snippet", async () => {
    running = await startServer({
      body: tarball,
      authCheck: () => ({ ok: false, reason: "wrong key, mate" }),
    });
    const err = await pullAppUrl({
      url: `http://127.0.0.1:${running.port}/bundle.tgz`,
      token: "nope",
      sandboxCwd,
      allowHttpLocalhost: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("fetch");
    expect((err as AppUrlPullError).upstreamStatus).toBe(401);
    expect((err as AppUrlPullError).upstreamBodySnippet).toContain(
      "wrong key",
    );

    // Sandbox stayed empty — no extract happened.
    const entries = await readDir(sandboxCwd);
    expect(entries).toEqual([]);
  });

  it("rejects an unexpected content-type", async () => {
    running = await startServer({
      body: Buffer.from("<html>oops</html>"),
      contentType: "text/html",
    });
    const err = await pullAppUrl({
      url: `http://127.0.0.1:${running.port}/wrong.html`,
      token: "t",
      sandboxCwd,
      allowHttpLocalhost: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("fetch");
    expect((err as AppUrlPullError).message).toContain("content-type");
  });

  it("rejects when Content-Length is declared over cap", async () => {
    running = await startServer({
      body: tarball,
      contentLength: 5_000_000_000,
    });
    const err = await pullAppUrl({
      url: `http://127.0.0.1:${running.port}/big.tgz`,
      token: "t",
      sandboxCwd,
      maxBytes: 1024,
      allowHttpLocalhost: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("fetch");
    expect((err as AppUrlPullError).message).toContain("Content-Length");
  });

  it("aborts mid-stream when the body actually exceeds the cap", async () => {
    // Send a tarball that's larger than the cap but lie about
    // Content-Length so the pre-stream gate passes — the streaming
    // counter is the defense.
    running = await startServer({
      body: tarball,
      contentLength: null,
    });
    const tinyCap = 5;
    const err = await pullAppUrl({
      url: `http://127.0.0.1:${running.port}/lie.tgz`,
      token: "t",
      sandboxCwd,
      maxBytes: tinyCap,
      allowHttpLocalhost: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    // The streaming-cap Transform fires before tar can see a full
    // archive — kind MUST be "fetch". A regression that lets bytes
    // past the cap and only surfaces tar's truncation error would
    // flip this to "extract" and fail loudly.
    expect((err as AppUrlPullError).kind).toBe("fetch");
  });

  it("rejects an empty bearer token as validation (DX-714 review)", async () => {
    const err = await pullAppUrl({
      url: "https://example.com/x.tgz",
      token: "",
      sandboxCwd,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("validation");
    expect((err as AppUrlPullError).message).toContain("bearer token");
  });

  it("maps a network connection failure to fetch error with cause", async () => {
    // Point at a TCP port nothing is listening on. Node's fetch
    // rejects with ECONNREFUSED — surfaces as fetch-kind without
    // an upstreamStatus.
    const err = await pullAppUrl({
      url: "http://127.0.0.1:1/nope.tgz",
      token: "t",
      sandboxCwd,
      allowHttpLocalhost: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("fetch");
    expect((err as AppUrlPullError).upstreamStatus).toBeUndefined();
  });

  it("rejects a 3xx redirect — bearer would leak to redirect target", async () => {
    // Start a separate redirect server that 302s to a different host.
    let redirectServer: Server | undefined;
    try {
      redirectServer = await new Promise<Server>((r) => {
        const s = createServer((_req, res) => {
          res.writeHead(302, { location: "https://attacker.example.com/x.tgz" });
          res.end();
        });
        s.listen(0, "127.0.0.1", () => r(s));
      });
      const port = (redirectServer.address() as AddressInfo).port;
      const err = await pullAppUrl({
        url: `http://127.0.0.1:${port}/redir.tgz`,
        token: "secret",
        sandboxCwd,
        allowHttpLocalhost: true,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(AppUrlPullError);
      expect((err as AppUrlPullError).kind).toBe("fetch");
    } finally {
      await new Promise<void>((r) => redirectServer?.close(() => r()));
    }
  });

  it("uses the injected fetchImpl (test seam)", async () => {
    let sawUrl: string | undefined;
    const fakeFetch: typeof fetch = async (url) => {
      sawUrl = String(url);
      return new Response(new Uint8Array(tarball), {
        status: 200,
        headers: {
          "content-type": "application/gzip",
          "content-length": String(tarball.length),
        },
      });
    };
    const result = await pullAppUrl({
      url: "https://example.com/x.tgz",
      token: "t",
      sandboxCwd,
      fetchImpl: fakeFetch,
    });
    expect(sawUrl).toBe("https://example.com/x.tgz");
    expect(result.bytes).toBe(tarball.length);
    expect(await readFile(join(sandboxCwd, "a.txt"), "utf8")).toBe("alpha");
  });

  it("accepts application/x-gzip and application/octet-stream content types", async () => {
    for (const ct of ["application/x-gzip", "application/octet-stream"]) {
      const sandbox = await mkdtemp(join(tmpdir(), `app-url-ct-`));
      try {
        running = await startServer({ body: tarball, contentType: ct });
        await pullAppUrl({
          url: `http://127.0.0.1:${running.port}/x.tgz`,
          token: "t",
          sandboxCwd: sandbox,
          allowHttpLocalhost: true,
        });
        expect(await readFile(join(sandbox, "a.txt"), "utf8")).toBe("alpha");
      } finally {
        await running?.close();
        running = null;
        await rm(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("surfaces tar extraction errors as 'extract' kind", async () => {
    running = await startServer({
      body: Buffer.from("not actually gzipped"),
    });
    const err = await pullAppUrl({
      url: `http://127.0.0.1:${running.port}/garbage.tgz`,
      token: "t",
      sandboxCwd,
      allowHttpLocalhost: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppUrlPullError);
    expect((err as AppUrlPullError).kind).toBe("extract");
  });
});

async function readDir(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
