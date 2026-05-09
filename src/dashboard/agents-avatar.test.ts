import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockRes } from "../__tests__/helpers/http-mocks.js";
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
      await mockWriteSettings(localPath, { agents: next, writtenBy });
      return merged;
    },
    DASHBOARD_PREFIX: "dashboard:",
  };
});

vi.mock("../critical-failure.js", () => ({
  readFlag: vi.fn().mockReturnValue(null),
}));

vi.mock("./dispatches-db.js", () => ({
  countDispatchesByRepo: vi.fn().mockResolvedValue({}),
  findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
}));

vi.mock("./event-bus.js", () => ({
  eventBus: { publish: vi.fn() },
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

import { handleGetAvatar, handlePostAvatar } from "./agents-avatar.js";
import {
  settingsWithAgents,
  validAgentRecord,
} from "./agents-test-fixtures.js";

let tmpRepoDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  tmpRepoDir = mkdtempSync(
    resolvePath(tmpdir(), "danxbot-agents-avatar-test-"),
  );
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

function mockBinaryReq(method: string, contentType: string, body: Buffer) {
  const req = new (require("http") as typeof import("http")).IncomingMessage(
    null as never,
  );
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

  it("returns 401 without a user bearer", async () => {
    const req = new (
      require("http") as typeof import("http")
    ).IncomingMessage(null as never);
    req.method = "POST";
    req.headers = { "content-type": "image/png" };
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 415 for unsupported MIME types", async () => {
    const req = mockBinaryReq(
      "POST",
      "application/pdf",
      Buffer.from([0x25, 0x50]),
    );
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(415);
  });

  it("returns 413 when the body exceeds 1 MB", async () => {
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
    const req = mockBinaryReq(
      "POST",
      "image/png",
      Buffer.from([0x89, 0x50]),
    );
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "nobody", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("happy path: writes the file, updates avatar_path + updated_at, returns the record", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const req = mockBinaryReq("POST", "image/png", png);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.avatar_path).toBe("agents/alice/avatar.png");
    expect(body.updated_at).not.toBe("2026-05-08T12:00:00Z");

    const onDisk = readFileSync(
      resolvePath(tmpRepoDir, ".danxbot/agents/alice/avatar.png"),
    );
    expect(onDisk.equals(png)).toBe(true);

    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.agents.alice.avatar_path).toBe("agents/alice/avatar.png");
  });

  it("removes a stale prior-extension avatar when the new upload uses a different MIME", async () => {
    const dir = resolvePath(tmpRepoDir, ".danxbot/agents/alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolvePath(dir, "avatar.png"), Buffer.from([0x00]));

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
      existsSync(
        resolvePath(tmpRepoDir, ".danxbot/agents/alice/avatar.webp"),
      ),
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

  it("returns 500 when writeSettings throws after the bytes have already landed (DX-160 backfill)", async () => {
    mockWriteSettings.mockRejectedValue(new Error("disk full"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const req = mockBinaryReq("POST", "image/png", png);
    const res = createMockRes();
    await handlePostAvatar(req, res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/avatar metadata/);
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
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
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
    mockReadSettings.mockReturnValue(
      settingsWithAgents({
        alice: validAgentRecord({
          avatar_path: "../../../etc/passwd",
        }),
      }),
    );
    const res = createMockRes();
    await handleGetAvatar(res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 500 when readSettings throws (DX-160 backfill)", async () => {
    mockReadSettings.mockImplementation(() => {
      throw new Error("disk corrupt");
    });
    const res = createMockRes();
    await handleGetAvatar(res, "danxbot", "alice", tmpDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/Failed to read settings/);
  });
});
