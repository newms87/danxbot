import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage } from "http";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
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

const { mockWriteRepoEnvVars, mockParseEnvFile, mockFetch } = vi.hoisted(
  () => ({
    mockWriteRepoEnvVars: vi.fn(),
    mockParseEnvFile: vi.fn(),
    mockFetch: vi.fn(),
  }),
);

vi.mock("./repo-env-writer.js", () => ({
  writeRepoEnvVars: mockWriteRepoEnvVars,
  repoEnvFilePath: (p: string) => `${p}/.danxbot/.env`,
}));

vi.mock("../env-file.js", () => ({
  parseEnvFile: mockParseEnvFile,
}));

import {
  handleGetGithubCredentials,
  handlePatchGithubCredentials,
  _resetForTesting,
  _setFetchImplForTesting,
  readGithubCredentialsSnapshot,
  extractProbeMetadata,
  parseGithubExpiryHeader,
} from "./agents-github.js";
import { deps } from "./agents-test-fixtures.js";

const VALID_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const VALID_FINE_GRAINED = "github_pat_abcdef0123456789_xyz";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteRepoEnvVars.mockReset();
  mockWriteRepoEnvVars.mockResolvedValue([]);
  mockParseEnvFile.mockReset();
  mockParseEnvFile.mockReturnValue({});
  mockFetch.mockReset();
  _resetForTesting();
  _setFetchImplForTesting(mockFetch as unknown as typeof fetch);
});

// ============================================================
// GET /api/agents/:repo/github-credentials
// ============================================================

describe("handleGetGithubCredentials", () => {
  function authReq(token = "user-newms87"): IncomingMessage {
    const req = createMockReqWithBody("GET", {});
    (req.headers as Record<string, string>)["authorization"] =
      `Bearer ${token}`;
    return req;
  }

  it("returns 401 without a user bearer", async () => {
    const req = createMockReqWithBody("GET", {});
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("rejects the dispatch token (per-user bearer only)", async () => {
    const req = createMockReqWithBody("GET", {});
    (req.headers as Record<string, string>)["authorization"] =
      "Bearer test-dispatch-token";
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 404 for an unknown repo", async () => {
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "nonexistent", deps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns registered=false when DANX_GITHUB_TOKEN is missing", async () => {
    mockParseEnvFile.mockReturnValue({});
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toEqual({
      registered: false,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error: null,
      token_prefix: "",
      token_suffix: "",
      token_expires_at: null,
      token_user_login: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns registered=true + token_shape_valid=true for a valid classic PAT", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ login: "alice" }), { status: 200 }),
    );
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.registered).toBe(true);
    expect(body.token_shape_valid).toBe(true);
    expect(body.last_validation_error).toBe(null);
    expect(typeof body.last_validated_at).toBe("string");
  });

  it("recognizes fine-grained tokens (github_pat_...)", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_FINE_GRAINED });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ login: "alice" }), { status: 200 }),
    );
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.token_shape_valid).toBe(true);
  });

  it("flags malformed tokens with token_shape_valid=false + skips the probe", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: "not-a-pat" });
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.registered).toBe(true);
    expect(body.token_shape_valid).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(body.last_validation_error).toMatch(/shape/i);
  });

  it("never includes the token value in the response body", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    expect(res._getBody()).not.toContain(VALID_TOKEN);
  });

  it("populates last_validation_error on 401 from GitHub", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(
      new Response("Bad credentials", { status: 401 }),
    );
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.token_shape_valid).toBe(true);
    expect(body.last_validation_error).toMatch(/401|revoked|invalid/i);
  });

  it("populates last_validation_error on 403 from GitHub", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.last_validation_error).toMatch(/403|forbidden/i);
  });

  it("populates last_validation_error on probe network failure", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.last_validation_error).toMatch(/ECONNREFUSED|network/i);
  });

  it("caches the probe result for 5 minutes — second call within window does not re-probe", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req1 = authReq();
    const res1 = createMockRes();
    await handleGetGithubCredentials(req1, res1, "danxbot", deps());

    const req2 = authReq();
    const res2 = createMockRes();
    await handleGetGithubCredentials(req2, res2, "danxbot", deps());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res2._getBody()).last_validation_error).toBe(null);
  });

  it("uses Authorization: token <PAT> header and 5s timeout against api.github.com/user", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req = authReq();
    const res = createMockRes();
    await handleGetGithubCredentials(req, res, "danxbot", deps());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/user");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`token ${VALID_TOKEN}`);
    expect((init as RequestInit).signal).toBeDefined();
  });
});

// ============================================================
// PATCH /api/agents/:repo/github-credentials
// ============================================================

describe("handlePatchGithubCredentials", () => {
  function authReq(
    body: Record<string, unknown>,
    token = "user-newms87",
  ): IncomingMessage {
    const req = createMockReqWithBody("PATCH", body);
    (req.headers as Record<string, string>)["authorization"] =
      `Bearer ${token}`;
    return req;
  }

  it("returns 401 without a user bearer", async () => {
    const req = createMockReqWithBody("PATCH", { token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("rejects the dispatch token", async () => {
    const req = authReq({ token: VALID_TOKEN }, "test-dispatch-token");
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "nonexistent", deps());
    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not valid JSON", async () => {
    const { IncomingMessage: IM } = await import("http");
    const req = new IM(null as never);
    req.method = "PATCH";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/JSON/i);
  });

  it("returns 422 when token is missing", async () => {
    const req = authReq({});
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(422);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 422 for a non-string token", async () => {
    const req = authReq({ token: 42 });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(422);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 422 for an empty token", async () => {
    const req = authReq({ token: "" });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(422);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 422 for a malformed token", async () => {
    const req = authReq({ token: "not-a-pat" });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(422);
    expect(JSON.parse(res._getBody()).error).toMatch(/shape/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("returns 422 when the token contains a newline", async () => {
    const req = authReq({ token: "ghp_good\nbad" });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(422);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("writes DANX_GITHUB_TOKEN via repo-env-writer on happy path", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteRepoEnvVars).toHaveBeenCalledWith({
      repoLocalPath: "/repos/danxbot",
      updates: { DANX_GITHUB_TOKEN: VALID_TOKEN },
      writtenBy: "dashboard:newms87",
    });
  });

  it("returns 200 with the new status snapshot on happy path", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.registered).toBe(true);
    expect(body.token_shape_valid).toBe(true);
    expect(body.last_validation_error).toBe(null);
  });

  it("triggers an immediate probe after write — cache invalidated", async () => {
    // Seed the cache with a stale value
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValueOnce(
      new Response("Bad credentials", { status: 401 }),
    );
    await handleGetGithubCredentials(
      (() => {
        const r = createMockReqWithBody("GET", {});
        (r.headers as Record<string, string>)["authorization"] =
          "Bearer user-newms87";
        return r;
      })(),
      createMockRes(),
      "danxbot",
      deps(),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // PATCH should re-probe (fresh validation), not serve cached 401
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res._getBody()).last_validation_error).toBe(null);
  });

  it("returns 422 on validation probe failure — does NOT write the env", async () => {
    mockFetch.mockResolvedValue(
      new Response("Bad credentials", { status: 401 }),
    );
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(422);
    expect(JSON.parse(res._getBody()).error).toMatch(/401|invalid/i);
    expect(mockWriteRepoEnvVars).not.toHaveBeenCalled();
  });

  it("never echoes the token back in the response", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getBody()).not.toContain(VALID_TOKEN);
  });

  it("records the operator username in writtenBy", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const req = authReq({ token: VALID_TOKEN }, "user-bob");
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(mockWriteRepoEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ writtenBy: "dashboard:bob" }),
    );
  });

  it("returns 500 when the env writer throws", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    mockWriteRepoEnvVars.mockRejectedValue(new Error("disk full"));
    const req = authReq({ token: VALID_TOKEN });
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    expect(res._getStatusCode()).toBe(500);
  });
});

// ============================================================
// readGithubCredentialsSnapshot — used by agents-list aggregation
// ============================================================

describe("readGithubCredentialsSnapshot", () => {
  it("returns the same shape as the GET handler (sans HTTP)", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(snap).toEqual({
      registered: true,
      token_shape_valid: true,
      last_validated_at: expect.any(String),
      last_validation_error: null,
      token_prefix: VALID_TOKEN.slice(0, 7),
      token_suffix: VALID_TOKEN.slice(-4),
      token_expires_at: null,
      token_user_login: null,
    });
  });

  it("returns registered=false / token_shape_valid=false when .env is missing", async () => {
    mockParseEnvFile.mockImplementation(() => {
      throw new Error("Environment file not found");
    });
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(snap).toEqual({
      registered: false,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error: null,
      token_prefix: "",
      token_suffix: "",
      token_expires_at: null,
      token_user_login: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never leaks the token in the returned object", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(JSON.stringify(snap)).not.toContain(VALID_TOKEN);
  });

  it("{probe: false} returns cache-only — does NOT hit the network", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot", {
      probe: false,
    });
    expect(snap).toEqual({
      registered: true,
      token_shape_valid: true,
      last_validated_at: null,
      last_validation_error: null,
      token_prefix: VALID_TOKEN.slice(0, 7),
      token_suffix: VALID_TOKEN.slice(-4),
      token_expires_at: null,
      token_user_login: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("{probe: false} surfaces a cached result without re-probing", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    // Warm cache via a regular call.
    await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Snapshot path now serves the cached value.
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot", {
      probe: false,
    });
    expect(snap.last_validated_at).not.toBeNull();
    expect(snap.last_validation_error).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces token_expires_at + token_user_login on a successful probe", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ login: "alice" }), {
        status: 200,
        headers: {
          "github-authentication-token-expiration":
            "2026-06-04 12:00:00 UTC",
        },
      }),
    );
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(snap.token_expires_at).toBe("2026-06-04T12:00:00.000Z");
    expect(snap.token_user_login).toBe("alice");
    expect(snap.token_prefix).toBe(VALID_TOKEN.slice(0, 7));
    expect(snap.token_suffix).toBe(VALID_TOKEN.slice(-4));
  });

  it("cache hit round-trips token_expires_at + token_user_login without re-probing", async () => {
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: "bob" }), {
        status: 200,
        headers: {
          "github-authentication-token-expiration":
            "2026-12-01 08:30:45 UTC",
        },
      }),
    );
    const first = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first.token_user_login).toBe("bob");

    const second = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second.token_expires_at).toBe("2026-12-01T08:30:45.000Z");
    expect(second.token_user_login).toBe("bob");
  });

  it("returns prefix/suffix for a shape-invalid token (registered but malformed)", async () => {
    mockParseEnvFile.mockReturnValue({
      DANX_GITHUB_TOKEN: "not-a-pat-but-long-enough-to-slice",
    });
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(snap.registered).toBe(true);
    expect(snap.token_shape_valid).toBe(false);
    expect(snap.token_prefix).toBe("not-a-p");
    expect(snap.token_suffix).toBe("lice");
    expect(snap.token_expires_at).toBeNull();
    expect(snap.token_user_login).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty suffix when the token is shorter than the prefix length", async () => {
    // Should never happen for a real PAT, but defends the slice math.
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: "ghp_a" });
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(snap.token_prefix).toBe("ghp_a");
    expect(snap.token_suffix).toBe("");
  });

  it("PATCH stamps token_expires_at + token_user_login into the probe cache — follow-up snapshot serves them without re-probing", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: "dani" }), {
        status: 200,
        headers: {
          "github-authentication-token-expiration":
            "2026-09-09 09:09:09 UTC",
        },
      }),
    );
    const patchReq = createMockReqWithBody("PATCH", { token: VALID_TOKEN });
    (patchReq.headers as Record<string, string>)["authorization"] =
      "Bearer user-newms87";
    await handlePatchGithubCredentials(
      patchReq,
      createMockRes(),
      "danxbot",
      deps(),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Subsequent snapshot read MUST hit cache — same fingerprint, no
    // second fetch — AND surface the metadata PATCH just stamped.
    mockParseEnvFile.mockReturnValue({ DANX_GITHUB_TOKEN: VALID_TOKEN });
    const snap = await readGithubCredentialsSnapshot("/repos/danxbot");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(snap.token_expires_at).toBe("2026-09-09T09:09:09.000Z");
    expect(snap.token_user_login).toBe("dani");
    expect(snap.last_validation_error).toBeNull();
  });

  it("PATCH 200 echoes the masked token + new metadata on the response", async () => {
    mockWriteRepoEnvVars.mockResolvedValue(["DANX_GITHUB_TOKEN"]);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ login: "carol" }), {
        status: 200,
        headers: {
          "github-authentication-token-expiration":
            "2026-07-15 23:59:00 UTC",
        },
      }),
    );
    const req = createMockReqWithBody("PATCH", { token: VALID_TOKEN });
    (req.headers as Record<string, string>)["authorization"] =
      "Bearer user-newms87";
    const res = createMockRes();
    await handlePatchGithubCredentials(req, res, "danxbot", deps());
    const body = JSON.parse(res._getBody());
    expect(body.token_prefix).toBe(VALID_TOKEN.slice(0, 7));
    expect(body.token_suffix).toBe(VALID_TOKEN.slice(-4));
    expect(body.token_expires_at).toBe("2026-07-15T23:59:00.000Z");
    expect(body.token_user_login).toBe("carol");
  });
});

// ============================================================
// parseGithubExpiryHeader — header parse edge cases
// ============================================================

describe("parseGithubExpiryHeader", () => {
  it("converts the canonical `YYYY-MM-DD HH:MM:SS UTC` to ISO-8601", () => {
    expect(parseGithubExpiryHeader("2026-06-04 12:00:00 UTC")).toBe(
      "2026-06-04T12:00:00.000Z",
    );
  });

  it("returns null for a null / empty header", () => {
    expect(parseGithubExpiryHeader(null)).toBeNull();
    expect(parseGithubExpiryHeader("")).toBeNull();
  });

  it("returns null when the UTC suffix is missing", () => {
    expect(parseGithubExpiryHeader("2026-06-04 12:00:00")).toBeNull();
  });

  it("returns null for a non-UTC suffix (defensive — GitHub always sends UTC)", () => {
    expect(parseGithubExpiryHeader("2026-06-04 12:00:00 PST")).toBeNull();
  });

  it("returns null for malformed dates", () => {
    expect(parseGithubExpiryHeader("not a date UTC")).toBeNull();
    expect(parseGithubExpiryHeader("2026-13-40 99:99:99 UTC")).toBeNull();
  });

  it("strips surrounding whitespace before matching", () => {
    expect(parseGithubExpiryHeader("  2026-01-01 00:00:00 UTC  ")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("preserves two-digit padding in hour/minute/second", () => {
    expect(parseGithubExpiryHeader("2026-06-04 01:02:03 UTC")).toBe(
      "2026-06-04T01:02:03.000Z",
    );
  });
});

// ============================================================
// extractProbeMetadata — header + body parse from a full Response
// ============================================================

describe("extractProbeMetadata", () => {
  it("parses expiresAt + userLogin from a 200 with both", async () => {
    const res = new Response(JSON.stringify({ login: "alice" }), {
      status: 200,
      headers: {
        "github-authentication-token-expiration":
          "2026-08-01 06:30:00 UTC",
      },
    });
    expect(await extractProbeMetadata(res)).toEqual({
      expiresAt: "2026-08-01T06:30:00.000Z",
      userLogin: "alice",
    });
  });

  it("returns expiresAt=null when the header is absent (classic PAT without expiry)", async () => {
    const res = new Response(JSON.stringify({ login: "alice" }), {
      status: 200,
    });
    const meta = await extractProbeMetadata(res);
    expect(meta.expiresAt).toBeNull();
    expect(meta.userLogin).toBe("alice");
  });

  it("returns userLogin=null when the body lacks a login field", async () => {
    const res = new Response(JSON.stringify({}), {
      status: 200,
      headers: {
        "github-authentication-token-expiration":
          "2026-08-01 06:30:00 UTC",
      },
    });
    const meta = await extractProbeMetadata(res);
    expect(meta.expiresAt).toBe("2026-08-01T06:30:00.000Z");
    expect(meta.userLogin).toBeNull();
  });

  it("returns userLogin=null when the body is not JSON", async () => {
    const res = new Response("plain text response", { status: 200 });
    const meta = await extractProbeMetadata(res);
    expect(meta.userLogin).toBeNull();
  });

  it("returns userLogin=null when the body's login is not a non-empty string", async () => {
    const res = new Response(JSON.stringify({ login: "" }), { status: 200 });
    expect((await extractProbeMetadata(res)).userLogin).toBeNull();

    const res2 = new Response(JSON.stringify({ login: 42 }), { status: 200 });
    expect((await extractProbeMetadata(res2)).userLogin).toBeNull();
  });

  it("returns {null, null} for a non-2xx response (probe rejection)", async () => {
    const res = new Response("Bad credentials", {
      status: 401,
      headers: {
        "github-authentication-token-expiration":
          "2026-08-01 06:30:00 UTC",
      },
    });
    expect(await extractProbeMetadata(res)).toEqual({
      expiresAt: null,
      userLogin: null,
    });
  });

  it("returns expiresAt=null when the header is malformed (defense-in-depth)", async () => {
    const res = new Response(JSON.stringify({ login: "alice" }), {
      status: 200,
      headers: {
        "github-authentication-token-expiration": "garbage",
      },
    });
    expect((await extractProbeMetadata(res)).expiresAt).toBeNull();
  });
});
