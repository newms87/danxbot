import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { handleGetApp, bundlePath, BUNDLE_ROOT } from "./get-app-route.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the activeJobs lookup so we don't need to spin up real dispatches.
const getActiveJob = vi.fn();
vi.mock("../dispatch/core.js", () => ({
  getActiveJob: (id: string) => getActiveJob(id),
}));

interface FakeServer {
  server: Server;
  url: string;
}

function startFakeServer(): Promise<FakeServer> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const m = req.url?.match(/^\/api\/get-app\/([^/?]+)/);
      if (!m) {
        res.writeHead(404).end();
        return;
      }
      await handleGetApp(req, res, m[1]);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function fetchRaw(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("handleGetApp", () => {
  let fake: FakeServer;
  let bundleDir: string;
  let originalBundle: string | undefined;

  beforeEach(async () => {
    getActiveJob.mockReset();
    // Use a per-test tmpdir for fixture files, but the route reads from
    // /tmp/danxbot-app/<id>.tgz by contract. We satisfy that by writing
    // into BUNDLE_ROOT directly with unique ids per test, and cleaning
    // up after. (BUNDLE_ROOT is an exported constant for visibility,
    // not a test seam; redirecting it would mask path-traversal bugs.)
    mkdirSync(BUNDLE_ROOT, { recursive: true });
    bundleDir = mkdtempSync(join(tmpdir(), "getapp-test-"));
    originalBundle = undefined;
    fake = await startFakeServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    try {
      rmSync(bundleDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("405s on non-GET methods", async () => {
    const res = await fetchRaw(`${fake.url}/api/get-app/d1`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });

  it("401s with no Authorization header", async () => {
    getActiveJob.mockReturnValue({ apiToken: "tok" });
    const res = await fetchRaw(`${fake.url}/api/get-app/d1`);
    expect(res.status).toBe(401);
  });

  it("401s with malformed Authorization header", async () => {
    getActiveJob.mockReturnValue({ apiToken: "tok" });
    const res = await fetchRaw(`${fake.url}/api/get-app/d1`, {
      headers: { Authorization: "Basic xxx" },
    });
    expect(res.status).toBe(401);
  });

  it("401s when active job is unknown (no leak about row existence)", async () => {
    getActiveJob.mockReturnValue(undefined);
    const res = await fetchRaw(`${fake.url}/api/get-app/unknown`, {
      headers: { Authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
  });

  it("401s on length-mismatched bearer (timing-safe branch)", async () => {
    // Different lengths exercise the `ab.length !== bb.length` early
    // return; the equal-length test below covers the timingSafeEqual
    // path itself.
    getActiveJob.mockReturnValue({ apiToken: "long-token-1234" });
    const res = await fetchRaw(`${fake.url}/api/get-app/d1`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
  });

  it("401s on token mismatch", async () => {
    getActiveJob.mockReturnValue({ apiToken: "right-token" });
    const res = await fetchRaw(`${fake.url}/api/get-app/d1`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("401s when the active job has no apiToken (cannot auth)", async () => {
    getActiveJob.mockReturnValue({ apiToken: "" });
    const res = await fetchRaw(`${fake.url}/api/get-app/d1`, {
      headers: { Authorization: "Bearer something" },
    });
    expect(res.status).toBe(401);
  });

  it("404s when the bundle file is absent", async () => {
    const id = `missing-${Date.now()}`;
    getActiveJob.mockReturnValue({ apiToken: "tok" });
    const res = await fetchRaw(`${fake.url}/api/get-app/${id}`, {
      headers: { Authorization: "Bearer tok" },
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString("utf-8"))).toEqual({
      error: "bundle not found",
    });
  });

  it("200s with binary bytes round-tripped exactly", async () => {
    const id = `ok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Random binary payload — not valid utf-8 — to catch any string
    // coercion regression in the read path.
    const payload = Buffer.from([
      0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xfe,
      0xfd, 0xfc, 0x80, 0x81, 0x82, 0x83,
    ]);
    writeFileSync(bundlePath(id), payload);
    try {
      getActiveJob.mockReturnValue({ apiToken: "tok" });
      const res = await fetchRaw(`${fake.url}/api/get-app/${id}`, {
        headers: { Authorization: "Bearer tok" },
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/gzip");
      expect(res.headers["content-length"]).toBe(String(payload.length));
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(
        createHash("sha256").update(res.body).digest("hex"),
      ).toBe(createHash("sha256").update(payload).digest("hex"));
    } finally {
      try {
        rmSync(bundlePath(id));
      } catch {
        /* ignore */
      }
    }
  });
});
