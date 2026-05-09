import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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

vi.mock("../settings-file.js", async () => {
  const actual = await vi.importActual<typeof import("../settings-file.js")>(
    "../settings-file.js",
  );
  return {
    ...actual,
    readSettings: (...args: unknown[]) => mockReadSettings(...args),
    writeSettings: (...args: unknown[]) => mockWriteSettings(...args),
    /**
     * Test-only `mutateAgents` shim. Reads via `mockReadSettings`, runs
     * the mutator, writes via `mockWriteSettings`. Mirrors the
     * production lock-then-mutate contract well enough for the
     * unit-test surface — handlers see the same `MutateError` rejection
     * path and the same in-memory state they would on the real path.
     * Concurrent-write race tests should use the real `mutateAgents`
     * via `vi.importActual`.
     */
    mutateAgents: async (
      localPath: string,
      mutator: (
        agents: Record<string, unknown>,
      ) => Record<string, unknown>,
      writtenBy: string,
    ) => {
      const existing = mockReadSettings(localPath);
      const next = mutator({ ...(existing.agents ?? {}) });
      const merged = {
        ...existing,
        agents: next,
        meta: { updatedAt: new Date().toISOString(), updatedBy: writtenBy },
      };
      await mockWriteSettings(localPath, {
        agents: next,
        writtenBy,
      });
      return merged;
    },
    FEATURES: ["slack", "issuePoller", "dispatchApi", "ideator"],
    DASHBOARD_PREFIX: "dashboard:",
  };
});

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
const mockFindNonTerminalDispatches = vi.fn().mockResolvedValue([]);

vi.mock("./dispatches-db.js", () => ({
  countDispatchesByRepo: (...args: unknown[]) =>
    mockCountDispatchesByRepo(...args),
  findNonTerminalDispatches: (...args: unknown[]) =>
    mockFindNonTerminalDispatches(...args),
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

const mockLoadIssuePrefix = vi.fn().mockReturnValue("ISS");
vi.mock("../issue-tracker/load-issue-prefix.js", () => ({
  loadIssuePrefix: (...args: unknown[]) => mockLoadIssuePrefix(...args),
}));

const mockRunMigration = vi.fn();
vi.mock("../../scripts/migrate-issue-prefix.js", () => ({
  runMigration: (...args: unknown[]) => mockRunMigration(...args),
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
  handleDeleteAgent,
  handleGetAgent,
  handleGetAvatar,
  handleGetRoster,
  handleListAgents,
  handlePatchAgent,
  handlePatchAgentDefaults,
  handlePatchToggle,
  handlePostAgent,
  handlePostAvatar,
  handlePutIssuePrefix,
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
    issuePoller: boolean | null;
    dispatchApi: boolean | null;
    ideator: boolean | null;
  }>,
) {
  return {
    overrides: {
      slack: { enabled: overrides?.slack ?? null },
      issuePoller: { enabled: overrides?.issuePoller ?? null },
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

    const req = authReq({ feature: "issuePoller", enabled: null });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledWith(
      "/repos/danxbot",
      expect.objectContaining({
        overrides: { issuePoller: { enabled: null } },
      }),
    );
  });

  it("rejects the legacy `trelloPoller` feature key (post-rename canonical is issuePoller)", async () => {
    // Pin behaviour: the route accepts only the canonical Feature union
    // (issuePoller). The read-side legacy fallback in normalize() is for
    // disk migration only — operator PATCHes always use the new key.
    const req = authReq({ feature: "trelloPoller", enabled: true });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
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

// ============================================================
// PUT /api/agents/:repo/issue-prefix — DX-103 (Phase 4 of DX-99)
// ============================================================

describe("handlePutIssuePrefix", () => {
  let activeServer: Server | undefined;

  function startWorkerStub(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    repoIndex = 0,
  ): Promise<RepoConfig[]> {
    return new Promise((resolve) => {
      const server = createServer(handler);
      activeServer = server;
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        const adjusted = REPOS.map((r, i) =>
          i === repoIndex ? { ...r, workerPort: port } : r,
        );
        resolve(adjusted);
      });
    });
  }

  beforeEach(() => {
    mockLoadIssuePrefix.mockReset();
    mockLoadIssuePrefix.mockReturnValue("ISS");
    mockRunMigration.mockReset();
    mockEventBusPublish.mockReset();
    activeServer = undefined;
  });

  afterAll(() => {
    if (activeServer && activeServer.listening) activeServer.close();
  });

  it("rejects requests without a user bearer with 401", async () => {
    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(401);
    expect(mockRunMigration).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "not-a-repo", deps());
    expect(res._getStatusCode()).toBe(404);
    expect(mockRunMigration).not.toHaveBeenCalled();
  });

  it("returns 400 when prefix is missing or wrong shape", async () => {
    for (const bad of [undefined, "", "x", "TOOLONG", "DX1", "dx", "D-X"]) {
      const req = createMockReqWithBody("PUT", { prefix: bad });
      req.headers = { authorization: "Bearer user-alice" };
      const res = createMockRes();
      await handlePutIssuePrefix(req, res, "danxbot", deps());
      expect(res._getStatusCode()).toBe(400);
    }
    expect(mockRunMigration).not.toHaveBeenCalled();
  });

  it("returns 400 when prefix matches the current value (no-op rejected)", async () => {
    mockLoadIssuePrefix.mockReturnValue("DX");
    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(400);
    expect((JSON.parse(res._getBody()) as { error: string }).error).toMatch(
      /already "DX"/,
    );
    expect(mockRunMigration).not.toHaveBeenCalled();
  });

  it("returns 409 when an active dispatch holds a YAML lock", async () => {
    mockLoadIssuePrefix.mockReturnValue("ISS");
    const repos = await startWorkerStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobs: [{ id: "abc", status: "running" }] }));
    });

    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps({ repos }));

    expect(res._getStatusCode()).toBe(409);
    expect(mockRunMigration).not.toHaveBeenCalled();
    activeServer?.close();
  });

  it("happy path: runs migration, publishes SSE, returns 200 with migratedFiles", async () => {
    mockLoadIssuePrefix.mockReturnValue("ISS");
    mockRunMigration.mockReturnValue({
      perRepo: [
        {
          repoRoot: "/repos/danxbot",
          oldPrefix: "ISS",
          newPrefix: "DX",
          configUpdated: true,
          filesRenamed: 12,
          filesRewritten: 9,
          skipped: 0,
          errors: [],
          rolledBack: false,
        },
      ],
      totalFilesRenamed: 12,
      totalErrors: 0,
    });

    // Worker stub returns no active jobs → 409 path skipped.
    const repos = await startWorkerStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobs: [] }));
    });

    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps({ repos }));

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody()) as { prefix: string; migratedFiles: number };
    expect(body.prefix).toBe("DX");
    expect(body.migratedFiles).toBe(21); // renamed + rewritten

    expect(mockRunMigration).toHaveBeenCalledTimes(1);
    const migrationArg = mockRunMigration.mock.calls[0][0] as {
      repos: { repoRoot: string; oldPrefix: string; newPrefix: string }[];
    };
    expect(migrationArg.repos).toEqual([
      {
        repoRoot: "/repos/danxbot",
        oldPrefix: "ISS",
        newPrefix: "DX",
      },
    ]);

    expect(mockEventBusPublish).toHaveBeenCalledWith({
      topic: "issue-prefix:changed",
      data: {
        repo: "danxbot",
        oldPrefix: "ISS",
        newPrefix: "DX",
        migratedFiles: 21,
      },
    });
    activeServer?.close();
  });

  it("returns 500 with rollback details when migration fails", async () => {
    mockLoadIssuePrefix.mockReturnValue("ISS");
    mockRunMigration.mockReturnValue({
      perRepo: [
        {
          repoRoot: "/repos/danxbot",
          oldPrefix: "ISS",
          newPrefix: "DX",
          configUpdated: false,
          filesRenamed: 0,
          filesRewritten: 0,
          skipped: 0,
          errors: ["EACCES: permission denied"],
          rolledBack: true,
        },
      ],
      totalFilesRenamed: 0,
      totalErrors: 1,
    });

    // No active jobs → not 409.
    const repos = await startWorkerStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobs: [] }));
    });

    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps({ repos }));

    expect(res._getStatusCode()).toBe(500);
    const body = JSON.parse(res._getBody()) as {
      error: string;
      details: string[];
      rolledBack: boolean;
    };
    expect(body.error).toMatch(/Migration failed/);
    expect(body.details).toEqual(["EACCES: permission denied"]);
    expect(body.rolledBack).toBe(true);
    expect(mockEventBusPublish).not.toHaveBeenCalled();
    activeServer?.close();
  });
});

// ============================================================
// GET /api/agents?repo=<name> — roster + agentDefaults (DX-159 Phase 1)
// ============================================================

describe("handleGetRoster", () => {
  it("returns the empty-roster shape for a configured repo with no agents", async () => {
    mockReadSettings.mockReturnValue({
      ...settings(),
      agents: {},
      agentDefaults: { conflictCheckEnabled: true },
    });

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toEqual({
      agents: [],
      settings: { conflictCheckEnabled: true },
    });
    expect(mockReadSettings).toHaveBeenCalledWith("/repos/danxbot");
  });

  it("flattens the agents map into an ordered array with name attached", async () => {
    mockReadSettings.mockReturnValue({
      ...settings(),
      agents: {
        alice: {
          type: "agent",
          bio: "A",
          capabilities: ["issue-worker"],
          schedule: {
            tz: "America/Chicago",
            mon: ["09:00-17:00"],
            tue: [],
            wed: [],
            thu: [],
            fri: [],
            sat: [],
            sun: [],
          },
          enabled: true,
          created_at: "2026-05-08T12:00:00Z",
          updated_at: "2026-05-08T12:00:00Z",
        },
      },
      agentDefaults: { conflictCheckEnabled: false },
    });

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("alice");
    expect(body.agents[0].bio).toBe("A");
    expect(body.settings.conflictCheckEnabled).toBe(false);
  });

  it("returns 404 for an unknown repo", async () => {
    const res = createMockRes();
    await handleGetRoster(res, "not-a-repo", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("not-a-repo");
    expect(mockReadSettings).not.toHaveBeenCalled();
  });
});

// ============================================================
// PATCH /api/agents-settings?repo=<name> — agentDefaults toggle
// (DX-159 Phase 1)
// ============================================================

describe("handlePatchAgentDefaults", () => {
  beforeEach(() => {
    mockWriteSettings.mockReset();
    mockEventBusPublish.mockReset();
  });

  it("returns 401 without a user bearer", async () => {
    const req = createMockReqWithBody("PATCH", {
      conflictCheckEnabled: false,
    });
    const res = createMockRes();
    await handlePatchAgentDefaults(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("rejects the dispatch token (only user bearers mutate settings)", async () => {
    const req = createMockReqWithBody("PATCH", {
      conflictCheckEnabled: false,
    });
    req.headers = { authorization: "Bearer test-token" }; // dispatch token
    const res = createMockRes();
    await handlePatchAgentDefaults(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = createMockReqWithBody("PATCH", {
      conflictCheckEnabled: true,
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchAgentDefaults(req, res, "not-a-repo", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("rejects bodies that fail to parse as JSON with 400", async () => {
    // Build a request that emits a non-JSON body so `parseBody` throws.
    const req = new (await import("http")).IncomingMessage(null as never);
    req.method = "PATCH";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePatchAgentDefaults(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/JSON/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("rejects bodies missing conflictCheckEnabled with 400", async () => {
    const req = createMockReqWithBody("PATCH", {});
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchAgentDefaults(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("writes the new toggle and returns the refreshed agentDefaults", async () => {
    mockWriteSettings.mockResolvedValue(undefined);
    mockReadSettings.mockReturnValue({
      ...settings(),
      agents: {},
      agentDefaults: { conflictCheckEnabled: false },
    });

    const req = createMockReqWithBody("PATCH", {
      conflictCheckEnabled: false,
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchAgentDefaults(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledTimes(1);
    const [path, patch] = mockWriteSettings.mock.calls[0];
    expect(path).toBe("/repos/danxbot");
    expect(patch.agentDefaults).toEqual({ conflictCheckEnabled: false });
    expect(patch.writtenBy).toBe("dashboard:alice");
    const body = JSON.parse(res._getBody());
    expect(body.settings).toEqual({ conflictCheckEnabled: false });
  });
});

// ============================================================
// DX-160 Phase 2 — Agent CRUD: POST/PATCH/DELETE + avatar
// ============================================================

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

const VALID_SCHEDULE = {
  tz: "America/Chicago",
  mon: ["09:00-17:00"],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
};

function validAgentRecord(over?: Partial<{
  bio: string;
  capabilities: string[];
  enabled: boolean;
  avatar_path: string;
}>) {
  return {
    type: "agent" as const,
    bio: over?.bio ?? "Default test bio.",
    capabilities: over?.capabilities ?? ["issue-worker"],
    schedule: VALID_SCHEDULE,
    enabled: over?.enabled ?? true,
    created_at: "2026-05-08T12:00:00Z",
    updated_at: "2026-05-08T12:00:00Z",
    ...(over?.avatar_path !== undefined ? { avatar_path: over.avatar_path } : {}),
  };
}

function settingsWithAgents(agents: Record<string, unknown>) {
  return {
    ...settings(),
    agents,
    agentDefaults: { conflictCheckEnabled: true },
  };
}

// Use a fixed isolated repo dir for FS-touching tests.
let tmpRepoDir: string;
beforeEach(() => {
  tmpRepoDir = mkdtempSync(resolvePath(tmpdir(), "danxbot-agents-routes-test-"));
  mkdirSync(resolvePath(tmpRepoDir, ".danxbot"), { recursive: true });
});
afterEach(() => {
  rmSync(tmpRepoDir, { recursive: true, force: true });
});

function tmpDeps(): DispatchProxyDeps {
  return {
    token: "test-token",
    repos: [
      {
        name: "danxbot",
        url: "https://github.com/x/danxbot.git",
        localPath: tmpRepoDir,
        workerPort: 5562,
      },
    ],
    resolveHost: () => "127.0.0.1",
  };
}

function authReqJSON(method: string, body: Record<string, unknown> | null) {
  const req = body
    ? createMockReqWithBody(method, body)
    : createMockReqWithBody(method, {});
  (req.headers as Record<string, string>)["authorization"] =
    "Bearer user-alice";
  return req;
}

// ============================================================
// POST /api/agents — create
// ============================================================

describe("handlePostAgent", () => {
  beforeEach(() => {
    mockReadSettings.mockReturnValue(settingsWithAgents({}));
    mockWriteSettings.mockResolvedValue(undefined);
  });

  it("returns 401 without a user bearer", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when ?repo= is missing", async () => {
    const req = authReqJSON("POST", {});
    const res = createMockRes();
    await handlePostAgent(req, res, null, tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/repo/i);
  });

  it("returns 404 for an unknown repo", async () => {
    const req = authReqJSON("POST", {});
    const res = createMockRes();
    await handlePostAgent(req, res, "not-a-repo", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 400 with field-list error on empty body", async () => {
    const req = authReqJSON("POST", {});
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    const body = JSON.parse(res._getBody());
    expect(body.error).toMatch(/name/);
  });

  it("returns 400 for an invalid name pattern", async () => {
    const req = authReqJSON("POST", {
      name: "Alice", // uppercase rejected
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/name/);
  });

  it("returns 400 for an invalid IANA tz", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: { ...VALID_SCHEDULE, tz: "Bogus/Place" },
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).errors.join(" ")).toMatch(/IANA/);
  });

  it("returns 400 for an empty capabilities array", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: [],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).errors.join(" ")).toMatch(/capabilities/);
  });

  it("returns 400 for an invalid schedule window shape", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: { ...VALID_SCHEDULE, mon: ["09:00-25:00"] },
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).errors.join(" ")).toMatch(/HH:MM/);
  });

  it("returns 409 when the 5-cap is reached", async () => {
    const at5 = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`a${i}`, validAgentRecord()]),
    );
    mockReadSettings.mockReturnValue(settingsWithAgents(at5));
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(409);
    expect(JSON.parse(res._getBody()).error).toMatch(/limit reached/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 409 on duplicate name", async () => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord() }),
    );
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(409);
    expect(JSON.parse(res._getBody()).error).toMatch(/already exists/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("creates the record and returns 201 with the new agent", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "Engineer",
      capabilities: ["issue-worker", "slack"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(201);

    const body = JSON.parse(res._getBody());
    expect(body.name).toBe("alice");
    expect(body.bio).toBe("Engineer");
    expect(body.capabilities).toEqual(["issue-worker", "slack"]);
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBe(body.created_at);
    expect(body.type).toBe("agent");

    expect(mockWriteSettings).toHaveBeenCalledTimes(1);
    const [path, patch] = mockWriteSettings.mock.calls[0];
    expect(path).toBe(tmpRepoDir);
    expect(patch.writtenBy).toBe("dashboard:alice");
    expect(patch.agents.alice).toMatchObject({
      bio: "Engineer",
      capabilities: ["issue-worker", "slack"],
    });
  });

  it("server stamps timestamps regardless of client-supplied values", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
      created_at: "1999-01-01T00:00:00Z",
      updated_at: "1999-01-01T00:00:00Z",
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    const body = JSON.parse(res._getBody());
    expect(body.created_at).not.toBe("1999-01-01T00:00:00Z");
    expect(new Date(body.created_at).getFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

// ============================================================
// PATCH /api/agents/:name
// ============================================================

describe("handlePatchAgent", () => {
  beforeEach(() => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord({ bio: "old" }) }),
    );
    mockWriteSettings.mockResolvedValue(undefined);
  });

  it("returns 401 without a user bearer", async () => {
    const req = createMockReqWithBody("PATCH", { bio: "new" });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 404 for an unknown agent", async () => {
    const req = authReqJSON("PATCH", { bio: "new" });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "nobody", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("rejects body with a `name` field (name is immutable)", async () => {
    const req = authReqJSON("PATCH", { name: "renamed", bio: "x" });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/immutable/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("partial update: bio only — bumps updated_at, leaves other fields untouched", async () => {
    const req = authReqJSON("PATCH", { bio: "fresh" });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.bio).toBe("fresh");
    expect(body.capabilities).toEqual(["issue-worker"]);
    expect(body.updated_at).not.toBe("2026-05-08T12:00:00Z");
    // created_at preserved
    expect(body.created_at).toBe("2026-05-08T12:00:00Z");
  });

  it("returns 400 on invalid capabilities", async () => {
    const req = authReqJSON("PATCH", { capabilities: ["bogus"] });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("rejects avatar_path in body (clients must use POST /avatar)", async () => {
    const req = authReqJSON("PATCH", { avatar_path: "../../../etc/passwd" });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).errors.join(" ")).toMatch(/avatar_path/);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });
});

// ============================================================
// DELETE /api/agents/:name
// ============================================================

describe("handleDeleteAgent", () => {
  beforeEach(() => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord() }),
    );
    mockWriteSettings.mockResolvedValue(undefined);
    mockFindNonTerminalDispatches.mockResolvedValue([]);
  });

  it("returns 401 without a user bearer", async () => {
    const req = createMockReqWithBody("DELETE", {});
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 404 for an unknown agent", async () => {
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "nobody", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 409 when an agent has a running dispatch", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      { id: "d-1", status: "running" },
    ]);
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(409);
    expect(JSON.parse(res._getBody()).error).toMatch(/busy/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("204s on idle agent; settings record is dropped + per-agent dir is removed", async () => {
    // Pre-create per-agent dir with a stub avatar so we can assert removal.
    const dir = resolvePath(tmpRepoDir, ".danxbot/agents/alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolvePath(dir, "avatar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(204);
    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.agents.alice).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });
});

// ============================================================
// POST /api/agents/:name/avatar — upload
// ============================================================

describe("handlePostAvatar", () => {
  beforeEach(() => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord() }),
    );
    mockWriteSettings.mockResolvedValue(undefined);
  });

  function mockBinaryReq(
    method: string,
    contentType: string,
    body: Buffer,
  ) {
    const req = new (require("http") as typeof import("http")).IncomingMessage(null as never);
    req.method = method;
    req.headers = {
      authorization: "Bearer user-alice",
      "content-type": contentType,
      "content-length": String(body.byteLength),
    };
    process.nextTick(() => {
      req.emit("data", body);
      req.emit("end");
    });
    return req;
  }

  it("returns 401 without a user bearer", async () => {
    const req = new (require("http") as typeof import("http")).IncomingMessage(null as never);
    req.method = "POST";
    req.headers = { "content-type": "image/png" };
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 415 for unsupported MIME types", async () => {
    const req = mockBinaryReq("POST", "application/pdf", Buffer.from([0x25, 0x50]));
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(415);
  });

  it("returns 413 when the body exceeds 1 MB", async () => {
    // 1 MB + 1 byte
    const big = Buffer.alloc(1_000_001, 0xff);
    const req = mockBinaryReq("POST", "image/png", big);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(413);
  });

  it("accepts a body at exactly the 1 MB boundary (off-by-one guard)", async () => {
    const exactly = Buffer.alloc(1_000_000, 0xff);
    const req = mockBinaryReq("POST", "image/png", exactly);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(200);
  });

  it("returns 404 for an unknown agent", async () => {
    const req = mockBinaryReq("POST", "image/png", Buffer.from([0x89, 0x50]));
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "nobody", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("happy path: writes the file, updates avatar_path + updated_at, returns the record", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = mockBinaryReq("POST", "image/png", png);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.avatar_path).toBe("agents/alice/avatar.png");
    expect(body.updated_at).not.toBe("2026-05-08T12:00:00Z");

    // File on disk matches the uploaded bytes
    const onDisk = readFileSync(
      resolvePath(tmpRepoDir, ".danxbot/agents/alice/avatar.png"),
    );
    expect(onDisk.equals(png)).toBe(true);

    // writeSettings was called with the avatar_path stamped
    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.agents.alice.avatar_path).toBe("agents/alice/avatar.png");
  });

  it("removes a stale prior-extension avatar when the new upload uses a different MIME", async () => {
    // Pre-existing png from a previous upload.
    const dir = resolvePath(tmpRepoDir, ".danxbot/agents/alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolvePath(dir, "avatar.png"), Buffer.from([0x00]));

    // New upload as JPEG.
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const req = mockBinaryReq("POST", "image/jpeg", jpg);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(200);
    expect(existsSync(resolvePath(dir, "avatar.jpg"))).toBe(true);
    expect(existsSync(resolvePath(dir, "avatar.png"))).toBe(false);
  });

  it("accepts image/webp and writes avatar.webp", async () => {
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const req = mockBinaryReq("POST", "image/webp", webp);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).avatar_path).toBe(
      "agents/alice/avatar.webp",
    );
    expect(
      existsSync(resolvePath(tmpRepoDir, ".danxbot/agents/alice/avatar.webp")),
    ).toBe(true);
  });

  it("treats image/jpg alias same as image/jpeg (writes avatar.jpg)", async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const req = mockBinaryReq("POST", "image/jpg", jpg);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).avatar_path).toBe(
      "agents/alice/avatar.jpg",
    );
  });
});

// ============================================================
// GET /api/agents/:name/avatar — serve
// ============================================================

describe("handleGetAvatar", () => {
  it("returns 400 when ?repo= is missing", async () => {
    const res = createMockRes();
    await handleGetAvatar(res, null, "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 404 for an unknown repo", async () => {
    const res = createMockRes();
    await handleGetAvatar(res, "not-a-repo", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 404 when agent has no avatar_path", async () => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord() }),
    );
    const res = createMockRes();
    await handleGetAvatar(res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("serves the file with correct Content-Type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dir = resolvePath(tmpRepoDir, ".danxbot/agents/alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolvePath(dir, "avatar.png"), png);
    mockReadSettings.mockReturnValue(
      settingsWithAgents({
        alice: validAgentRecord({ avatar_path: "agents/alice/avatar.png" }),
      }),
    );

    const res = createMockRes();
    await handleGetAvatar(res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("image/png");
    // The mock res.end captures body as a string; assert by length.
    const captured = res._getBody();
    expect(captured.length).toBe(png.byteLength);
  });

  it("returns 404 when the avatar_path is set but the file is missing on disk", async () => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({
        alice: validAgentRecord({ avatar_path: "agents/alice/avatar.png" }),
      }),
    );
    const res = createMockRes();
    await handleGetAvatar(res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("rejects a path-traversal avatar_path with 404 (defense in depth)", async () => {
    // AGENT_NAME_SHAPE precludes building this avatar_path through any
    // public surface today, but the assertWithinAgentsRoot guard exists
    // so a future regression that lets an unvalidated name reach the FS
    // layer fails closed. Pin the behavior so the next person who
    // relaxes the regex doesn't punch a hole.
    mockReadSettings.mockReturnValue(
      settingsWithAgents({
        alice: validAgentRecord({ avatar_path: "../../../etc/passwd" }),
      }),
    );
    const res = createMockRes();
    await handleGetAvatar(res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });
});
