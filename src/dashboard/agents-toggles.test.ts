import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage } from "http";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

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
    FEATURES: ["slack", "issuePoller", "dispatchApi", "ideator", "autoTriage", "trelloSync"],
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
const mockAgentBusyOn = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  countDispatchesByRepo: (...args: unknown[]) =>
    mockCountDispatchesByRepo(...args),
  findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
  agentBusyOn: (...args: unknown[]) => mockAgentBusyOn(...args),
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

vi.mock("../issue-tracker/load-issue-prefix.js", () => ({
  loadIssuePrefix: vi.fn().mockReturnValue("ISS"),
}));

// auth-middleware transitively loads db/connection. Stub `requireUser`
// so `Bearer user-<name>` is authenticated; everything else (incl.
// dispatch token) returns 401 — the Phase 4 contract this route enforces.
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

const mockWriteRepoEnvVars = vi.fn();
vi.mock("./repo-env-writer.js", () => ({
  writeRepoEnvVars: (...args: unknown[]) => mockWriteRepoEnvVars(...args),
}));

import {
  handleClearAgentCriticalFailure,
  handleGetRoster,
  handlePatchToggle,
  handlePatchTrelloCredentials,
} from "./agents-toggles.js";
import { deps, settings } from "./agents-test-fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockReadSettings.mockReturnValue(settings());
  mockCountDispatchesByRepo.mockResolvedValue({});
  mockReadFlag.mockReturnValue(null);
  mockProxyToWorker.mockReset();
  mockProxyToWorker.mockResolvedValue(undefined);
  mockProxyToWorkerWithFallback.mockReset();
  mockProxyToWorkerWithFallback.mockResolvedValue(undefined);
  mockAgentBusyOn.mockReset();
  mockAgentBusyOn.mockResolvedValue(new Map());
  mockWriteRepoEnvVars.mockReset();
  mockWriteRepoEnvVars.mockResolvedValue([]);
});

// ============================================================
// DELETE /api/agents/:repo/critical-failure — clear forwarder
// ============================================================

describe("handleClearAgentCriticalFailure", () => {
  it("rejects requests without a user bearer with 401", async () => {
    const req = createMockReqWithBody("DELETE", {});
    const res = createMockRes();

    await handleClearAgentCriticalFailure(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockProxyToWorkerWithFallback).not.toHaveBeenCalled();
  });

  it("rejects the dispatch token (dispatch token is NOT accepted here)", async () => {
    const req = createMockReqWithBody("DELETE", {});
    req.headers = { authorization: "Bearer test-token" };
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

// ============================================================
// PATCH /api/agents/:repo/toggles — auth + validation + mutation
// ============================================================

describe("handlePatchToggle", () => {
  const DEFAULT_TOKEN = "user-newms87";

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

  it("returns 401 when the bearer token is a non-user token", async () => {
    const req = authReq({ feature: "slack", enabled: false }, "wrong-token");
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 401 when the dispatch token is used instead of a user token", async () => {
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

  // DX-302 — round-trip PATCH for the new `trelloSync` feature. The
  // route's allowlist accepts every member of FEATURES, including this
  // one; the handler writes `overrides.trelloSync.enabled` and stamps
  // `dashboard:<username>` as the writer.
  it("DX-302 — accepts `feature: trelloSync` and writes overrides.trelloSync.enabled", async () => {
    mockWriteSettings.mockResolvedValue(settings({ trelloSync: false }));
    mockReadSettings.mockReturnValue(settings({ trelloSync: false }));

    const req = authReq({ feature: "trelloSync", enabled: false });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledWith(
      "/repos/danxbot",
      expect.objectContaining({
        overrides: { trelloSync: { enabled: false } },
        writtenBy: "dashboard:newms87",
      }),
    );
  });

  it("rejects the legacy `trelloPoller` feature key (post-rename canonical is issuePoller)", async () => {
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

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new (await import("http")).IncomingMessage(null as never);
    req.method = "PATCH";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePatchToggle(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/JSON/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
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
    expect(patch.display).toBeUndefined();
  });
});

// ============================================================
// GET /api/agents?repo=<name> — roster (DX-159 Phase 1)
// ============================================================

describe("handleGetRoster", () => {
  it("returns the empty-roster shape for a configured repo with no agents", async () => {
    mockReadSettings.mockReturnValue({
      ...settings(),
      agents: {},
      agentDefaults: { prepMode: "combined" },
    });

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toEqual({ agents: [] });
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
      agentDefaults: { prepMode: "combined" },
    });

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("alice");
    expect(body.agents[0].bio).toBe("A");
  });

  it("returns 404 for an unknown repo", async () => {
    const res = createMockRes();
    await handleGetRoster(res, "not-a-repo", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("not-a-repo");
    expect(mockReadSettings).not.toHaveBeenCalled();
  });

  it("returns 500 when readSettings throws", async () => {
    mockReadSettings.mockImplementation(() => {
      throw new Error("disk corrupt");
    });

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(500);
  });

  // DX-164 Phase 6 — busyOn surfaced from the dispatches table.
  it("attaches busyOn to agents with an in-flight dispatch", async () => {
    mockReadSettings.mockReturnValue({
      ...settings(),
      agents: {
        alice: {
          type: "agent",
          bio: "A",
          capabilities: ["issue-worker"],
          schedule: {
            tz: "America/Chicago",
            mon: [],
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
        bob: {
          type: "agent",
          bio: "B",
          capabilities: ["issue-worker"],
          schedule: {
            tz: "America/Chicago",
            mon: [],
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
      agentDefaults: { prepMode: "combined" },
    });
    mockAgentBusyOn.mockResolvedValue(
      new Map([
        ["alice", { card_id: "DX-1", started_at: 1_700_000_000_000, dispatch_id: "uuid-1" }],
      ]),
    );

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    const alice = body.agents.find((a: { name: string }) => a.name === "alice");
    const bob = body.agents.find((a: { name: string }) => a.name === "bob");
    expect(alice.busyOn).toEqual({
      card_id: "DX-1",
      started_at: 1_700_000_000_000,
      dispatch_id: "uuid-1",
    });
    expect(bob.busyOn).toBeUndefined();
    expect(mockAgentBusyOn).toHaveBeenCalledWith("danxbot");
  });

  it("renders the roster with idle state when agentBusyOn throws", async () => {
    mockReadSettings.mockReturnValue({
      ...settings(),
      agents: {
        alice: {
          type: "agent",
          bio: "A",
          capabilities: ["issue-worker"],
          schedule: {
            tz: "America/Chicago",
            mon: [],
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
      agentDefaults: { prepMode: "combined" },
    });
    mockAgentBusyOn.mockRejectedValue(new Error("db down"));

    const res = createMockRes();
    await handleGetRoster(res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].busyOn).toBeUndefined();
  });
});

// ============================================================
// PATCH /api/agents/:repo/trello-credentials — DX-303
// ============================================================

describe("handlePatchTrelloCredentials", () => {
  const DEFAULT_TOKEN = "user-newms87";

  function authReq(
    body: Record<string, unknown>,
    token = DEFAULT_TOKEN,
  ): IncomingMessage {
    const req = createMockReqWithBody("PATCH", body);
    (req.headers as Record<string, string>)["authorization"] =
      `Bearer ${token}`;
    return req;
  }

  it("returns 401 when no bearer token is supplied", async () => {
    const req = createMockReqWithBody("PATCH", {
      apiKey: "fresh-key",
    });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("rejects the dispatch token (only per-user bearers rotate secrets)", async () => {
    const req = authReq({ apiKey: "fresh-key" }, "test-dispatch-token");
    const res = createMockRes();
    await handlePatchTrelloCredentials(
      req,
      res,
      "danxbot",
      deps({ token: "test-dispatch-token" }),
    );

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = authReq({ apiKey: "fresh-key" });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "nonexistent", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 when neither apiKey nor apiToken is present", async () => {
    const req = authReq({});
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/No credential field/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty-string value", async () => {
    const req = authReq({ apiKey: "" });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/non-empty/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 for a whitespace-only value", async () => {
    const req = authReq({ apiToken: "   " });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/non-empty/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-string value", async () => {
    const req = authReq({ apiKey: 42 });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/must be a string/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 when a value contains a newline", async () => {
    const req = authReq({ apiKey: "good\nbad" });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/newline/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 when a value contains a carriage return", async () => {
    const req = authReq({ apiToken: "good\rbad" });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/carriage-return/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 when a value contains a null byte", async () => {
    const req = authReq({ apiKey: "good\0bad" });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/null/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new (await import("http")).IncomingMessage(null as never);
    req.method = "PATCH";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/JSON/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("rotates apiKey only — writes DANX_TRELLO_API_KEY, leaves apiToken untouched", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_TRELLO_API_KEY"]);
    const req = authReq({ apiKey: "new-key-value" });
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteRepoEnvVars).toHaveBeenCalledTimes(1);
    expect(mockWriteRepoEnvVars).toHaveBeenCalledWith({
      repoLocalPath: "/repos/danxbot",
      updates: { DANX_TRELLO_API_KEY: "new-key-value" },
      writtenBy: "dashboard:newms87",
    });
    expect(JSON.parse(res._getBody())).toEqual({
      updated: ["apiKey"],
      restartRequired: true,
    });
  });

  it("rotates apiToken only — writes DANX_TRELLO_API_TOKEN, leaves apiKey untouched", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_TRELLO_API_TOKEN"]);
    const req = authReq({ apiToken: "new-token" });
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteRepoEnvVars).toHaveBeenCalledWith({
      repoLocalPath: "/repos/danxbot",
      updates: { DANX_TRELLO_API_TOKEN: "new-token" },
      writtenBy: "dashboard:newms87",
    });
    expect(JSON.parse(res._getBody())).toEqual({
      updated: ["apiToken"],
      restartRequired: true,
    });
  });

  it("rotates both fields in a single PATCH", async () => {
    mockWriteRepoEnvVars.mockResolvedValue([
      "DANX_TRELLO_API_KEY",
      "DANX_TRELLO_API_TOKEN",
    ]);
    const req = authReq({ apiKey: "k", apiToken: "t" });
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteRepoEnvVars).toHaveBeenCalledWith({
      repoLocalPath: "/repos/danxbot",
      updates: {
        DANX_TRELLO_API_KEY: "k",
        DANX_TRELLO_API_TOKEN: "t",
      },
      writtenBy: "dashboard:newms87",
    });
    expect(JSON.parse(res._getBody())).toEqual({
      updated: ["apiKey", "apiToken"],
      restartRequired: true,
    });
  });

  it("never echoes the secret value back in the response", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_TRELLO_API_KEY"]);
    const SECRET = "0123456789abcdef0123456789abcdef";
    const req = authReq({ apiKey: SECRET });
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(res._getBody()).not.toContain(SECRET);
  });

  it("records the actual operator's username in writtenBy", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_TRELLO_API_KEY"]);
    const req = authReq({ apiKey: "k" }, "user-bob");
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteRepoEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ writtenBy: "dashboard:bob" }),
    );
  });

  it("returns 500 when the writer throws (e.g. .env missing)", async () => {
    mockWriteRepoEnvVars.mockRejectedValue(
      new Error("Repo .env not found at /repos/danxbot/.danxbot/.env"),
    );
    const req = authReq({ apiKey: "k" });
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/not found/i);
  });

  it("ignores unknown body fields (only apiKey/apiToken are honored)", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_TRELLO_API_KEY"]);
    const req = authReq({
      apiKey: "k",
      apiToken: undefined,
      DANX_TRELLO_API_KEY: "smuggled",
      role: "admin",
    });
    const res = createMockRes();

    await handlePatchTrelloCredentials(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const updates = mockWriteRepoEnvVars.mock.calls[0][0].updates;
    expect(Object.keys(updates)).toEqual(["DANX_TRELLO_API_KEY"]);
    expect(updates.DANX_TRELLO_API_KEY).toBe("k");
  });
});
