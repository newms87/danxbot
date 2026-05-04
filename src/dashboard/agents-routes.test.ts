import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "node:net";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import type { RepoConfig } from "../types.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

// --- Mocks ---

const mockReadSettings = vi.fn();
const mockWriteSettings = vi.fn();

vi.mock("../settings-file.js", () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
  writeSettings: (...args: unknown[]) => mockWriteSettings(...args),
  FEATURES: ["slack", "trelloPoller", "dispatchApi", "ideator"],
  DASHBOARD_PREFIX: "dashboard:",
}));

const mockReadFlag = vi.fn().mockReturnValue(null);
vi.mock("../critical-failure.js", () => ({
  readFlag: (...args: unknown[]) => mockReadFlag(...args),
}));

const mockProxyToWorker = vi.fn();
const mockProxyToWorkerWithFallback = vi.fn();
vi.mock("./dispatch-proxy.js", () => ({
  proxyToWorker: (...args: unknown[]) => mockProxyToWorker(...args),
  proxyToWorkerWithFallback: (...args: unknown[]) =>
    mockProxyToWorkerWithFallback(...args),
}));

const mockCountDispatchesByRepo = vi.fn();

vi.mock("./dispatches-db.js", () => ({
  countDispatchesByRepo: (...args: unknown[]) =>
    mockCountDispatchesByRepo(...args),
}));

const mockEventBusPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: { publish: (...args: unknown[]) => mockEventBusPublish(...args) },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// auth-middleware transitively loads db/connection which reads env at module
// load. Stub it with a mock `requireUser` that treats `Bearer user-<name>`
// as authenticated and anything else (including the dispatch token) as a
// 401. This mirrors the Phase 4 contract: PATCH takes ONLY user bearers,
// `DANXBOT_DISPATCH_TOKEN` is rejected here.
vi.mock("./auth-middleware.js", () => ({
  requireUser: async (req: { headers: { authorization?: string } }) => {
    const h = req.headers?.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!t) return { ok: false, status: 401 };
    if (!t.startsWith("user-")) return { ok: false, status: 401 };
    return {
      ok: true,
      user: { userId: 1, username: t.slice("user-".length) },
    };
  },
}));

import {
  handleClearAgentCriticalFailure,
  handleGetAgent,
  handleListAgents,
  handlePatchToggle,
  probeWorkerHealth,
} from "./agents-routes.js";

// ============================================================
// DELETE /api/agents/:repo/critical-failure — clear forwarder
// ============================================================

describe("handleClearAgentCriticalFailure", () => {
  beforeEach(() => {
    mockProxyToWorker.mockReset();
    mockProxyToWorker.mockResolvedValue(undefined);
    mockProxyToWorkerWithFallback.mockReset();
    mockProxyToWorkerWithFallback.mockResolvedValue(undefined);
  });

  it("rejects requests without a user bearer with 401", async () => {
    const req = createMockReqWithBody("DELETE", {});
    const res = createMockRes();

    await handleClearAgentCriticalFailure(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockProxyToWorkerWithFallback).not.toHaveBeenCalled();
  });

  it("rejects the dispatch token (dispatch token is NOT accepted here)", async () => {
    // Mirror of handlePatchToggle's contract — only user bearers clear flags.
    const req = createMockReqWithBody("DELETE", {});
    req.headers = { authorization: "Bearer test-token" }; // dispatch token
    const res = createMockRes();

    await handleClearAgentCriticalFailure(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockProxyToWorkerWithFallback).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = createMockReqWithBody("DELETE", {});
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();

    await handleClearAgentCriticalFailure(req, res, "not-a-repo", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(mockProxyToWorkerWithFallback).not.toHaveBeenCalled();
  });

  it("forwards the DELETE to the worker's /api/poller/critical-failure endpoint via the fallback wrapper", async () => {
    // Container-or-host-aware: the wrapper resolves a reachable host
    // (cache + probe), so this test asserts on the wrapper's request
    // shape (repoName + primaryHost) rather than a concrete host.
    const req = createMockReqWithBody("DELETE", {});
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();

    await handleClearAgentCriticalFailure(req, res, "danxbot", deps());

    expect(mockProxyToWorkerWithFallback).toHaveBeenCalledTimes(1);
    const [, , upstream, body] = mockProxyToWorkerWithFallback.mock.calls[0];
    expect(upstream).toEqual({
      repoName: "danxbot",
      primaryHost: "127.0.0.1",
      port: 5562,
      path: "/api/poller/critical-failure",
      method: "DELETE",
    });
    expect(body).toBeNull();
  });
});

// Helper settings structure matching the module's Settings shape.
function settings(
  overrides?: Partial<{
    slack: boolean | null;
    trelloPoller: boolean | null;
    dispatchApi: boolean | null;
    ideator: boolean | null;
  }>,
) {
  return {
    overrides: {
      slack: { enabled: overrides?.slack ?? null },
      trelloPoller: { enabled: overrides?.trelloPoller ?? null },
      dispatchApi: { enabled: overrides?.dispatchApi ?? null },
      ideator: { enabled: overrides?.ideator ?? null },
    },
    display: {},
    meta: { updatedAt: "2026-04-20T00:00:00Z", updatedBy: "dashboard:test" },
  };
}

const REPOS: RepoConfig[] = [
  {
    name: "danxbot",
    url: "https://github.com/newms/danxbot.git",
    localPath: "/repos/danxbot",
    workerPort: 5562,
  },
  {
    name: "platform",
    url: "https://github.com/newms/platform.git",
    localPath: "/repos/platform",
    workerPort: 5563,
  },
];

// Build DispatchProxyDeps with a stub resolveHost that points at 127.0.0.1
// so real (fast) HTTP probes work in tests — unreachable workers surface
// as ECONNREFUSED within milliseconds.
function deps(overrides?: Partial<DispatchProxyDeps>): DispatchProxyDeps {
  return {
    token: "test-token",
    repos: REPOS,
    resolveHost: () => "127.0.0.1",
    ...overrides,
  };
}

const EMPTY_REPO_COUNTS = {
  total: { total: 0, slack: 0, trello: 0, api: 0 },
  last24h: { total: 0, slack: 0, trello: 0, api: 0 },
  today: { total: 0, slack: 0, trello: 0, api: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReadSettings.mockReturnValue(settings());
  mockCountDispatchesByRepo.mockResolvedValue({});
  mockReadFlag.mockReturnValue(null);
});

// ============================================================
// probeWorkerHealth — real HTTP against a local ephemeral server
// ============================================================

describe("probeWorkerHealth", () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    return new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server && server.listening) server.close();
  });

  it("returns reachable=true for a 200 response", async () => {
    const health = await probeWorkerHealth("127.0.0.1", port);
    expect(health.reachable).toBe(true);
    expect(health.lastSeenMs).toEqual(expect.any(Number));
    expect(health.error).toBeUndefined();
    server.close();
  });

  it("returns reachable=false for a non-2xx status", async () => {
    // Rewire the request handler to return 503.
    server.removeAllListeners("request");
    server.on("request", (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "degraded" }));
    });
    const health = await probeWorkerHealth("127.0.0.1", port);
    expect(health.reachable).toBe(false);
    expect(health.error).toContain("503");
    server.close();
  });

  it("returns reachable=false on connection refused (no worker listening)", async () => {
    server.close();
    const health = await probeWorkerHealth("127.0.0.1", port);
    expect(health.reachable).toBe(false);
    expect(health.lastSeenMs).toBeNull();
    expect(health.error).toBeDefined();
  });
});

// ============================================================
// GET /api/agents — list
// ============================================================

describe("handleListAgents", () => {
  it("returns one snapshot per configured repo in REPOS order", async () => {
    mockCountDispatchesByRepo.mockResolvedValue({
      danxbot: {
        total: { total: 5, slack: 2, trello: 3, api: 0 },
        last24h: { total: 2, slack: 1, trello: 1, api: 0 },
        today: { total: 1, slack: 0, trello: 1, api: 0 },
      },
    });
    mockReadSettings.mockReturnValue(settings({ slack: false }));

    const res = createMockRes();
    await handleListAgents(res, deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("danxbot");
    expect(body[1].name).toBe("platform");
    expect(body[0].settings.overrides.slack.enabled).toBe(false);
    expect(body[0].counts.total.slack).toBe(2);
    // platform has no counts — defaults to zeros, not omitted
    expect(body[1].counts).toEqual(EMPTY_REPO_COUNTS);
    expect(mockReadSettings).toHaveBeenCalledWith("/repos/danxbot");
    expect(mockReadSettings).toHaveBeenCalledWith("/repos/platform");
  });

  it("keeps rendering with zero counts when the DB query throws", async () => {
    mockCountDispatchesByRepo.mockRejectedValue(new Error("mysql down"));

    const res = createMockRes();
    await handleListAgents(res, deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toHaveLength(2);
    expect(body[0].counts).toEqual(EMPTY_REPO_COUNTS);
    expect(body[1].counts).toEqual(EMPTY_REPO_COUNTS);
  });

  it("includes criticalFailure:null on each snapshot when no flag is set", async () => {
    mockReadFlag.mockReturnValue(null);

    const res = createMockRes();
    await handleListAgents(res, deps());

    const body = JSON.parse(res._getBody());
    expect(body[0].criticalFailure).toBeNull();
    expect(body[1].criticalFailure).toBeNull();
    expect(mockReadFlag).toHaveBeenCalledWith("/repos/danxbot");
    expect(mockReadFlag).toHaveBeenCalledWith("/repos/platform");
  });

  it("surfaces the critical-failure payload on the snapshot when a repo's flag is set", async () => {
    const flag = {
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "agent" as const,
      dispatchId: "d-1",
      reason: "MCP Trello unavailable",
    };
    // First repo (danxbot) has a flag; second (platform) does not.
    mockReadFlag.mockImplementation((path: string) =>
      path === "/repos/danxbot" ? flag : null,
    );

    const res = createMockRes();
    await handleListAgents(res, deps());

    const body = JSON.parse(res._getBody());
    expect(body[0].criticalFailure).toEqual(flag);
    expect(body[1].criticalFailure).toBeNull();
  });

  // Pre-Phase-B this suite included "marks workers with no workerPort as
  // unreachable rather than probing" — that scenario is now structurally
  // impossible: `RepoConfig.workerPort` is required (sourced from the
  // deploy YML by `src/target.ts#loadTarget`), and the loader rejects
  // entries that omit `worker_port` at parse time. The runtime can no
  // longer reach `buildSnapshot` with an undefined `workerPort`.
});

// ============================================================
// GET /api/agents/:repo — single
// ============================================================

describe("handleGetAgent", () => {
  it("returns a single snapshot for a configured repo", async () => {
    mockCountDispatchesByRepo.mockResolvedValue({
      danxbot: {
        total: { total: 1, slack: 1, trello: 0, api: 0 },
        last24h: { total: 0, slack: 0, trello: 0, api: 0 },
        today: { total: 0, slack: 0, trello: 0, api: 0 },
      },
    });

    const res = createMockRes();
    await handleGetAgent(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.name).toBe("danxbot");
    expect(body.counts.total.slack).toBe(1);
  });

  it("returns 404 for an unknown repo", async () => {
    const res = createMockRes();
    await handleGetAgent(res, "nonexistent", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("nonexistent");
  });
});

// ============================================================
// PATCH /api/agents/:repo/toggles — auth + validation + mutation
// ============================================================

describe("handlePatchToggle", () => {
  /**
   * PATCH tests use `Bearer user-<name>` — the mocked `requireUser`
   * treats those as authenticated and resolves the username after the
   * `user-` prefix. Anything else (including the dispatch token) is a
   * 401, enforcing the Phase 4 contract: dispatch tokens do NOT work
   * on dashboard mutations.
   */
  const DEFAULT_TOKEN = "user-newms87";

  beforeEach(() => {
    mockEventBusPublish.mockReset();
  });

  function authReq(
    body: Record<string, unknown>,
    token = DEFAULT_TOKEN,
  ): IncomingMessage {
    const req = createMockReqWithBody("PATCH", body);
    (req.headers as Record<string, string>)["authorization"] =
      `Bearer ${token}`;
    return req;
  }

  it("returns 401 when the bearer token is missing", async () => {
    const req = createMockReqWithBody("PATCH", {
      feature: "slack",
      enabled: false,
    });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token is a non-user token (unknown/invalid)", async () => {
    const req = authReq({ feature: "slack", enabled: false }, "wrong-token");
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 401 when the dispatch token is used instead of a user token", async () => {
    // Phase 4 contract: DANXBOT_DISPATCH_TOKEN is bot↔repo only. Using
    // it on dashboard mutations must fail — gpt-manager's launch flow
    // still uses it on /api/launch (unchanged), but never here.
    const req = authReq(
      { feature: "slack", enabled: false },
      "test-dispatch-token",
    );
    const res = createMockRes();
    await handlePatchToggle(
      req,
      res,
      "danxbot",
      deps({ token: "test-dispatch-token" }),
    );

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = authReq({ feature: "slack", enabled: false });
    const res = createMockRes();
    await handlePatchToggle(req, res, "nonexistent", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown feature", async () => {
    const req = authReq({ feature: "bogus", enabled: true });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("feature must be");
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when enabled is not true/false/null", async () => {
    const req = authReq({ feature: "slack", enabled: "yes" });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("enabled must be");
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("writes the override + `dashboard:<username>` writer on valid PATCH", async () => {
    mockWriteSettings.mockResolvedValue(settings({ slack: false }));
    mockReadSettings.mockReturnValue(settings({ slack: false }));

    const req = authReq({ feature: "slack", enabled: false });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledWith(
      "/repos/danxbot",
      expect.objectContaining({
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:newms87",
      }),
    );
    const body = JSON.parse(res._getBody());
    expect(body.name).toBe("danxbot");
    expect(body.settings.overrides.slack.enabled).toBe(false);
    // Verify agent:updated is published so SSE clients see the toggle without polling.
    expect(mockEventBusPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "agent:updated",
        data: expect.objectContaining({ name: "danxbot" }),
      }),
    );
  });

  it("records the actual operator's username in writtenBy", async () => {
    mockWriteSettings.mockResolvedValue(settings());

    const req = authReq(
      { feature: "dispatchApi", enabled: true },
      "user-alice",
    );
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledWith(
      "/repos/danxbot",
      expect.objectContaining({ writtenBy: "dashboard:alice" }),
    );
  });

  it("accepts enabled: null as an explicit 'defer to env default'", async () => {
    mockWriteSettings.mockResolvedValue(settings());

    const req = authReq({ feature: "trelloPoller", enabled: null });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledWith(
      "/repos/danxbot",
      expect.objectContaining({
        overrides: { trelloPoller: { enabled: null } },
      }),
    );
  });

  it("returns 500 when writeSettings throws", async () => {
    mockWriteSettings.mockRejectedValue(new Error("disk full"));

    const req = authReq({ feature: "slack", enabled: true });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(500);
  });

  it("never touches display — only overrides + writtenBy go into the patch", async () => {
    mockWriteSettings.mockResolvedValue(settings());

    const req = authReq({
      feature: "dispatchApi",
      enabled: false,
      display: { slack: { botToken: "leak****me" } },
    });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    const patch = mockWriteSettings.mock.calls[0][1];
    expect(patch).toEqual({
      overrides: { dispatchApi: { enabled: false } },
      writtenBy: "dashboard:newms87",
    });
    // The `display` key on the incoming body must NOT pass through.
    expect(patch.display).toBeUndefined();
  });
});
