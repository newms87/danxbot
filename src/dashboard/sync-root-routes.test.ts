/**
 * DX-558 — dashboard route coverage. Two handlers:
 *
 *   - `handleListSyncRootStates` (GET /api/sync-root) — 401 without
 *     user bearer; 200 returning only repos in error state.
 *   - `handleSyncRootRetryProxy` (POST /api/sync-root/:repo) — 401
 *     without bearer; 404 for unknown repo; 500 when port unresolved;
 *     proxies to the worker on the happy path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./auth-middleware.js", () => ({
  requireUser: async (req: { headers: { authorization?: string } }) => {
    const h = req.headers?.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!t || !t.startsWith("user-")) return { ok: false, status: 401 };
    return { ok: true, user: { userId: 1, username: t.slice(5) } };
  },
}));

const mockProxy = vi.fn();
vi.mock("./dispatch-proxy.js", async () => {
  const actual = await vi.importActual<typeof import("./dispatch-proxy.js")>(
    "./dispatch-proxy.js",
  );
  return {
    ...actual,
    proxyToWorkerWithFallback: (...args: unknown[]) => mockProxy(...args),
  };
});

import {
  handleListSyncRootStates,
  handleSyncRootRetryProxy,
  type SyncRootRouteDeps,
} from "./sync-root-routes.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import type { IncomingMessage } from "http";
import type { RepoRootSyncError } from "../worker/sync-root.js";
import type { SyncRootWatcherHandle } from "./sync-root-watcher.js";

const ERR_DIRTY: RepoRootSyncError = {
  reason: "dirty",
  detail: "working tree dirty: M src/a.ts",
  since: "2026-05-16T04:00:00.000Z",
  lastTriedAt: "2026-05-16T04:00:00.000Z",
};

function makeDeps(over: Partial<SyncRootRouteDeps> = {}): SyncRootRouteDeps {
  const watcher: SyncRootWatcherHandle = {
    readState: vi.fn().mockReturnValue(null),
    simulate: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    repos: [{ name: "danxbot" }, { name: "platform" }],
    watcher,
    proxy: {
      token: "test-token",
      repos: [
        { name: "danxbot", url: "u", localPath: "/p/danxbot", workerPort: 5562 },
        { name: "platform", url: "u", localPath: "/p/platform", workerPort: 5563 },
      ] as unknown as SyncRootRouteDeps["proxy"]["repos"],
      resolveHost: (name: string) => `danxbot-worker-${name}`,
    } as SyncRootRouteDeps["proxy"],
    resolveWorkerPort: (name: string) =>
      ({ danxbot: 5562, platform: 5563 })[name] ?? null,
    ...over,
  };
}

function reqWithAuth(token: string | null): IncomingMessage {
  const req = createMockReqWithBody("GET", {}) as unknown as IncomingMessage;
  if (token) {
    (req.headers as Record<string, string>).authorization = `Bearer ${token}`;
  }
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleListSyncRootStates", () => {
  it("returns 401 without a user bearer (dispatch token is rejected at this route)", async () => {
    const res = createMockRes();
    await handleListSyncRootStates(reqWithAuth(null), res, makeDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 200 with an empty list when every repo is clean", async () => {
    const res = createMockRes();
    await handleListSyncRootStates(reqWithAuth("user-dan"), res, makeDeps());
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ states: [] });
  });

  it("returns 200 listing only the repos whose watcher.readState is non-null", async () => {
    const watcher: SyncRootWatcherHandle = {
      readState: vi.fn((name: string) => (name === "danxbot" ? ERR_DIRTY : null)),
      simulate: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const res = createMockRes();
    await handleListSyncRootStates(
      reqWithAuth("user-dan"),
      res,
      makeDeps({ watcher }),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      states: [{ repoName: "danxbot", error: ERR_DIRTY }],
    });
  });
});

describe("handleSyncRootRetryProxy", () => {
  it("returns 401 without a user bearer", async () => {
    const res = createMockRes();
    await handleSyncRootRetryProxy(
      reqWithAuth(null),
      res,
      "danxbot",
      makeDeps(),
    );
    expect(res._getStatusCode()).toBe(401);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const res = createMockRes();
    await handleSyncRootRetryProxy(
      reqWithAuth("user-dan"),
      res,
      "ghost",
      makeDeps(),
    );
    expect(res._getStatusCode()).toBe(404);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("returns 500 when the worker port can't be resolved (misconfig)", async () => {
    const res = createMockRes();
    const deps = makeDeps({ resolveWorkerPort: () => null });
    await handleSyncRootRetryProxy(
      reqWithAuth("user-dan"),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(500);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("proxies to the worker's POST /api/sync-root on the happy path", async () => {
    mockProxy.mockResolvedValue(undefined);
    const res = createMockRes();
    await handleSyncRootRetryProxy(
      reqWithAuth("user-dan"),
      res,
      "danxbot",
      makeDeps(),
    );
    expect(mockProxy).toHaveBeenCalledTimes(1);
    const callArgs = mockProxy.mock.calls[0];
    // proxyToWorkerWithFallback(req, res, upstream, body)
    expect(callArgs[2]).toEqual({
      repoName: "danxbot",
      primaryHost: "danxbot-worker-danxbot",
      port: 5562,
      path: "/api/sync-root",
      method: "POST",
    });
    expect(callArgs[3]).toBeNull();
  });
});
