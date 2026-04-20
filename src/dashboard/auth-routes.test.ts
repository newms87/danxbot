import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

const mockLoginDashboardUser = vi.fn();
const mockRevokeAllTokensForUser = vi.fn();
const mockValidateToken = vi.fn();

vi.mock("./auth-db.js", () => ({
  loginDashboardUser: (...args: unknown[]) =>
    mockLoginDashboardUser(...args),
  revokeAllTokensForUser: (...args: unknown[]) =>
    mockRevokeAllTokensForUser(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleLogin, handleLogout, handleMe } from "./auth-routes.js";

interface FakeRes {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  writeHead: (status: number, headers?: Record<string, string>) => FakeRes;
  end: (body?: string) => FakeRes;
}

function makeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead: vi.fn(function (status: number, headers?: Record<string, string>) {
      r.statusCode = status;
      if (headers) r.headers = { ...r.headers, ...headers };
      return r;
    }) as unknown as FakeRes["writeHead"],
    end: vi.fn(function (body?: string) {
      if (typeof body === "string") r.body = body;
      return r;
    }) as unknown as FakeRes["end"],
  };
  return r;
}

function makeReq(
  body: Record<string, unknown> | null,
  authHeader?: string,
): IncomingMessage {
  const serialized = body == null ? "" : JSON.stringify(body);
  const chunks: string[] = serialized ? [serialized] : [];
  // Minimal fake that mimics parseBody's event-based read.
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    listeners: {} as Record<string, Array<(arg?: unknown) => void>>,
    on(event: string, cb: (arg?: unknown) => void): IncomingMessage {
      (req.listeners[event] ??= []).push(cb);
      return req as unknown as IncomingMessage;
    },
  };

  // Drive the events on next tick so handlers that install listeners first
  // (parseBody does) still see them.
  queueMicrotask(() => {
    for (const chunk of chunks) {
      req.listeners["data"]?.forEach((cb) => cb(Buffer.from(chunk)));
    }
    req.listeners["end"]?.forEach((cb) => cb());
  });

  return req as unknown as IncomingMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleLogin", () => {
  it("returns 200 with {token, user} on valid credentials", async () => {
    mockLoginDashboardUser.mockResolvedValueOnce({
      userId: 42,
      rawToken: "raw-42",
    });
    const req = makeReq({ username: "alice", password: "pw" });
    const res = makeRes();

    await handleLogin(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      token: "raw-42",
      user: { username: "alice" },
    });
    expect(mockLoginDashboardUser).toHaveBeenCalledWith("alice", "pw");
  });

  it("returns 401 on wrong credentials (loginDashboardUser returns null)", async () => {
    mockLoginDashboardUser.mockResolvedValueOnce(null);
    const req = makeReq({ username: "alice", password: "wrong" });
    const res = makeRes();

    await handleLogin(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: "Invalid username or password",
    });
  });

  it("returns 400 when username is missing", async () => {
    const req = makeReq({ password: "pw" });
    const res = makeRes();

    await handleLogin(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
    expect(mockLoginDashboardUser).not.toHaveBeenCalled();
  });

  it("returns 400 when password is missing", async () => {
    const req = makeReq({ username: "alice" });
    const res = makeRes();

    await handleLogin(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
    expect(mockLoginDashboardUser).not.toHaveBeenCalled();
  });

  it("returns 400 when username or password are empty strings", async () => {
    const req = makeReq({ username: "", password: "" });
    const res = makeRes();

    await handleLogin(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(400);
    expect(mockLoginDashboardUser).not.toHaveBeenCalled();
  });

  it("returns 500 when loginDashboardUser throws (DB error)", async () => {
    mockLoginDashboardUser.mockRejectedValueOnce(new Error("db down"));
    const req = makeReq({ username: "alice", password: "pw" });
    const res = makeRes();

    await handleLogin(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(500);
  });
});

describe("handleLogout", () => {
  it("revokes all tokens and returns 204 on a valid user session", async () => {
    mockValidateToken.mockResolvedValueOnce({ userId: 42, username: "alice" });
    mockRevokeAllTokensForUser.mockResolvedValueOnce(undefined);
    const req = makeReq(null, "Bearer live-token");
    const res = makeRes();

    await handleLogout(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(204);
    expect(mockRevokeAllTokensForUser).toHaveBeenCalledWith(42);
  });

  it("returns 401 when the bearer is missing/invalid", async () => {
    mockValidateToken.mockResolvedValueOnce(null);
    const req = makeReq(null, "Bearer bad-token");
    const res = makeRes();

    await handleLogout(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(mockRevokeAllTokensForUser).not.toHaveBeenCalled();
  });

  it("returns 500 — and NOT 204 — when revokeAllTokensForUser throws", async () => {
    mockValidateToken.mockResolvedValueOnce({ userId: 42, username: "alice" });
    mockRevokeAllTokensForUser.mockRejectedValueOnce(new Error("DB down"));
    const req = makeReq(null, "Bearer live-token");
    const res = makeRes();

    await handleLogout(req, res as unknown as ServerResponse);

    // A silent revoke failure that still 204s would leave the server-side
    // token alive while the browser thinks it's logged out — worst case.
    expect(res.statusCode).toBe(500);
    expect(res.statusCode).not.toBe(204);
    expect(JSON.parse(res.body)).toEqual({ error: "Logout failed" });
  });
});

describe("handleMe", () => {
  it("returns {user: {username}} when the bearer is valid", async () => {
    mockValidateToken.mockResolvedValueOnce({ userId: 7, username: "bob" });
    const req = makeReq(null, "Bearer ok");
    const res = makeRes();

    await handleMe(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ user: { username: "bob" } });
  });

  it("returns 401 when the bearer is missing", async () => {
    const req = makeReq(null, undefined);
    const res = makeRes();

    await handleMe(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(mockValidateToken).not.toHaveBeenCalled();
  });
});
