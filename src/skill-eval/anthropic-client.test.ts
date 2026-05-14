import { describe, expect, it, vi } from "vitest";
import {
  AnthropicAuthError,
  CREDENTIALS_RELPATH,
  OAUTH_BETA_HEADER,
  createAnthropicClient,
  loadOauthAccessToken,
  type CreateAnthropicClientDeps,
} from "./anthropic-client.js";

const FUTURE_EXPIRES = 9_999_999_999_999;
const PAST_EXPIRES = 1_000_000_000_000;
const NOW = 5_000_000_000_000;

const CREDENTIALS_PATH = `/fake/home/${CREDENTIALS_RELPATH.join("/")}`;

function buildDeps(overrides: Partial<CreateAnthropicClientDeps> = {}): CreateAnthropicClientDeps {
  return {
    readEnv: () => undefined,
    readFile: () => "",
    fileExists: () => false,
    home: "/fake/home",
    now: NOW,
    ...overrides,
  };
}

function credentialsBody(accessToken: string, expiresAt = FUTURE_EXPIRES): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, expiresAt, scopes: ["user:inference"] },
  });
}

describe("loadOauthAccessToken", () => {
  it("returns the access token when the credentials file exists + token is fresh", () => {
    const deps = buildDeps({
      fileExists: (p) => p === CREDENTIALS_PATH,
      readFile: (p) => {
        if (p !== CREDENTIALS_PATH) throw new Error(`unexpected read: ${p}`);
        return credentialsBody("sk-ant-oat01-fresh");
      },
    });
    expect(loadOauthAccessToken(deps)).toBe("sk-ant-oat01-fresh");
  });

  it("returns null when the credentials file is absent", () => {
    expect(loadOauthAccessToken(buildDeps())).toBeNull();
  });

  it("returns null when the file exists but contains no claudeAiOauth field", () => {
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () => JSON.stringify({ otherKey: 1 }),
    });
    expect(loadOauthAccessToken(deps)).toBeNull();
  });

  it("returns null when claudeAiOauth lacks an accessToken", () => {
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () => JSON.stringify({ claudeAiOauth: {} }),
    });
    expect(loadOauthAccessToken(deps)).toBeNull();
  });

  it("throws AnthropicAuthError on expired token", () => {
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () => credentialsBody("expired-token", PAST_EXPIRES),
    });
    expect(() => loadOauthAccessToken(deps)).toThrow(AnthropicAuthError);
    expect(() => loadOauthAccessToken(deps)).toThrow(/expired/i);
  });

  it("throws AnthropicAuthError on malformed JSON", () => {
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () => "{not valid json",
    });
    expect(() => loadOauthAccessToken(deps)).toThrow(AnthropicAuthError);
    expect(() => loadOauthAccessToken(deps)).toThrow(/parse/i);
  });

  it("accepts a token with no expiresAt (never expires)", () => {
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () =>
        JSON.stringify({ claudeAiOauth: { accessToken: "tok-no-exp" } }),
    });
    expect(loadOauthAccessToken(deps)).toBe("tok-no-exp");
  });
});

describe("createAnthropicClient", () => {
  it("uses OAuth Bearer + beta header when CLAUDE_AUTH_MODE=subscription and a valid token exists", () => {
    const deps = buildDeps({
      readEnv: (k) => (k === "CLAUDE_AUTH_MODE" ? "subscription" : undefined),
      fileExists: () => true,
      readFile: () => credentialsBody("sk-ant-oat01-sub"),
    });
    const client = createAnthropicClient("ignored-api-key", deps);
    expect(client.authToken).toBe("sk-ant-oat01-sub");
    // Defensive: the beta header lives in the client's default headers.
    const headers = (client as unknown as { _options: { defaultHeaders?: Record<string, string> } })
      ._options.defaultHeaders;
    expect(headers?.["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
  });

  it("uses OAuth Bearer when apiKey is empty AND credentials exist (auto-fallback)", () => {
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () => credentialsBody("sk-ant-oat01-auto"),
    });
    const client = createAnthropicClient("", deps);
    expect(client.authToken).toBe("sk-ant-oat01-auto");
  });

  it("uses the api key when CLAUDE_AUTH_MODE is unset and apiKey is non-empty", () => {
    const deps = buildDeps();
    const client = createAnthropicClient("sk-ant-api03-real", deps);
    expect(client.apiKey).toBe("sk-ant-api03-real");
    expect(client.authToken).toBeFalsy();
  });

  it("throws AnthropicAuthError when CLAUDE_AUTH_MODE=subscription but no credentials file is present", () => {
    const deps = buildDeps({
      readEnv: (k) => (k === "CLAUDE_AUTH_MODE" ? "subscription" : undefined),
    });
    expect(() => createAnthropicClient("any", deps)).toThrow(AnthropicAuthError);
    expect(() => createAnthropicClient("any", deps)).toThrow(/claude login/i);
  });

  it("throws AnthropicAuthError when no credentials and apiKey is empty (true blocker)", () => {
    const deps = buildDeps();
    expect(() => createAnthropicClient("", deps)).toThrow(AnthropicAuthError);
    expect(() => createAnthropicClient("", deps)).toThrow(
      /ANTHROPIC_API_KEY|CLAUDE_AUTH_MODE/,
    );
  });

  it("prefers api key when CLAUDE_AUTH_MODE is something other than 'subscription' (legacy default)", () => {
    const deps = buildDeps({
      readEnv: (k) => (k === "CLAUDE_AUTH_MODE" ? "api-key" : undefined),
      fileExists: () => true,
      readFile: () => credentialsBody("ignored-oauth"),
    });
    const client = createAnthropicClient("sk-ant-api03-real", deps);
    expect(client.apiKey).toBe("sk-ant-api03-real");
    expect(client.authToken).toBeFalsy();
  });

  it("falls back to OAuth when CLAUDE_AUTH_MODE=subscription overrides a populated api key", () => {
    const deps = buildDeps({
      readEnv: (k) => (k === "CLAUDE_AUTH_MODE" ? "subscription" : undefined),
      fileExists: () => true,
      readFile: () => credentialsBody("sk-ant-oat01-prefer"),
    });
    const client = createAnthropicClient("sk-ant-api03-stale", deps);
    expect(client.authToken).toBe("sk-ant-oat01-prefer");
  });

  it("OAuth-mode client does NOT inherit process.env.ANTHROPIC_API_KEY (sends Bearer only, not X-Api-Key)", () => {
    // Regression: the Anthropic SDK constructor reads ANTHROPIC_API_KEY
    // from process.env when `apiKey` is omitted. If both authToken AND
    // a stale apiKey are populated the SDK sends BOTH headers; the
    // server picks the bad x-api-key and 401s. The factory MUST pass
    // `apiKey: null` explicitly on the OAuth branch so the env-fallback
    // never fires. Reproduced 401 in prod against a stale .env key
    // (DX-313, post-DX-334).
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-stale-env";
    try {
      const deps = buildDeps({
        readEnv: (k) =>
          k === "CLAUDE_AUTH_MODE"
            ? "subscription"
            : k === "ANTHROPIC_API_KEY"
              ? process.env.ANTHROPIC_API_KEY
              : undefined,
        fileExists: () => true,
        readFile: () => credentialsBody("sk-ant-oat01-prefer"),
      });
      const client = createAnthropicClient("sk-ant-api03-stale-arg", deps);
      expect(client.authToken).toBe("sk-ant-oat01-prefer");
      expect(client.apiKey).toBeNull();
    } finally {
      if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it("propagates expired-token AnthropicAuthError when CLAUDE_AUTH_MODE=subscription", () => {
    const deps = buildDeps({
      readEnv: (k) => (k === "CLAUDE_AUTH_MODE" ? "subscription" : undefined),
      fileExists: () => true,
      readFile: () => credentialsBody("expired-tok", PAST_EXPIRES),
    });
    expect(() => createAnthropicClient("any-key", deps)).toThrow(AnthropicAuthError);
    expect(() => createAnthropicClient("any-key", deps)).toThrow(/expired/i);
  });

  it("propagates malformed-JSON AnthropicAuthError when CLAUDE_AUTH_MODE=subscription", () => {
    const deps = buildDeps({
      readEnv: (k) => (k === "CLAUDE_AUTH_MODE" ? "subscription" : undefined),
      fileExists: () => true,
      readFile: () => "{not valid json",
    });
    expect(() => createAnthropicClient("any-key", deps)).toThrow(AnthropicAuthError);
    expect(() => createAnthropicClient("any-key", deps)).toThrow(/parse/i);
  });

  it("throws 'no Anthropic credentials' when apiKey empty + creds file present but accessToken missing + auth-mode unset", () => {
    // preferOauth=true via empty apiKey → loadOauthAccessToken returns
    // null (file exists, no accessToken field) → falls through the
    // subscription-guard → apiKey.length === 0 → final throw.
    const deps = buildDeps({
      fileExists: () => true,
      readFile: () => JSON.stringify({ claudeAiOauth: {} }),
    });
    expect(() => createAnthropicClient("", deps)).toThrow(AnthropicAuthError);
    expect(() => createAnthropicClient("", deps)).toThrow(
      /ANTHROPIC_API_KEY|CLAUDE_AUTH_MODE/,
    );
  });
});
