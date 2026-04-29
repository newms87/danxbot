/**
 * Auth-flow composition test.
 *
 * Wires the real `handleLogin` / `handleMe` / `handleLogout` plus the
 * `requireUser` gate (the same one server.ts applies to every /api/*
 * route) against a single shared in-memory fake of `auth-db.ts`. Per-
 * handler unit tests already cover each route in isolation; this test
 * exists to lock the *composition* — that the token a successful login
 * hands out is the same shape `validateToken` accepts, that
 * `revokeAllTokensForUser` invalidates the same tokens the gate
 * consults, and that the rotate-on-login single-session contract holds
 * across login → /me → logout → re-login.
 *
 * Layer-1 only: the fake stands in for MySQL so this runs with no
 * docker / env / real-API cost. The format roundtrip between
 * `issueFreshToken` and `validateToken` against real bcrypt + sha256 is
 * already pinned in `auth-db.test.ts`; live curl on prod covers the
 * full HTTP path. Trello card JcJOdNNZ for the gap rationale.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import http from "http";
import { json } from "../http/helpers.js";

// Hoisted alongside `vi.mock` so the factory closure below can reference
// `db` safely regardless of how vitest schedules module init in the
// future. Same pattern is documented as the recommended way to share
// state with a `vi.mock` factory.
const { db, resetDb, seedUser, rotateAndIssue } = vi.hoisted(() => {
  interface FakeAuthDb {
    users: Map<string, { id: number; password: string }>;
    tokens: Map<string, { userId: number; revoked: boolean }>;
    nextUserId: number;
    nextTokenSeq: number;
  }

  const db: FakeAuthDb = {
    users: new Map(),
    tokens: new Map(),
    nextUserId: 1,
    nextTokenSeq: 1,
  };

  function resetDb(): void {
    db.users.clear();
    db.tokens.clear();
    db.nextUserId = 1;
    db.nextTokenSeq = 1;
  }

  function seedUser(username: string, password: string): number {
    const id = db.nextUserId++;
    db.users.set(username, { id, password });
    return id;
  }

  // Mirrors `issueFreshToken` in auth-db.ts: every successful login
  // revokes the user's existing active tokens before issuing a fresh
  // one. Locking this here is the whole point of the rotate-on-login
  // test below.
  function rotateAndIssue(userId: number): string {
    for (const t of db.tokens.values()) {
      if (t.userId === userId) t.revoked = true;
    }
    const raw = `tok-${db.nextTokenSeq++}`;
    db.tokens.set(raw, { userId, revoked: false });
    return raw;
  }

  return { db, resetDb, seedUser, rotateAndIssue };
});

vi.mock("./auth-db.js", () => ({
  loginDashboardUser: async (username: string, password: string) => {
    const u = db.users.get(username);
    if (!u || u.password !== password) return null;
    return { userId: u.id, rawToken: rotateAndIssue(u.id) };
  },
  validateToken: async (rawToken: string) => {
    const t = db.tokens.get(rawToken);
    if (!t || t.revoked) return null;
    for (const [name, u] of db.users) {
      if (u.id === t.userId) return { userId: t.userId, username: name };
    }
    return null;
  },
  revokeAllTokensForUser: async (userId: number) => {
    for (const t of db.tokens.values()) {
      if (t.userId === userId) t.revoked = true;
    }
  },
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
import { requireUser } from "./auth-middleware.js";
import {
  createMockReq,
  createMockRes,
  createMockReqWithBody,
  type MockResponse,
} from "../__tests__/helpers/http-mocks.js";

function withAuth(
  req: http.IncomingMessage,
  token: string,
): http.IncomingMessage {
  req.headers.authorization = `Bearer ${token}`;
  return req;
}

function loginReq(
  username: string,
  password: string,
): http.IncomingMessage {
  return createMockReqWithBody("POST", { username, password });
}

// Replicates server.ts's blanket /api/* gate: `requireUser` returns
// 401 on failure, otherwise the handler runs. Composing the gate over
// the same fake auth-db is the contract this integration test locks —
// a regression where logout's revokeAll didn't invalidate the tokens
// validateToken accepts would slip past the per-handler unit tests.
async function callGatedReposRoute(
  req: http.IncomingMessage,
  res: MockResponse,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  json(res, 200, [{ name: "platform", url: "https://example/p.git" }]);
}

beforeEach(() => {
  resetDb();
});

describe("auth flow composition", () => {
  it("login → /me → /repos → logout makes every gated bearer 401", async () => {
    seedUser("alice", "pw");

    const loginRes = createMockRes();
    await handleLogin(loginReq("alice", "pw"), loginRes);
    expect(loginRes._getStatusCode()).toBe(200);
    const { token } = JSON.parse(loginRes._getBody());
    expect(typeof token).toBe("string");
    expect(token).toMatch(/^tok-\d+$/);

    const meRes = createMockRes();
    await handleMe(
      withAuth(createMockReq("GET", "/api/auth/me"), token),
      meRes,
    );
    expect(meRes._getStatusCode()).toBe(200);
    expect(JSON.parse(meRes._getBody())).toEqual({
      user: { username: "alice" },
    });

    // Gate let the bearer through.
    const reposRes = createMockRes();
    await callGatedReposRoute(
      withAuth(createMockReq("GET", "/api/repos"), token),
      reposRes,
    );
    expect(reposRes._getStatusCode()).toBe(200);

    const logoutRes = createMockRes();
    await handleLogout(
      withAuth(createMockReq("POST", "/api/auth/logout"), token),
      logoutRes,
    );
    expect(logoutRes._getStatusCode()).toBe(204);

    // Same bearer is now revoked — both /me and the gate must drop it.
    const meRevokedRes = createMockRes();
    await handleMe(
      withAuth(createMockReq("GET", "/api/auth/me"), token),
      meRevokedRes,
    );
    expect(meRevokedRes._getStatusCode()).toBe(401);

    const reposRevokedRes = createMockRes();
    await callGatedReposRoute(
      withAuth(createMockReq("GET", "/api/repos"), token),
      reposRevokedRes,
    );
    expect(reposRevokedRes._getStatusCode()).toBe(401);
  });

  it("rotate-on-login: a second login invalidates the prior session's token", async () => {
    seedUser("alice", "pw");

    const login1 = createMockRes();
    await handleLogin(loginReq("alice", "pw"), login1);
    expect(login1._getStatusCode()).toBe(200);
    const { token: token1 } = JSON.parse(login1._getBody());

    // Second login for the same user — the rotate-on-login contract
    // (auth-db.ts line 31) says token1 must now be revoked.
    const login2 = createMockRes();
    await handleLogin(loginReq("alice", "pw"), login2);
    expect(login2._getStatusCode()).toBe(200);
    const { token: token2 } = JSON.parse(login2._getBody());
    expect(token2).not.toBe(token1);

    const meOld = createMockRes();
    await handleMe(
      withAuth(createMockReq("GET", "/api/auth/me"), token1),
      meOld,
    );
    expect(meOld._getStatusCode()).toBe(401);

    const meNew = createMockRes();
    await handleMe(
      withAuth(createMockReq("GET", "/api/auth/me"), token2),
      meNew,
    );
    expect(meNew._getStatusCode()).toBe(200);
    expect(JSON.parse(meNew._getBody())).toEqual({
      user: { username: "alice" },
    });
  });

  it("/api/repos with no Authorization header → 401 (gate baseline)", async () => {
    const res = createMockRes();
    await callGatedReposRoute(createMockReq("GET", "/api/repos"), res);
    expect(res._getStatusCode()).toBe(401);
  });

  it("/api/repos with a bearer that was never issued → 401", async () => {
    const res = createMockRes();
    await callGatedReposRoute(
      withAuth(createMockReq("GET", "/api/repos"), "never-issued"),
      res,
    );
    expect(res._getStatusCode()).toBe(401);
  });
});
