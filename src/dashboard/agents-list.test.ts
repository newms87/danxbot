import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "node:net";
import { createMockRes } from "../__tests__/helpers/http-mocks.js";

const mockReadSettings = vi.fn();

vi.mock("../settings-file.js", async () => {
  const actual = await vi.importActual<typeof import("../settings-file.js")>(
    "../settings-file.js",
  );
  return {
    ...actual,
    readSettings: (...args: unknown[]) => mockReadSettings(...args),
  };
});

const mockReadFlag = vi.fn().mockReturnValue(null);
vi.mock("../critical-failure.js", () => ({
  readFlag: (...args: unknown[]) => mockReadFlag(...args),
}));

const mockCountDispatchesByRepo = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  countDispatchesByRepo: (...args: unknown[]) =>
    mockCountDispatchesByRepo(...args),
  findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
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

import {
  handleGetAgent,
  handleListAgents,
  probeWorkerHealth,
  publishAgentSnapshot,
} from "./agents-list.js";
import { deps, EMPTY_REPO_COUNTS, settings } from "./agents-test-fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockReadSettings.mockReturnValue(settings());
  mockCountDispatchesByRepo.mockResolvedValue({});
  mockReadFlag.mockReturnValue(null);
  mockLoadIssuePrefix.mockReturnValue("ISS");
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
    mockReadFlag.mockImplementation((path: string) =>
      path === "/repos/danxbot" ? flag : null,
    );

    const res = createMockRes();
    await handleListAgents(res, deps());

    const body = JSON.parse(res._getBody());
    expect(body[0].criticalFailure).toEqual(flag);
    expect(body[1].criticalFailure).toBeNull();
  });

  it("renders snapshots with issuePrefix=null when loadIssuePrefix throws (config missing/corrupt)", async () => {
    mockLoadIssuePrefix.mockImplementation((path: string) => {
      if (path === "/repos/danxbot") throw new Error("config.yml missing");
      return "ISS";
    });

    const res = createMockRes();
    await handleListAgents(res, deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body[0].issuePrefix).toBeNull();
    expect(body[1].issuePrefix).toBe("ISS");
  });
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
// publishAgentSnapshot — best-effort SSE broadcast
// ============================================================

describe("publishAgentSnapshot", () => {
  it("publishes an agent:updated event with the fresh snapshot", async () => {
    mockCountDispatchesByRepo.mockResolvedValue({});

    await publishAgentSnapshot(deps().repos[0], () => "127.0.0.1");

    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const call = mockEventBusPublish.mock.calls[0][0];
    expect(call.topic).toBe("agent:updated");
    expect(call.data.name).toBe("danxbot");
  });

  it("swallows downstream failures so a publish never rolls back the persisted mutation", async () => {
    mockCountDispatchesByRepo.mockRejectedValue(new Error("db down"));
    mockEventBusPublish.mockImplementation(() => {
      throw new Error("subscriber broke");
    });

    // Should not throw — promise resolves regardless.
    await expect(
      publishAgentSnapshot(deps().repos[0], () => "127.0.0.1"),
    ).resolves.toBeUndefined();
  });
});
