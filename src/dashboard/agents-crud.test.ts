import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
        hostPath: tmpRepoDir,
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
      // DX-292 — every newly-created agent starts healthy.
      broken: null,
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

  // DX-298 — `broken` is server-stamped on POST. A client trying to
  // smuggle the field in (null or populated) must 400 — the server is
  // the only writer of broken on create.
  it("returns 400 when POST body carries `broken` — server stamps null on create, clients may not supply it", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
      broken: null,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).errors.join(" ")).toMatch(
      /broken is read-only on POST/i,
    );
    expect(mockWriteSettings).not.toHaveBeenCalled();
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

  // DX-298 — Mark Resolved clear path. `broken: null` is the only legal
  // dashboard write to this field; non-null values are reserved for the
  // worker's prep verdict route (Phase 5) and must 400 here.
  describe("DX-298 — broken clear (Mark Resolved)", () => {
    function brokenAlice() {
      return {
        ...validAgentRecord({ bio: "broken alice" }),
        broken: {
          reason: "Rebase conflict couldn't be auto-resolved on origin/main",
          suggested_steps: [
            "SSH to the worker host",
            "cd into the agent worktree",
            "Resolve conflicts manually, then push",
          ],
          set_at: "2026-05-12T07:00:00Z",
        },
      };
    }

    it("PATCH {broken: null} clears a populated broken record and returns the refreshed agent", async () => {
      mockReadSettings.mockReturnValue(
        settingsWithAgents({ alice: brokenAlice() }),
      );
      const req = authReqJSON("PATCH", { broken: null });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(200);
      const body = JSON.parse(res._getBody());
      expect(body.broken).toBeNull();
      // Other fields preserved — clear is orthogonal to bio/schedule/etc.
      expect(body.bio).toBe("broken alice");
      expect(body.capabilities).toEqual(["issue-worker"]);
      // updated_at MUST bump so consumers can detect the clear.
      expect(body.updated_at).not.toBe("2026-05-08T12:00:00Z");

      // The persisted patch carries the cleared shape so a subsequent
      // read sees `broken: null` durably.
      const [, patch] = mockWriteSettings.mock.calls[0];
      expect(patch.agents.alice.broken).toBeNull();
    });

    it("PATCH {broken: null} on an already-healthy agent is a no-op for the field (idempotent)", async () => {
      mockReadSettings.mockReturnValue(
        settingsWithAgents({
          alice: { ...validAgentRecord(), broken: null },
        }),
      );
      const req = authReqJSON("PATCH", { broken: null });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getBody()).broken).toBeNull();
    });

    it("PATCH {broken: <populated>} returns 400 — dashboard cannot SET broken, only clear", async () => {
      mockReadSettings.mockReturnValue(
        settingsWithAgents({ alice: validAgentRecord() }),
      );
      const req = authReqJSON("PATCH", {
        broken: {
          reason: "Operator-stamped",
          suggested_steps: [],
          set_at: "2026-05-12T07:00:00Z",
        },
      });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(400);
      const body = JSON.parse(res._getBody());
      expect(body.errors.join(" ")).toMatch(/only be set to null/i);
      expect(mockWriteSettings).not.toHaveBeenCalled();
    });

    it("PATCH {broken: 'cleared'} returns 400 — non-null scalars are rejected", async () => {
      mockReadSettings.mockReturnValue(
        settingsWithAgents({ alice: validAgentRecord() }),
      );
      const req = authReqJSON("PATCH", { broken: "cleared" });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(400);
      expect(mockWriteSettings).not.toHaveBeenCalled();
    });

    it("PATCH {broken: null, bio: 'fresh'} — clear coexists with other field edits in one round-trip", async () => {
      // Operators may want to update bio + clear in one click; the
      // validator must not force an artificial split.
      mockReadSettings.mockReturnValue(
        settingsWithAgents({ alice: brokenAlice() }),
      );
      const req = authReqJSON("PATCH", { broken: null, bio: "fresh bio" });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(200);
      const body = JSON.parse(res._getBody());
      expect(body.broken).toBeNull();
      expect(body.bio).toBe("fresh bio");
    });

    it("PATCH absent `broken` key preserves a populated broken record (bio-only edit doesn't clear)", async () => {
      mockReadSettings.mockReturnValue(
        settingsWithAgents({ alice: brokenAlice() }),
      );
      const req = authReqJSON("PATCH", { bio: "tweaked" });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(200);
      const body = JSON.parse(res._getBody());
      // Absence-means-preserve — the existing broken record must
      // round-trip unchanged so a routine bio edit doesn't accidentally
      // un-park an agent the worker just flagged.
      expect(body.broken).not.toBeNull();
      expect(body.broken.reason).toMatch(/Rebase conflict/);
    });

    it("publishes agent:updated on the event bus after a successful clear so other dashboard clients see it live", async () => {
      mockReadSettings.mockReturnValue(
        settingsWithAgents({ alice: brokenAlice() }),
      );
      const req = authReqJSON("PATCH", { broken: null });
      const res = createMockRes();
      await handlePatchAgent(req, res, "danxbot", "alice", tmpDeps());

      expect(res._getStatusCode()).toBe(200);
      expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
      const event = mockEventBusPublish.mock.calls[0][0];
      expect(event.topic).toBe("agent:updated");
    });
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

  it("DX-262 — busy probe filters by agent_name so unrelated stuck dispatches don't block DELETE", async () => {
    // Pre-fix: the busy probe was repo-wide, so any orphan
    // running-status row in `dispatches` (e.g. from a crashed worker)
    // permanently 409'd every agent's DELETE. Post-fix: agent_name
    // filter scopes the check to THIS agent.
    mockFindNonTerminalDispatches.mockReset();
    mockFindNonTerminalDispatches.mockResolvedValue([]);
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(mockFindNonTerminalDispatches).toHaveBeenCalledWith(
      "danxbot",
      "alice",
    );
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

  it("DX-283: cascades assigned_agent clear on every open YAML claiming the deleted agent", async () => {
    // End-to-end: drop two open YAMLs claiming "alice", invoke DELETE,
    // assert the cascade ran. The cascade's per-card unit coverage
    // lives in heal.test.ts — this test just locks in the handler
    // wiring so a future refactor that drops the call surfaces here.
    const configDir = resolvePath(tmpRepoDir, ".danxbot/config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolvePath(configDir, "config.yml"),
      "issue_prefix: ISS\n",
    );
    const issuesOpen = resolvePath(tmpRepoDir, ".danxbot/issues/open");
    mkdirSync(issuesOpen, { recursive: true });
    const claimedA = [
      "schema_version: 7",
      "tracker: memory",
      "id: ISS-500",
      "external_id: ''",
      "parent_id: null",
      "children: []",
      "dispatch: null",
      "status: ToDo",
      "type: Feature",
      "title: ISS-500",
      "description: body",
      "priority: 3.0",
      "triage:",
      "  expires_at: ''",
      "  reassess_hint: ''",
      "  last_status: ''",
      "  last_explain: ''",
      "  ice:",
      "    total: 0",
      "    i: 0",
      "    c: 0",
      "    e: 0",
      "  history: []",
      "ac: []",
      "comments: []",
      "history: []",
      "retro:",
      "  good: ''",
      "  bad: ''",
      "  action_item_ids: []",
      "  commits: []",
      "assigned_agent: alice",
      "waiting_on: null",
      "blocked: null",
      "requires_human: null",
      "",
    ].join("\n");
    writeFileSync(resolvePath(issuesOpen, "ISS-500.yml"), claimedA);
    writeFileSync(
      resolvePath(issuesOpen, "ISS-501.yml"),
      claimedA.replace("ISS-500", "ISS-501"),
    );

    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(204);

    const r500 = readFileSync(
      resolvePath(issuesOpen, "ISS-500.yml"),
      "utf-8",
    );
    const r501 = readFileSync(
      resolvePath(issuesOpen, "ISS-501.yml"),
      "utf-8",
    );
    expect(r500).toMatch(/assigned_agent: null/);
    expect(r501).toMatch(/assigned_agent: null/);
  });
});

// ============================================================
// DX-161 — WorktreeManager wiring on POST + DELETE
// ============================================================

import type { WorktreeManager } from "../agent/worktree-manager.js";

interface MockedWorktreeManager extends WorktreeManager {
  bootstrapCalls: Array<{ localPath: string; agentName: string }>;
  teardownCalls: Array<{ localPath: string; agentName: string }>;
}

function mkWorktreeManager(opts: {
  bootstrapImpl?: () => Promise<void>;
  teardownImpl?: () => Promise<void>;
} = {}): MockedWorktreeManager {
  const bootstrapCalls: Array<{ localPath: string; agentName: string }> = [];
  const teardownCalls: Array<{ localPath: string; agentName: string }> = [];
  return {
    bootstrapCalls,
    teardownCalls,
    worktreePath: (ctx, name) => `${ctx.localPath}/.danxbot/worktrees/${name}`,
    bootstrap: async (ctx, name) => {
      bootstrapCalls.push({ localPath: ctx.localPath, agentName: name });
      if (opts.bootstrapImpl) await opts.bootstrapImpl();
    },
    teardown: async (ctx, name) => {
      teardownCalls.push({ localPath: ctx.localPath, agentName: name });
      if (opts.teardownImpl) await opts.teardownImpl();
    },
    syncWorktree: async () => ({ kind: "noop" }),
    snapshotIfDirty: async () => ({ kind: "clean" }),
    ensureProvisioned: async () => {},
    fetchOrigin: async () => true,
  };
}

describe("handlePostAgent — WorktreeManager wiring (DX-161)", () => {
  beforeEach(() => {
    mockReadSettings.mockReturnValue(settingsWithAgents({}));
    mockWriteSettings.mockResolvedValue(undefined);
  });

  it("POST 201 path: bootstrap is called once with the resolved repo + agent name", async () => {
    const wm = mkWorktreeManager();
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(201);
    expect(wm.bootstrapCalls).toEqual([
      { localPath: tmpRepoDir, agentName: "alice" },
    ]);
  });

  it("POST 500 on bootstrap failure: settings record rolled back, error surfaces in body", async () => {
    const wm = mkWorktreeManager({
      bootstrapImpl: async () => {
        throw new Error("git worktree add failed: origin/main does not exist");
      },
    });
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(500);
    const errBody = JSON.parse(res._getBody());
    expect(errBody.error).toMatch(/bootstrap.*alice/i);
    // The body MUST surface the underlying git error so the operator
    // knows what to fix — not just "bootstrap failed".
    expect(errBody.error).toMatch(/origin\/main does not exist/);

    // Two writeSettings calls — initial create + rollback delete.
    expect(mockWriteSettings).toHaveBeenCalledTimes(2);
    const lastWrite = mockWriteSettings.mock.calls.at(-1)![1];
    expect(lastWrite.agents.alice).toBeUndefined();
  });

  it("POST rollback preserves OTHER agents (sibling-survival regression guard)", async () => {
    // Seed an existing `bob` agent so the rollback's `delete current[name]`
    // can be distinguished from a "rollback nuked everything" bug.
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ bob: validAgentRecord({ bio: "Bob's bio" }) }),
    );
    const wm = mkWorktreeManager({
      bootstrapImpl: async () => {
        throw new Error("git worktree add failed");
      },
    });
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(500);
    expect(mockWriteSettings).toHaveBeenCalledTimes(2);
    const finalWrite = mockWriteSettings.mock.calls.at(-1)![1];
    expect(finalWrite.agents.alice).toBeUndefined();
    // Bob MUST survive the rollback.
    expect(finalWrite.agents.bob).toMatchObject({ bio: "Bob's bio" });
  });

  it("POST 500 when rollback ALSO fails — original bootstrap error still surfaces (defensive contract)", async () => {
    const wm = mkWorktreeManager({
      bootstrapImpl: async () => {
        throw new Error("origin/main does not exist");
      },
    });
    let writeCallCount = 0;
    mockWriteSettings.mockImplementation(async () => {
      writeCallCount++;
      // First write (the create) succeeds; second write (the rollback) throws.
      if (writeCallCount === 2) {
        throw new Error("disk full during rollback");
      }
    });
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(500);
    // Body surfaces the BOOTSTRAP error, not the rollback error — the
    // operator's first concern is fixing the underlying git problem.
    const body = JSON.parse(res._getBody());
    expect(body.error).toMatch(/bootstrap.*alice/i);
    expect(body.error).toMatch(/origin\/main does not exist/);
    expect(body.error).not.toMatch(/disk full/);
  });

  it("POST 409 (5-cap or duplicate): bootstrap is NOT called (validation gate precedes side-effects)", async () => {
    // Pre-existing alice triggers the 409 dup-name path inside mutateAgents.
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord() }),
    );
    const wm = mkWorktreeManager();
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    await handlePostAgent(req, res, "danxbot", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(409);
    // Bootstrap MUST NOT be called when the create fails the 5-cap or
    // duplicate-name gate — running git worktree add for a name we just
    // refused to create is a side-effect leak.
    expect(wm.bootstrapCalls).toHaveLength(0);
  });

  it("POST handler skips bootstrap entirely when no manager is wired (legacy path stays green)", async () => {
    const req = authReqJSON("POST", {
      name: "alice",
      bio: "x",
      capabilities: ["issue-worker"],
      schedule: VALID_SCHEDULE,
      enabled: true,
    });
    const res = createMockRes();
    // tmpDeps() returns no worktreeManager — the handler must not throw or 500.
    await handlePostAgent(req, res, "danxbot", tmpDeps());
    expect(res._getStatusCode()).toBe(201);
  });
});

describe("handleDeleteAgent — WorktreeManager wiring (DX-161)", () => {
  beforeEach(() => {
    mockReadSettings.mockReturnValue(
      settingsWithAgents({ alice: validAgentRecord() }),
    );
    mockWriteSettings.mockResolvedValue(undefined);
    mockFindNonTerminalDispatches.mockResolvedValue([]);
  });

  it("DELETE 204 path: teardown is called BEFORE the settings record is removed", async () => {
    const order: string[] = [];
    const wm = mkWorktreeManager({
      teardownImpl: async () => {
        order.push("teardown");
      },
    });
    mockWriteSettings.mockImplementation(async () => {
      order.push("writeSettings");
    });

    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(204);
    expect(wm.teardownCalls).toEqual([
      { localPath: tmpRepoDir, agentName: "alice" },
    ]);
    expect(order).toEqual(["teardown", "writeSettings"]);
  });

  it("DELETE 500 on teardown failure: settings record stays in place; error surfaces", async () => {
    const wm = mkWorktreeManager({
      teardownImpl: async () => {
        throw new Error("worktree is locked");
      },
    });

    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/tear down.*alice/i);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("DELETE handler skips teardown entirely when no manager is wired", async () => {
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(204);
  });

  it("DELETE 409 (busy): teardown is NOT called (busy probe is the gate)", async () => {
    // A busy agent's worktree is in active use — tearing it down would
    // corrupt the in-flight dispatch's working tree. The busy probe must
    // run BEFORE teardown.
    mockFindNonTerminalDispatches.mockResolvedValue([
      { id: "d-1", status: "running" },
    ]);
    const wm = mkWorktreeManager();
    const req = authReqJSON("DELETE", null);
    const res = createMockRes();
    await handleDeleteAgent(req, res, "danxbot", "alice", {
      ...tmpDeps(),
      worktreeManager: wm,
    });

    expect(res._getStatusCode()).toBe(409);
    expect(wm.teardownCalls).toHaveLength(0);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });
});
