import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

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
     * production lock-then-mutate contract well enough for unit tests
     * — handlers see the same `MutateError` rejection path and the same
     * in-memory state they would on the real path.
     */
    mutateAgents: async (
      localPath: string,
      mutator: (agents: Record<string, unknown>) => Record<string, unknown>,
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
    DASHBOARD_PREFIX: "dashboard:",
  };
});

vi.mock("../critical-failure.js", () => ({
  readFlag: vi.fn().mockReturnValue(null),
}));

const mockCountDispatchesByRepo = vi.fn().mockResolvedValue({});
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

vi.mock("../issue-tracker/load-issue-prefix.js", () => ({
  loadIssuePrefix: vi.fn().mockReturnValue("ISS"),
}));

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
  handleDeleteAgent,
  handlePatchAgent,
  handlePostAgent,
} from "./agents-crud.js";
import {
  settingsWithAgents,
  validAgentRecord,
  VALID_SCHEDULE,
} from "./agents-test-fixtures.js";

let tmpRepoDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  tmpRepoDir = mkdtempSync(resolvePath(tmpdir(), "danxbot-agents-crud-test-"));
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
  (req.headers as Record<string, string>)["authorization"] = "Bearer user-alice";
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
    expect(JSON.parse(res._getBody()).error).toMatch(/name/);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new (await import("http")).IncomingMessage(null as never);
    req.method = "POST";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/JSON/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid name pattern", async () => {
    const req = authReqJSON("POST", {
      name: "Alice",
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

  it("returns 500 when writeSettings throws (DX-160 backfill)", async () => {
    mockWriteSettings.mockRejectedValue(new Error("disk full"));
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/Failed to persist/);
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

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new (await import("http")).IncomingMessage(null as never);
    req.method = "PATCH";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/JSON/i);
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
    expect(body.created_at).toBe("2026-05-08T12:00:00Z");
  });

  it("full-update PATCH — every mutable field at once persists exactly the new values (DX-160 backfill)", async () => {
    const req = authReqJSON("PATCH", {
      bio: "Updated bio",
      capabilities: ["slack", "issue-worker"],
      schedule: { ...VALID_SCHEDULE, tz: "Europe/Berlin", mon: ["08:00-12:00"] },
      enabled: false,
    });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.bio).toBe("Updated bio");
    expect(body.capabilities).toEqual(["slack", "issue-worker"]);
    expect(body.schedule.tz).toBe("Europe/Berlin");
    expect(body.schedule.mon).toEqual(["08:00-12:00"]);
    expect(body.enabled).toBe(false);
    // created_at preserved + updated_at bumped
    expect(body.created_at).toBe("2026-05-08T12:00:00Z");
    expect(body.updated_at).not.toBe("2026-05-08T12:00:00Z");

    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.agents.alice.capabilities).toEqual(["slack", "issue-worker"]);
    expect(patch.agents.alice.enabled).toBe(false);
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

  it("returns 500 when writeSettings throws (DX-160 backfill)", async () => {
    mockWriteSettings.mockRejectedValue(new Error("disk full"));
    const req = authReqJSON("PATCH", { bio: "new bio" });
    const res = createMockRes();
    await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/Failed to persist/);
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
    const dir = resolvePath(tmpRepoDir, ".danxbot/agents/alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolvePath(dir, "avatar.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(204);
    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.agents.alice).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("returns 500 when the busy probe throws (DX-160 backfill)", async () => {
    mockFindNonTerminalDispatches.mockRejectedValue(new Error("mysql down"));
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/probe dispatch/);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 500 when writeSettings throws (DX-160 backfill)", async () => {
    mockWriteSettings.mockRejectedValue(new Error("disk full"));
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/Failed to persist/);
  });
});
