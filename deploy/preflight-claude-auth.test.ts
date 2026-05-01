import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authPaths,
  MalformedCredsError,
  preflightClaudeAuth,
  realReadCreds,
  realRefreshOAuth,
  type ClaudeCredentials,
  type PreflightDeps,
  type RefreshResponse,
} from "./preflight-claude-auth.js";

const NOW = 1_777_000_000_000; // arbitrary fixed clock

function freshCreds(overrides: Partial<ClaudeCredentials["claudeAiOauth"]> = {}): ClaudeCredentials {
  return {
    claudeAiOauth: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: NOW + 60 * 60 * 1000, // +1h, valid
      ...overrides,
    },
  };
}

interface Harness {
  deps: PreflightDeps;
  store: { creds: ClaudeCredentials | null };
  refreshCalls: string[];
  reauthCalls: string[];
  logs: string[];
  refreshImpl: (refreshToken: string) => Promise<RefreshResponse | null>;
  reauthImpl: () => Promise<void>;
  setRefresh: (impl: (refreshToken: string) => Promise<RefreshResponse | null>) => void;
  setReauth: (impl: () => Promise<void>) => void;
}

function makeHarness(initial: ClaudeCredentials | null): Harness {
  const store = { creds: initial };
  const refreshCalls: string[] = [];
  const reauthCalls: string[] = [];
  const logs: string[] = [];
  let refreshImpl: (refreshToken: string) => Promise<RefreshResponse | null> = async () => null;
  let reauthImpl: () => Promise<void> = async () => {};

  const deps: PreflightDeps = {
    readCreds: async () => (store.creds ? structuredClone(store.creds) : null),
    writeCreds: async (_path, creds) => {
      store.creds = structuredClone(creds);
    },
    refreshOAuth: async (token) => {
      refreshCalls.push(token);
      return refreshImpl(token);
    },
    spawnReauth: async (dir) => {
      reauthCalls.push(dir);
      await reauthImpl();
    },
    now: () => NOW,
    log: (msg) => logs.push(msg),
  };

  return {
    deps,
    store,
    refreshCalls,
    reauthCalls,
    logs,
    get refreshImpl() {
      return refreshImpl;
    },
    get reauthImpl() {
      return reauthImpl;
    },
    setRefresh: (impl) => {
      refreshImpl = impl;
    },
    setReauth: (impl) => {
      reauthImpl = impl;
    },
  };
}

describe("authPaths", () => {
  it("matches the worker bind-mount layout (claudeConfigFile + claudeCredsDir)", () => {
    const paths = authPaths("/danxbot/claude-auth");
    expect(paths.claudeJson).toBe("/danxbot/claude-auth/.claude.json");
    expect(paths.credsDir).toBe("/danxbot/claude-auth/.claude");
    expect(paths.credentials).toBe(
      "/danxbot/claude-auth/.claude/.credentials.json",
    );
  });
});

describe("preflightClaudeAuth — happy path: refresh succeeds", () => {
  it("rewrites credentials with the new pair + extends expiresAt", async () => {
    const h = makeHarness(freshCreds());
    h.setRefresh(async () => ({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresInSec: 30 * 24 * 60 * 60, // 30 days
    }));

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out).toEqual({ ok: true, action: "refreshed" });
    expect(h.refreshCalls).toEqual(["old-refresh"]);
    expect(h.reauthCalls).toEqual([]);
    expect(h.store.creds?.claudeAiOauth.accessToken).toBe("new-access");
    expect(h.store.creds?.claudeAiOauth.refreshToken).toBe("new-refresh");
    expect(h.store.creds?.claudeAiOauth.expiresAt).toBe(
      NOW + 30 * 24 * 60 * 60 * 1000,
    );
  });

  it("preserves unrelated fields on the credentials object", async () => {
    const seed: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: NOW + 1000,
        scopes: ["user:inference"],
        rateLimitTier: "max",
      },
      foo: "bar",
    };
    const h = makeHarness(seed);
    h.setRefresh(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresInSec: 60,
    }));

    await preflightClaudeAuth("/auth", h.deps);

    expect(h.store.creds?.foo).toBe("bar");
    expect(h.store.creds?.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(h.store.creds?.claudeAiOauth.rateLimitTier).toBe("max");
  });
});

describe("preflightClaudeAuth — refresh fails but token is still valid", () => {
  it("keeps the existing creds, returns action=kept, logs a warning", async () => {
    const h = makeHarness(freshCreds()); // expiresAt = NOW + 1h
    h.setRefresh(async () => null);

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out).toEqual({ ok: true, action: "kept" });
    expect(h.reauthCalls).toEqual([]);
    expect(h.store.creds?.claudeAiOauth.accessToken).toBe("old-access");
    expect(
      h.logs.some((m) => m.includes("WARNING") && m.includes("refresh failed")),
    ).toBe(true);
  });
});

describe("preflightClaudeAuth — token expired AND refresh fails", () => {
  it("triggers reauth, then succeeds when reauth writes fresh creds", async () => {
    const h = makeHarness(freshCreds({ expiresAt: NOW - 1000 }));
    h.setRefresh(async () => null);
    h.setReauth(async () => {
      h.store.creds = freshCreds({
        accessToken: "post-reauth",
        refreshToken: "post-refresh",
        expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
      });
    });

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out).toEqual({ ok: true, action: "reauthed" });
    expect(h.reauthCalls).toEqual(["/auth"]);
    expect(h.store.creds?.claudeAiOauth.accessToken).toBe("post-reauth");
  });

  it("returns reauth_failed when reauth leaves creds unchanged + expired", async () => {
    const h = makeHarness(freshCreds({ expiresAt: NOW - 1000 }));
    h.setRefresh(async () => null);
    h.setReauth(async () => {
      // user canceled — file unchanged
    });

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("reauth_failed");
      expect(out.summary).toContain("HOME=/auth claude auth login");
    }
  });

  it("returns reauth_failed when reauth deletes the file entirely", async () => {
    const h = makeHarness(freshCreds({ expiresAt: NOW - 1000 }));
    h.setRefresh(async () => null);
    h.setReauth(async () => {
      h.store.creds = null;
    });

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("reauth_failed");
    }
  });
});

describe("preflightClaudeAuth — credentials file missing", () => {
  it("triggers reauth without attempting refresh", async () => {
    const h = makeHarness(null);
    h.setReauth(async () => {
      h.store.creds = freshCreds({ expiresAt: NOW + 60 * 60 * 1000 });
    });

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out).toEqual({ ok: true, action: "reauthed" });
    expect(h.refreshCalls).toEqual([]);
    expect(h.reauthCalls).toEqual(["/auth"]);
  });

  it("returns reauth_failed when the missing file is not produced by reauth", async () => {
    const h = makeHarness(null);
    h.setReauth(async () => {
      // user canceled
    });

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("reauth_failed");
    }
  });
});

describe("preflightClaudeAuth — malformed credentials", () => {
  it("returns malformed when claudeAiOauth is absent (does not call refresh or reauth)", async () => {
    const h = makeHarness({ foo: "bar" } as unknown as ClaudeCredentials);

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("malformed");
      expect(out.summary).toContain("claudeAiOauth");
    }
    expect(h.refreshCalls).toEqual([]);
    expect(h.reauthCalls).toEqual([]);
  });

  it("returns malformed when refreshToken is missing", async () => {
    const broken: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: undefined as unknown as string,
        expiresAt: NOW + 1000,
      },
    };
    const h = makeHarness(broken);

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.reason).toBe("malformed");
  });

  it("returns malformed when expiresAt is not a number", async () => {
    const broken: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: "soon" as unknown as number,
      },
    };
    const h = makeHarness(broken);

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.reason).toBe("malformed");
  });
});

describe("preflightClaudeAuth — refresh response ordering", () => {
  it("uses deps.now() at the moment of write, not at invocation start", async () => {
    const clock = { value: NOW };
    const h = makeHarness(freshCreds());
    // Override the now() via deps directly — replicates a long fetch
    // that lets the wall clock advance.
    const customDeps: PreflightDeps = {
      ...h.deps,
      now: () => clock.value,
      refreshOAuth: async () => {
        clock.value += 5 * 1000; // simulate 5s network call
        return {
          accessToken: "x",
          refreshToken: "y",
          expiresInSec: 100,
        };
      },
    };

    await preflightClaudeAuth("/auth", customDeps);

    // expiresAt must use the post-fetch clock (NOW + 5s + 100s), not
    // the pre-fetch clock — getting this wrong would make every refresh
    // shorten the window by the fetch duration.
    expect(h.store.creds?.claudeAiOauth.expiresAt).toBe(
      NOW + 5 * 1000 + 100 * 1000,
    );
  });
});

describe("preflightClaudeAuth — does not call writeCreds when refresh fails", () => {
  it("leaves the file untouched on the kept path", async () => {
    const h = makeHarness(freshCreds());
    const writeSpy = vi.spyOn(h.deps, "writeCreds");
    h.setRefresh(async () => null);

    await preflightClaudeAuth("/auth", h.deps);

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("preflightClaudeAuth — readCreds throws MalformedCredsError", () => {
  it("returns malformed without calling refresh or reauth (initial read)", async () => {
    const h = makeHarness(null);
    h.deps.readCreds = async () => {
      throw new MalformedCredsError("/auth/.claude/.credentials.json", "bad json");
    };

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("malformed");
      expect(out.summary).toContain("unreadable");
      expect(out.summary).toContain("bad json");
    }
    expect(h.refreshCalls).toEqual([]);
    expect(h.reauthCalls).toEqual([]);
  });

  it("returns malformed when post-reauth re-read throws", async () => {
    const h = makeHarness(null);
    let callCount = 0;
    h.deps.readCreds = async () => {
      callCount += 1;
      if (callCount === 1) return null; // first read: file missing → reauth
      throw new MalformedCredsError(
        "/auth/.claude/.credentials.json",
        "corrupted post-reauth",
      );
    };

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("malformed");
      expect(out.summary).toContain("corrupted post-reauth");
    }
    expect(h.reauthCalls).toEqual(["/auth"]);
  });

  it("propagates non-MalformedCredsError errors from readCreds", async () => {
    const h = makeHarness(null);
    h.deps.readCreds = async () => {
      throw new Error("disk EIO");
    };

    await expect(preflightClaudeAuth("/auth", h.deps)).rejects.toThrow(
      "disk EIO",
    );
  });
});

describe("preflightClaudeAuth — reauth produces malformed expiresAt", () => {
  it("returns reauth_failed when expiresAt is non-numeric post-reauth", async () => {
    const h = makeHarness(freshCreds({ expiresAt: NOW - 1000 }));
    h.setRefresh(async () => null);
    h.setReauth(async () => {
      h.store.creds = {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "y",
          expiresAt: "later" as unknown as number, // malformed type
        },
      };
    });

    const out = await preflightClaudeAuth("/auth", h.deps);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe("reauth_failed");
      expect(out.summary).toContain("expired/malformed");
    }
  });
});

describe("realReadCreds — integration with tmpdir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preflight-creds-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const result = await realReadCreds(join(dir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns parsed object when file is valid JSON", async () => {
    const path = join(dir, "valid.json");
    const payload = {
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 12345,
      },
    };
    writeFileSync(path, JSON.stringify(payload));
    const result = await realReadCreds(path);
    expect(result).toEqual(payload);
  });

  it("throws MalformedCredsError when file is corrupt JSON", async () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "not valid json {{{");
    await expect(realReadCreds(path)).rejects.toThrow(MalformedCredsError);
    await expect(realReadCreds(path)).rejects.toThrow("unreadable");
  });

  it("throws MalformedCredsError when file is empty", async () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "");
    // Empty file is invalid JSON to JSON.parse → MalformedCredsError.
    // (Note: existsSync returns true for zero-byte files.)
    expect(existsSync(path)).toBe(true);
    await expect(realReadCreds(path)).rejects.toThrow(MalformedCredsError);
  });
});

describe("realRefreshOAuth — fetch branches with stubbed global", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null + warns on network error (fetch throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ENETUNREACH")) as unknown as typeof fetch;

    const result = await realRefreshOAuth("any-token");

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENETUNREACH"));
  });

  it("returns null + warns on non-2xx HTTP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_grant"}',
    } as unknown as Response) as unknown as typeof fetch;

    const result = await realRefreshOAuth("dead-token");

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid_grant"));
  });

  it("returns null + warns when response is not JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response) as unknown as typeof fetch;

    const result = await realRefreshOAuth("any");

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not JSON"));
  });

  it("returns null + warns when response missing required fields", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "a" }), // missing refresh_token + expires_in
    } as unknown as Response) as unknown as typeof fetch;

    const result = await realRefreshOAuth("any");

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("response missing"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("access_token"));
  });

  it("returns null when fields have wrong types", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 42, // wrong type
        refresh_token: "r",
        expires_in: 100,
      }),
    } as unknown as Response) as unknown as typeof fetch;

    const result = await realRefreshOAuth("any");
    expect(result).toBeNull();
  });

  it("returns mapped pair on valid 200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    } as unknown as Response) as unknown as typeof fetch;

    const result = await realRefreshOAuth("input-refresh");

    expect(result).toEqual<RefreshResponse>({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresInSec: 3600,
    });
  });

  it("posts to the OAuth endpoint with the right body shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "a",
        refresh_token: "r",
        expires_in: 60,
      }),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await realRefreshOAuth("my-refresh-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("my-refresh-token");
    expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
});
