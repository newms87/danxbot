/**
 * Anthropic SDK client factory for the skill-eval iterate runner.
 *
 * Two auth paths, selected per env:
 *   - API key — `ANTHROPIC_API_KEY` (legacy console.anthropic.com key).
 *   - OAuth subscription — `~/.claude/.credentials.json` `accessToken`
 *     paired with the `anthropic-beta: oauth-2025-04-20` header.
 *
 * Selection rule:
 *   - `CLAUDE_AUTH_MODE=subscription` OR empty `apiKey` → prefer OAuth.
 *   - Otherwise → use `apiKey`.
 *   - Neither available → throw `AnthropicAuthError` with a sentence
 *     telling the operator exactly which env / command unblocks.
 *
 * The factory is dependency-injected (`CreateAnthropicClientDeps`) so
 * unit tests exercise both paths + every error branch without touching
 * the real filesystem, env, or wall clock.
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class AnthropicAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicAuthError";
  }
}

export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
export const CREDENTIALS_RELPATH = [".claude", ".credentials.json"] as const;

export interface CredentialsFileShape {
  readonly claudeAiOauth?: {
    readonly accessToken?: string;
    readonly expiresAt?: number;
  };
}

export interface CreateAnthropicClientDeps {
  readonly readEnv: (key: string) => string | undefined;
  readonly readFile: (path: string) => string;
  readonly fileExists: (path: string) => boolean;
  readonly home: string;
  readonly now: number;
}

export function defaultClientDeps(): CreateAnthropicClientDeps {
  return {
    readEnv: (k) => process.env[k],
    readFile: (p) => readFileSync(p, "utf8"),
    fileExists: (p) => existsSync(p),
    home: homedir(),
    now: Date.now(),
  };
}

export function loadOauthAccessToken(
  deps: CreateAnthropicClientDeps,
): string | null {
  const path = join(deps.home, ...CREDENTIALS_RELPATH);
  if (!deps.fileExists(path)) return null;
  let parsed: CredentialsFileShape;
  try {
    parsed = JSON.parse(deps.readFile(path)) as CredentialsFileShape;
  } catch (e) {
    throw new AnthropicAuthError(
      `failed to parse Claude credentials at ${path}: ${(e as Error).message}`,
    );
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= deps.now) {
    throw new AnthropicAuthError(
      `Claude OAuth access token at ${path} has expired (expiresAt=${oauth.expiresAt}, now=${deps.now}); refresh via \`claude login\` before re-running.`,
    );
  }
  return oauth.accessToken;
}

export function createAnthropicClient(
  apiKey: string,
  deps: CreateAnthropicClientDeps = defaultClientDeps(),
): Anthropic {
  const authMode = deps.readEnv("CLAUDE_AUTH_MODE");
  const preferOauth = authMode === "subscription" || apiKey.length === 0;

  if (preferOauth) {
    const token = loadOauthAccessToken(deps);
    if (token) {
      // `apiKey: null` is load-bearing — without it the SDK reads
      // `process.env.ANTHROPIC_API_KEY` and sends BOTH `X-Api-Key` and
      // `Authorization: Bearer`; the server rejects on the stale key.
      // See SDK constructor in `@anthropic-ai/sdk/client.js` —
      // `apiKey = readEnv("ANTHROPIC_API_KEY") ?? null` (env-fallback).
      return new Anthropic({
        apiKey: null,
        authToken: token,
        defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER },
      });
    }
    if (authMode === "subscription") {
      throw new AnthropicAuthError(
        "CLAUDE_AUTH_MODE=subscription but no usable Claude OAuth token at ~/.claude/.credentials.json — run `claude login` first.",
      );
    }
  }

  if (apiKey.length > 0) {
    return new Anthropic({ apiKey });
  }

  throw new AnthropicAuthError(
    "no Anthropic credentials available: set ANTHROPIC_API_KEY in ~/web/danxbot/.env OR set CLAUDE_AUTH_MODE=subscription with a valid `claude login` in ~/.claude/.credentials.json.",
  );
}
