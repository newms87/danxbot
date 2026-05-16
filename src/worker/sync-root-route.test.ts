/**
 * DX-558 — `handleSyncRootRetry` worker handler smoke tests. The
 * route's whole job is to forward the configured repo into
 * `syncRepoRoot` and JSON-serialize the result. We mock the sync
 * function and assert the wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSyncRepoRoot = vi.fn();
vi.mock("./sync-root.js", () => ({
  syncRepoRoot: (...args: unknown[]) => mockSyncRepoRoot(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleSyncRootRetry } from "./sync-root-route.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

const REPO = makeRepoContext({
  name: "danxbot",
  localPath: "/tmp/repos/danxbot",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleSyncRootRetry", () => {
  it("forwards {repoName, repoLocalPath} from the RepoContext", async () => {
    mockSyncRepoRoot.mockResolvedValue({ status: "synced", error: null });
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleSyncRootRetry(req, res, REPO);

    expect(mockSyncRepoRoot).toHaveBeenCalledWith({
      repoName: "danxbot",
      repoLocalPath: "/tmp/repos/danxbot",
    });
  });

  it("returns 200 with the syncRepoRoot result body on the synced branch", async () => {
    const result = { status: "synced" as const, error: null };
    mockSyncRepoRoot.mockResolvedValue(result);
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleSyncRootRetry(req, res, REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual(result);
  });

  it("returns 200 with the error record when sync stays dirty (operator must clean up first)", async () => {
    const result = {
      status: "dirty" as const,
      error: {
        reason: "dirty" as const,
        detail: "working tree dirty: M src/a.ts",
        since: "2026-05-16T04:00:00.000Z",
        lastTriedAt: "2026-05-16T04:00:00.000Z",
      },
    };
    mockSyncRepoRoot.mockResolvedValue(result);
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleSyncRootRetry(req, res, REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual(result);
  });

  it("returns 500 when (contract-violating) syncRepoRoot throws", async () => {
    mockSyncRepoRoot.mockRejectedValue(new Error("unexpected boom"));
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleSyncRootRetry(req, res, REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toEqual({ error: "unexpected boom" });
  });
});
