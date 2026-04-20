import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "node:net";
import {
  checkAuth,
  workerHost,
  handleLaunchProxy,
  handleJobProxy,
  loadDispatchToken,
} from "./dispatch-proxy.js";
import { createMockReqRes } from "../__tests__/helpers/http-mocks.js";
import type { RepoConfig } from "../types.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe("workerHost", () => {
  it("returns the docker container hostname for a repo", () => {
    expect(workerHost("platform")).toBe("danxbot-worker-platform");
    expect(workerHost("gpt-manager")).toBe("danxbot-worker-gpt-manager");
  });
});

describe("checkAuth", () => {
  function reqWith(authorization?: string): IncomingMessage {
    const req = {
      headers: authorization !== undefined ? { authorization } : {},
    } as unknown as IncomingMessage;
    return req;
  }

  it("returns ok for a valid bearer token", () => {
    expect(checkAuth(reqWith("Bearer abc123"), "abc123")).toEqual({ ok: true });
  });

  it("rejects a missing Authorization header", () => {
    expect(checkAuth(reqWith(undefined), "abc123")).toEqual({
      ok: false,
      reason: "missing_bearer",
    });
  });

  it("rejects when Authorization is not a Bearer scheme", () => {
    expect(checkAuth(reqWith("Basic abc123"), "abc123")).toEqual({
      ok: false,
      reason: "missing_bearer",
    });
  });

  it("rejects a mismatched bearer token", () => {
    expect(checkAuth(reqWith("Bearer wrong"), "correct")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("rejects when the server has no expected token configured", () => {
    expect(checkAuth(reqWith("Bearer anything"), "")).toEqual({
      ok: false,
      reason: "server_missing_token",
    });
  });
});

describe("loadDispatchToken", () => {
  const original = process.env.DANXBOT_DISPATCH_TOKEN;
  afterAll(() => {
    if (original === undefined) delete process.env.DANXBOT_DISPATCH_TOKEN;
    else process.env.DANXBOT_DISPATCH_TOKEN = original;
  });

  it("returns the token when set", () => {
    process.env.DANXBOT_DISPATCH_TOKEN = "xyz";
    expect(loadDispatchToken()).toBe("xyz");
  });

  it("returns empty string when unset so dashboard can still boot", () => {
    delete process.env.DANXBOT_DISPATCH_TOKEN;
    expect(loadDispatchToken()).toBe("");
  });
});

/**
 * Spin up a tiny local http server to stand in for a worker during proxy
 * tests — avoids mocking the http module and exercises real socket I/O.
 */
interface FakeWorker {
  server: Server;
  port: number;
  requests: Array<{ method: string; url: string; body: string }>;
  respondWith: (status: number, body: unknown, contentType?: string) => void;
}

async function startFakeWorker(): Promise<FakeWorker> {
  const requests: FakeWorker["requests"] = [];
  let nextStatus = 200;
  let nextBody: unknown = { ok: true };
  let nextContentType = "application/json";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "?",
        url: req.url ?? "?",
        body: raw,
      });
      res.writeHead(nextStatus, { "Content-Type": nextContentType });
      res.end(
        typeof nextBody === "string" ? nextBody : JSON.stringify(nextBody),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    requests,
    respondWith: (status, body, contentType = "application/json") => {
      nextStatus = status;
      nextBody = body;
      nextContentType = contentType;
    },
  };
}

/**
 * Proxy tests inject a host resolver that returns 127.0.0.1 so the fake
 * worker (bound to localhost) stands in for a real `danxbot-worker-<name>`
 * container.
 */
const testHostResolver = (): string => "127.0.0.1";

describe("handleLaunchProxy", () => {
  let worker: FakeWorker;
  let repos: RepoConfig[];

  beforeAll(async () => {
    worker = await startFakeWorker();
    repos = [
      { name: "platform", url: "", localPath: "/tmp/platform", workerPort: worker.port },
      { name: "gpt-manager", url: "", localPath: "/tmp/gpt-manager", workerPort: worker.port },
    ];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => worker.server.close(() => resolve()));
  });

  beforeEach(() => {
    worker.requests.length = 0;
    worker.respondWith(200, { job_id: "job-123", status: "launched" });
  });

  async function runRequest(
    body: Record<string, unknown>,
    opts: { token?: string; auth?: string } = {},
  ): Promise<{ status: number; body: string }> {
    const { req, res } = createMockReqRes("POST", "/api/launch");
    if (opts.auth) req.headers.authorization = opts.auth;
    const bodyJson = JSON.stringify(body);
    process.nextTick(() => {
      req.emit("data", Buffer.from(bodyJson));
      req.emit("end");
    });
    await handleLaunchProxy(req, res, {
      token: opts.token ?? "tok",
      repos,
      resolveHost: testHostResolver,
    });
    return {
      status: (res as unknown as { _getStatusCode: () => number })._getStatusCode(),
      body: (res as unknown as { _getBody: () => string })._getBody(),
    };
  }

  it("returns 401 when Authorization header is missing", async () => {
    const { status, body } = await runRequest(
      { repo: "platform", task: "do it", api_token: "t" },
      {},
    );
    expect(status).toBe(401);
    expect(JSON.parse(body)).toEqual({ error: "Unauthorized" });
    expect(worker.requests).toHaveLength(0);
  });

  it("returns 401 when bearer token is wrong", async () => {
    const { status } = await runRequest(
      { repo: "platform", task: "do it", api_token: "t" },
      { auth: "Bearer nope", token: "tok" },
    );
    expect(status).toBe(401);
    expect(worker.requests).toHaveLength(0);
  });

  it("returns 500 when server has no DANXBOT_DISPATCH_TOKEN configured", async () => {
    const { status, body } = await runRequest(
      { repo: "platform", task: "do it", api_token: "t" },
      { auth: "Bearer anything", token: "" },
    );
    expect(status).toBe(500);
    expect(JSON.parse(body).error).toMatch(/DANXBOT_DISPATCH_TOKEN/);
    expect(worker.requests).toHaveLength(0);
  });

  it("returns 400 when body is missing `repo`", async () => {
    const { status, body } = await runRequest(
      { task: "do it", api_token: "t" },
      { auth: "Bearer tok" },
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/repo/);
  });

  it("returns 404 when `repo` is not configured", async () => {
    const { status, body } = await runRequest(
      { repo: "unknown-repo", task: "do it", api_token: "t" },
      { auth: "Bearer tok" },
    );
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toMatch(/unknown-repo/);
  });

  it("forwards the body to the worker and returns the worker's response", async () => {
    worker.respondWith(200, { job_id: "abc", status: "launched" });
    const { status, body } = await runRequest(
      { repo: "platform", task: "connectivity", api_token: "t" },
      { auth: "Bearer tok" },
    );
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ job_id: "abc", status: "launched" });
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].method).toBe("POST");
    expect(worker.requests[0].url).toBe("/api/launch");
    expect(JSON.parse(worker.requests[0].body)).toEqual({
      repo: "platform",
      task: "connectivity",
      api_token: "t",
    });
  });

  it("propagates upstream 4xx verbatim", async () => {
    worker.respondWith(400, { error: "Missing required fields: task, api_token" });
    const { status, body } = await runRequest(
      { repo: "platform" },
      { auth: "Bearer tok" },
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/Missing required/);
  });

  it("propagates upstream 5xx verbatim (distinguishes upstream error from unreachable)", async () => {
    worker.respondWith(500, { error: "Launch failed: something exploded" });
    const { status, body } = await runRequest(
      { repo: "platform", task: "x", api_token: "t" },
      { auth: "Bearer tok" },
    );
    expect(status).toBe(500);
    expect(JSON.parse(body).error).toMatch(/something exploded/);
  });

  it("returns 400 when the request body is invalid JSON", async () => {
    const { req, res } = createMockReqRes("POST", "/api/launch");
    req.headers.authorization = "Bearer tok";
    process.nextTick(() => {
      req.emit("data", Buffer.from("{not valid json"));
      req.emit("end");
    });
    await handleLaunchProxy(req, res, {
      token: "tok",
      repos: [
        { name: "platform", url: "", localPath: "/tmp/platform", workerPort: worker.port },
      ],
      resolveHost: testHostResolver,
    });
    const status = (res as unknown as { _getStatusCode: () => number })._getStatusCode();
    const body = (res as unknown as { _getBody: () => string })._getBody();
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/Invalid JSON/);
    expect(worker.requests).toHaveLength(0);
  });

  it("returns 502 when the worker is unreachable", async () => {
    // Start a server just to reserve a port, then close it so the bound port
    // is guaranteed unavailable. Connecting now gives ECONNREFUSED immediately.
    const tmp = createServer(() => {});
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", () => resolve()));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    const unreachable: RepoConfig[] = [
      { name: "platform", url: "", localPath: "/tmp/platform", workerPort: closedPort },
    ];
    const { req, res } = createMockReqRes("POST", "/api/launch");
    req.headers.authorization = "Bearer tok";
    const bodyJson = JSON.stringify({ repo: "platform", task: "x", api_token: "t" });
    process.nextTick(() => {
      req.emit("data", Buffer.from(bodyJson));
      req.emit("end");
    });
    await handleLaunchProxy(req, res, {
      token: "tok",
      repos: unreachable,
      resolveHost: testHostResolver,
    });
    expect((res as unknown as { _getStatusCode: () => number })._getStatusCode()).toBe(502);
  });
});

describe("handleJobProxy", () => {
  let worker: FakeWorker;
  let repos: RepoConfig[];

  beforeAll(async () => {
    worker = await startFakeWorker();
    repos = [
      { name: "platform", url: "", localPath: "/tmp/platform", workerPort: worker.port },
    ];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => worker.server.close(() => resolve()));
  });

  beforeEach(() => {
    worker.requests.length = 0;
    worker.respondWith(200, { status: "running" });
  });

  async function runJob(opts: {
    method: string;
    pathTemplate: string;
    jobId: string;
    repoName: string | null;
    auth?: string;
    token?: string;
  }): Promise<{ status: number; body: string }> {
    const { req, res } = createMockReqRes(opts.method, "/api/status/job1");
    if (opts.auth) req.headers.authorization = opts.auth;
    process.nextTick(() => req.emit("end"));
    await handleJobProxy(
      req,
      res,
      {
        method: opts.method,
        pathTemplate: opts.pathTemplate,
        jobId: opts.jobId,
        repoName: opts.repoName,
      },
      { token: opts.token ?? "tok", repos, resolveHost: testHostResolver },
    );
    return {
      status: (res as unknown as { _getStatusCode: () => number })._getStatusCode(),
      body: (res as unknown as { _getBody: () => string })._getBody(),
    };
  }

  it("rejects unauthenticated requests", async () => {
    const { status } = await runJob({
      method: "GET",
      pathTemplate: "/api/status/:jobId",
      jobId: "j1",
      repoName: "platform",
    });
    expect(status).toBe(401);
  });

  it("requires the ?repo= parameter to resolve the worker", async () => {
    const { status, body } = await runJob({
      method: "GET",
      pathTemplate: "/api/status/:jobId",
      jobId: "j1",
      repoName: null,
      auth: "Bearer tok",
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/repo/);
  });

  it("proxies GET /api/status/:jobId to the matching worker", async () => {
    worker.respondWith(200, { job_id: "j1", status: "completed" });
    const { status, body } = await runJob({
      method: "GET",
      pathTemplate: "/api/status/:jobId",
      jobId: "j1",
      repoName: "platform",
      auth: "Bearer tok",
    });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ job_id: "j1", status: "completed" });
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].method).toBe("GET");
    expect(worker.requests[0].url).toBe("/api/status/j1");
  });

  it("url-encodes the jobId when interpolating the upstream path", async () => {
    await runJob({
      method: "GET",
      pathTemplate: "/api/status/:jobId",
      jobId: "has/slash and space",
      repoName: "platform",
      auth: "Bearer tok",
    });
    expect(worker.requests[0].url).toBe(
      "/api/status/has%2Fslash%20and%20space",
    );
  });

  it("proxies POST /api/cancel/:jobId with body", async () => {
    worker.respondWith(200, { status: "canceled" });
    const { status } = await runJob({
      method: "POST",
      pathTemplate: "/api/cancel/:jobId",
      jobId: "j1",
      repoName: "platform",
      auth: "Bearer tok",
    });
    expect(status).toBe(200);
    expect(worker.requests[0].method).toBe("POST");
    expect(worker.requests[0].url).toBe("/api/cancel/j1");
  });

  it("returns 400 on POST /api/cancel/:jobId with invalid JSON body (no silent fallback)", async () => {
    const { req, res } = createMockReqRes("POST", "/api/cancel/j1");
    req.headers.authorization = "Bearer tok";
    process.nextTick(() => {
      req.emit("data", Buffer.from("{not json"));
      req.emit("end");
    });
    await handleJobProxy(
      req,
      res,
      {
        method: "POST",
        pathTemplate: "/api/cancel/:jobId",
        jobId: "j1",
        repoName: "platform",
      },
      { token: "tok", repos, resolveHost: testHostResolver },
    );
    const status = (res as unknown as { _getStatusCode: () => number })._getStatusCode();
    const body = (res as unknown as { _getBody: () => string })._getBody();
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/Invalid JSON/);
    expect(worker.requests).toHaveLength(0);
  });
});
