import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage } from "http";

const mockValidateToken = vi.fn();

vi.mock("./auth-db.js", () => ({
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}));

import { requireUser, checkAuthEither } from "./auth-middleware.js";

function makeReq(authHeader?: string): IncomingMessage {
  return {
    headers: { authorization: authHeader },
  } as unknown as IncomingMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireUser", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const r = await requireUser(makeReq(undefined));
    expect(r).toEqual({ ok: false, status: 401 });
    expect(mockValidateToken).not.toHaveBeenCalled();
  });

  it("returns 401 when header is present but does not start with Bearer", async () => {
    const r = await requireUser(makeReq("Basic abc"));
    expect(r).toEqual({ ok: false, status: 401 });
    expect(mockValidateToken).not.toHaveBeenCalled();
  });

  it("returns 401 when validateToken yields null (unknown/revoked/expired)", async () => {
    mockValidateToken.mockResolvedValueOnce(null);
    const r = await requireUser(makeReq("Bearer some-token"));
    expect(r).toEqual({ ok: false, status: 401 });
    expect(mockValidateToken).toHaveBeenCalledWith("some-token");
  });

  it("returns the authed user on a valid token", async () => {
    mockValidateToken.mockResolvedValueOnce({ userId: 42, username: "alice" });
    const r = await requireUser(makeReq("Bearer good-token"));
    expect(r).toEqual({
      ok: true,
      user: { userId: 42, username: "alice" },
    });
  });

  it("accepts an array-form Authorization header (Node's raw headers)", async () => {
    mockValidateToken.mockResolvedValueOnce({ userId: 42, username: "alice" });
    // Node preserves repeated headers as a string[]; extractBearer must
    // take the first entry rather than coerce the array to a string.
    const req = {
      headers: { authorization: ["Bearer good-token"] },
    } as unknown as IncomingMessage;
    const r = await requireUser(req);
    expect(r.ok).toBe(true);
    expect(mockValidateToken).toHaveBeenCalledWith("good-token");
  });
});

describe("checkAuthEither", () => {
  const DISPATCH_TOKEN = "super-secret-dispatch-token";

  it("accepts a valid user token and returns the user", async () => {
    mockValidateToken.mockResolvedValueOnce({ userId: 7, username: "bob" });
    const r = await checkAuthEither(
      makeReq("Bearer user-token"),
      DISPATCH_TOKEN,
    );
    expect(r.ok).toBe(true);
    expect(r.user).toEqual({ userId: 7, username: "bob" });
  });

  it("accepts the dispatch token when user token is absent", async () => {
    // No user match
    mockValidateToken.mockResolvedValueOnce(null);
    const r = await checkAuthEither(
      makeReq(`Bearer ${DISPATCH_TOKEN}`),
      DISPATCH_TOKEN,
    );
    expect(r.ok).toBe(true);
    // Dispatch-token path does not resolve a user
    expect(r.user).toBeUndefined();
  });

  it("rejects when neither matches", async () => {
    mockValidateToken.mockResolvedValueOnce(null);
    const r = await checkAuthEither(
      makeReq("Bearer garbage"),
      DISPATCH_TOKEN,
    );
    expect(r).toEqual({ ok: false, status: 401 });
  });

  it("rejects when header is missing entirely", async () => {
    const r = await checkAuthEither(makeReq(undefined), DISPATCH_TOKEN);
    expect(r).toEqual({ ok: false, status: 401 });
    // When header is absent, requireUser returns 401 before validateToken runs;
    // dispatch-token path also needs the header, so it also fails.
    expect(mockValidateToken).not.toHaveBeenCalled();
  });
});
