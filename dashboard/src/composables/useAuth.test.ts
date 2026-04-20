import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAuth, LoginError, type CurrentUser } from "./useAuth";

const TOKEN_KEY = "danxbot.authToken";

function mockFetchResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

/**
 * The composable exposes module-scoped singleton refs so the login page
 * and header observe the same `currentUser`. Tests reset both the refs
 * and sessionStorage to guarantee test isolation.
 */
function seedAuth(
  rawToken: string | null,
  user: CurrentUser | null = null,
): void {
  if (rawToken) sessionStorage.setItem(TOKEN_KEY, rawToken);
  else sessionStorage.removeItem(TOKEN_KEY);
  const auth = useAuth();
  (auth.token as { value: string | null }).value = rawToken;
  (auth.currentUser as { value: CurrentUser | null }).value = user;
}

beforeEach(() => {
  sessionStorage.clear();
  seedAuth(null, null);
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("useAuth — init", () => {
  it("leaves currentUser null when no token is in sessionStorage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const auth = useAuth();
    expect(auth.token.value).toBeNull();

    await auth.init();

    expect(auth.currentUser.value).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("populates currentUser from /api/auth/me when the token is valid", async () => {
    sessionStorage.setItem(TOKEN_KEY, "good-token");
    const auth = useAuth();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        mockFetchResponse(200, { user: { username: "newms87" } }),
      );

    await auth.init();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", {
      headers: { Authorization: "Bearer good-token" },
    });
    expect(auth.token.value).toBe("good-token");
    expect(auth.currentUser.value).toEqual({ username: "newms87" });
  });

  it("clears local state when /api/auth/me returns 401", async () => {
    sessionStorage.setItem(TOKEN_KEY, "rotated");
    const auth = useAuth();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(401, { error: "Unauthorized" }),
    );

    await auth.init();

    expect(auth.token.value).toBeNull();
    expect(auth.currentUser.value).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("preserves the token on 5xx and surfaces initError so Login shows 'unreachable'", async () => {
    sessionStorage.setItem(TOKEN_KEY, "ok");
    const auth = useAuth();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(503, { error: "Service unavailable" }),
    );

    await auth.init();

    expect(auth.token.value).toBe("ok");
    expect(auth.currentUser.value).toBeNull();
    expect(auth.initError.value).toMatch(/unreachable/i);
  });

  it("preserves the token on network errors and surfaces initError", async () => {
    sessionStorage.setItem(TOKEN_KEY, "ok");
    const auth = useAuth();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));

    await auth.init();

    expect(auth.token.value).toBe("ok");
    expect(auth.currentUser.value).toBeNull();
    expect(auth.initError.value).toMatch(/unreachable/i);
  });

  it("clears initError at the start of every init()", async () => {
    sessionStorage.setItem(TOKEN_KEY, "ok");
    const auth = useAuth();
    // Seed stale error from a prior failed init.
    (auth.initError as { value: string | null }).value = "stale";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(200, { user: { username: "newms87" } }),
    );

    await auth.init();

    expect(auth.initError.value).toBeNull();
  });

  it("drops an inflight /me response when logout ran in the meantime", async () => {
    sessionStorage.setItem(TOKEN_KEY, "about-to-logout");
    const auth = useAuth();

    let resolveMe: (res: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (input: RequestInfo | URL) => {
        if (typeof input === "string" && input === "/api/auth/me") {
          return new Promise<Response>((r) => (resolveMe = r));
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );

    const pending = auth.init();
    // Intervening logout bumps the generation; `init` must not clobber
    // the cleared state when its /me fetch finally resolves.
    await auth.logout();

    resolveMe(mockFetchResponse(200, { user: { username: "zombie" } }));
    await pending;

    expect(auth.currentUser.value).toBeNull();
    expect(auth.token.value).toBeNull();
  });
});

describe("useAuth — login", () => {
  it("stores the token and user on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(200, {
        token: "fresh-token",
        user: { username: "newms87" },
      }),
    );

    const auth = useAuth();
    await auth.login("newms87", "hunter2");

    expect(auth.token.value).toBe("fresh-token");
    expect(auth.currentUser.value).toEqual({ username: "newms87" });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("fresh-token");
  });

  it("overwrites a stale token rather than only setting when empty", async () => {
    seedAuth("old-stale-token", { username: "old" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(200, {
        token: "brand-new",
        user: { username: "newms87" },
      }),
    );

    const auth = useAuth();
    await auth.login("newms87", "hunter2");

    expect(auth.token.value).toBe("brand-new");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("brand-new");
    expect(auth.currentUser.value).toEqual({ username: "newms87" });
  });

  it("throws LoginError(401) on wrong credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(401, { error: "Invalid username or password" }),
    );

    const auth = useAuth();
    await expect(auth.login("newms87", "wrong")).rejects.toMatchObject({
      name: "LoginError",
      status: 401,
    });
    expect(auth.token.value).toBeNull();
    expect(auth.currentUser.value).toBeNull();
  });

  it("throws LoginError(400) when the body is rejected as malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockFetchResponse(400, { error: "username and password are required" }),
    );

    const auth = useAuth();
    await expect(auth.login("", "")).rejects.toBeInstanceOf(LoginError);
  });
});

describe("useAuth — logout", () => {
  it("POSTs /api/auth/logout with the bearer, then clears local state", async () => {
    seedAuth("live-token", { username: "newms87" });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const auth = useAuth();
    await auth.logout();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer live-token" },
    });
    expect(auth.token.value).toBeNull();
    expect(auth.currentUser.value).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("clears local state even when the server is unreachable", async () => {
    seedAuth("live-token");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const auth = useAuth();
    await auth.logout();

    expect(auth.token.value).toBeNull();
    expect(auth.currentUser.value).toBeNull();
  });

  it("no-ops the fetch when there's no token, but still clears state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const auth = useAuth();

    await auth.logout();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.token.value).toBeNull();
    expect(auth.currentUser.value).toBeNull();
  });
});

describe("useAuth — handleExpired", () => {
  it("clears local state synchronously without hitting the network", () => {
    seedAuth("tok", { username: "newms87" });

    const fetchMock = vi.spyOn(globalThis, "fetch");

    const auth = useAuth();
    auth.handleExpired();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.token.value).toBeNull();
    expect(auth.currentUser.value).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
