import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage } from "http";

const mockValidateToken = vi.fn();

vi.mock("./auth-db.js", () => ({
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}));

import { requireUser } from "./auth-middleware.js";

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

/**
 * Phase 4 removes `checkAuthEither` — the dashboard PATCH routes no
 * longer dual-allow the dispatch token. The dispatch-proxy routes
 * continue to use `checkAuth` from `dispatch-proxy.ts` directly; no
 * dashboard route imports `checkAuthEither` anywhere.
 */
describe("checkAuthEither (removed in Phase 4)", () => {
  it("is no longer exported from auth-middleware.ts", async () => {
    const mod = (await import("./auth-middleware.js")) as Record<string, unknown>;
    expect(mod["checkAuthEither"]).toBeUndefined();
  });

  it("is no longer referenced anywhere in dashboard route sources", () => {
    // Source-level guard: a regression that re-imports `checkAuthEither`
    // from a stale commit would compile, but this test pins the text.
    const sources = [
      "agents-routes.ts",
      "server.ts",
      "dispatch-proxy.ts",
      "auth-middleware.ts",
    ].map((f) => resolve(__dirname, f));
    for (const path of sources) {
      const body = readFileSync(path, "utf-8");
      expect(body).not.toContain("checkAuthEither");
    }
  });
});
