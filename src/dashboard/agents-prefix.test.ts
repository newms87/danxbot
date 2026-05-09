import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "node:net";
import { createMockReqWithBody, createMockRes } from "../__tests__/helpers/http-mocks.js";
import type { RepoConfig } from "../types.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEventBusPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: { publish: (...args: unknown[]) => mockEventBusPublish(...args) },
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

const mockLoadIssuePrefix = vi.fn().mockReturnValue("ISS");
vi.mock("../issue-tracker/load-issue-prefix.js", () => ({
  loadIssuePrefix: (...args: unknown[]) => mockLoadIssuePrefix(...args),
}));

const mockRunMigration = vi.fn();
vi.mock("../../scripts/migrate-issue-prefix.js", () => ({
  runMigration: (...args: unknown[]) => mockRunMigration(...args),
}));

import { handlePutIssuePrefix } from "./agents-prefix.js";
import { deps, TEST_REPOS } from "./agents-test-fixtures.js";

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
      const adjusted = TEST_REPOS.map((r, i) =>
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

describe("handlePutIssuePrefix", () => {
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
    expect(body.migratedFiles).toBe(21);

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

  it("returns 500 when the prefix loader throws (config.yml unreadable)", async () => {
    mockLoadIssuePrefix.mockImplementation(() => {
      throw new Error("ENOENT: config.yml missing");
    });
    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue_prefix/);
    expect(mockRunMigration).not.toHaveBeenCalled();
  });

  it("returns 500 when runMigration throws synchronously", async () => {
    mockLoadIssuePrefix.mockReturnValue("ISS");
    mockRunMigration.mockImplementation(() => {
      throw new Error("internal migration crash");
    });
    const repos = await startWorkerStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobs: [] }));
    });

    const req = createMockReqWithBody("PUT", { prefix: "DX" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePutIssuePrefix(req, res, "danxbot", deps({ repos }));

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/Migration threw/);
    activeServer?.close();
  });
});
