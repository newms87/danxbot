/**
 * GitHub-credentials routes for the Agents tab — DX-648 Phase 2 of DX-646.
 *
 *   GET   /api/agents/:repo/github-credentials   → handleGetGithubCredentials
 *   PATCH /api/agents/:repo/github-credentials   → handlePatchGithubCredentials
 *
 * The GET shape is intentionally token-free: `{registered, token_shape_valid,
 * last_validated_at, last_validation_error}`. The token VALUE never leaves
 * the worker — only health metadata. PATCH accepts `{token}`, shape-
 * validates against the same `TOKEN_PATTERN` Phase 1's entrypoint uses,
 * probes `https://api.github.com/user` with a 5s timeout, and only writes
 * the env file if the probe returns 2xx (no point persisting a token that
 * GitHub already rejects). The route NEVER restarts the worker — DX-647's
 * fail-loud loop owns that path.
 *
 * Validation probe results are cached in-process for 5 minutes keyed by
 * `repoLocalPath + token-prefix`, so a busy dashboard doesn't hammer
 * `api.github.com/user` on every snapshot. The cache is invalidated on
 * every successful PATCH so the new token's probe result is fresh.
 *
 * Auth: per-user bearer only (mirrors PATCH /api/agents/:repo/trello-
 * credentials). `DANXBOT_DISPATCH_TOKEN` is bot↔repo and rejected here.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import { DASHBOARD_PREFIX } from "../settings-file.js";
import { writeRepoEnvVars, repoEnvFilePath } from "./repo-env-writer.js";
import { parseEnvFile } from "../env-file.js";
import { TOKEN_PATTERN } from "../github-auth/gitconfig.js";

const log = createLogger("agents-github");

const GITHUB_PROBE_URL = "https://api.github.com/user";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 5 * 60 * 1_000;
const FORBIDDEN_VALUE_CHARS = /[\n\r\0]/;

export interface GithubCredentialsSnapshot {
  registered: boolean;
  token_shape_valid: boolean;
  last_validated_at: string | null;
  last_validation_error: string | null;
}

interface ProbeCacheEntry {
  validatedAt: string;
  error: string | null;
  /** Identifies which token produced this result so a rotation invalidates. */
  tokenFingerprint: string;
  expiresAtMs: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();

/**
 * Indirect reference to the global `fetch` so tests can inject a mock.
 * Node 20 ships `fetch` globally; production uses it directly.
 */
let fetchImpl: typeof fetch = globalThis.fetch;

/** Test-only: swap the fetch implementation. */
export function _setFetchImplForTesting(impl: typeof fetch | null): void {
  fetchImpl = impl ?? globalThis.fetch;
}

/** Test-only: reset cache + fetch impl. */
export function _resetForTesting(): void {
  probeCache.clear();
  fetchImpl = globalThis.fetch;
}

/** Stable fingerprint that changes when the token does but never echoes it. */
function tokenFingerprint(token: string): string {
  // First 8 chars + length is enough to detect rotation without persisting
  // anything an attacker could correlate against a leaked log line.
  return `${token.slice(0, 8)}:${token.length}`;
}

function readTokenFromEnv(repoLocalPath: string): string | null {
  const envPath = repoEnvFilePath(repoLocalPath);
  let env: Record<string, string>;
  try {
    env = parseEnvFile(envPath);
  } catch (err) {
    // .env missing is the "operator hasn't run install.sh yet" path —
    // legitimate unregistered state. Other errors (corrupt file,
    // permission denied) get logged so a real fault isn't laundered as
    // "no token set"; we still degrade to null so the surface stays
    // available, but the operator sees the cause in the worker log.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found/i.test(msg)) {
      log.warn(
        `readTokenFromEnv(${envPath}) failed; treating as unregistered`,
        err,
      );
    }
    return null;
  }
  const raw = env["DANX_GITHUB_TOKEN"];
  return raw && raw.length > 0 ? raw : null;
}

async function probeGithubToken(token: string): Promise<{
  validatedAt: string;
  error: string | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const validatedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(GITHUB_PROBE_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "danxbot-dashboard",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return {
        validatedAt,
        error: "GitHub rejected the token (401) — token may be revoked or invalid.",
      };
    }
    if (response.status === 403) {
      return {
        validatedAt,
        error: "GitHub returned 403 Forbidden — token lacks required scope or is rate-limited.",
      };
    }
    if (!response.ok) {
      return {
        validatedAt,
        error: `GitHub probe returned status ${response.status}.`,
      };
    }
    return { validatedAt, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      validatedAt,
      error: `GitHub probe network error: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the snapshot for one repo. Used by the GET handler AND by
 * `agents-list.ts#buildSnapshot` so each repo card surfaces the
 * credential state without a second client round-trip. Never returns
 * the token value — only health metadata.
 *
 * `{probe: true}` (GET handler default): runs the validation probe
 * against api.github.com when the cache is cold or the token has
 * rotated. Worst case 5s round-trip per repo.
 *
 * `{probe: false}` (snapshot aggregation): NEVER hits the network.
 * Returns cached probe results when available; otherwise
 * `last_validated_at: null` so the SPA can render "not yet validated"
 * without blocking the Agents tab poll on `api.github.com/user` for
 * every repo on every poll. The GET handler refreshes the cache on
 * demand; the PATCH handler refreshes the cache after every rotation.
 *
 * Cache key is `repoLocalPath` — one entry per repo. Token fingerprint
 * lives inside the entry so a silent rotation (operator hand-edits the
 * .env) invalidates lazily on the next probe.
 */
export async function readGithubCredentialsSnapshot(
  repoLocalPath: string,
  options: { probe?: boolean } = {},
): Promise<GithubCredentialsSnapshot> {
  const probe = options.probe ?? true;
  const token = readTokenFromEnv(repoLocalPath);
  if (token === null) {
    return {
      registered: false,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error: null,
    };
  }
  const shapeOk = TOKEN_PATTERN.test(token);
  if (!shapeOk) {
    return {
      registered: true,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error:
        "Token does not match expected GitHub PAT shape (ghp_/ghs_/github_pat_).",
    };
  }
  const fp = tokenFingerprint(token);
  const cached = probeCache.get(repoLocalPath);
  if (
    cached &&
    cached.tokenFingerprint === fp &&
    cached.expiresAtMs > Date.now()
  ) {
    return {
      registered: true,
      token_shape_valid: true,
      last_validated_at: cached.validatedAt,
      last_validation_error: cached.error,
    };
  }
  if (!probe) {
    // Snapshot-aggregation path: never hit the network. SPA renders
    // "not yet validated" until a GET / PATCH against this repo
    // populates the cache.
    return {
      registered: true,
      token_shape_valid: true,
      last_validated_at: null,
      last_validation_error: null,
    };
  }
  const result = await probeGithubToken(token);
  probeCache.set(repoLocalPath, {
    validatedAt: result.validatedAt,
    error: result.error,
    tokenFingerprint: fp,
    expiresAtMs: Date.now() + PROBE_CACHE_TTL_MS,
  });
  return {
    registered: true,
    token_shape_valid: true,
    last_validated_at: result.validatedAt,
    last_validation_error: result.error,
  };
}

/**
 * GET /api/agents/:repo/github-credentials — per-user bearer required.
 */
export async function handleGetGithubCredentials(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }
  try {
    const snapshot = await readGithubCredentialsSnapshot(repo.localPath);
    json(res, 200, snapshot);
  } catch (err) {
    log.error(`handleGetGithubCredentials(${repoName}) failed`, err);
    json(res, 500, {
      error:
        err instanceof Error
          ? err.message
          : "Failed to read GitHub credentials snapshot",
    });
  }
}

/**
 * PATCH /api/agents/:repo/github-credentials — per-user bearer required.
 *
 * Body: `{token: string}`. Shape-validates first (422 on malformed),
 * probes GitHub (422 on probe rejection), then writes the env file. The
 * cache for this repo is invalidated so the snapshot returned in the 200
 * body reflects the fresh probe.
 */
export async function handlePatchGithubCredentials(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const raw = body["token"];
  if (typeof raw !== "string") {
    json(res, 422, { error: "token must be a string" });
    return;
  }
  if (raw.trim().length === 0) {
    json(res, 422, { error: "token must be a non-empty string" });
    return;
  }
  if (FORBIDDEN_VALUE_CHARS.test(raw)) {
    json(res, 422, {
      error:
        "token must not contain newline / carriage-return / null bytes",
    });
    return;
  }
  if (!TOKEN_PATTERN.test(raw)) {
    json(res, 422, {
      error:
        "token does not match expected GitHub PAT shape " +
        "(`^gh[ps]_[A-Za-z0-9_]+$` for classic PATs OR " +
        "`^github_pat_[A-Za-z0-9_]+$` for fine-grained)",
    });
    return;
  }

  // Probe BEFORE writing so an obviously-revoked token doesn't replace a
  // working one. Operators can force a write via the same PATCH after
  // fixing whatever GitHub is complaining about.
  const probe = await probeGithubToken(raw);
  if (probe.error) {
    json(res, 422, { error: probe.error });
    return;
  }

  try {
    await writeRepoEnvVars({
      repoLocalPath: repo.localPath,
      updates: { DANX_GITHUB_TOKEN: raw },
      writtenBy: `${DASHBOARD_PREFIX}${auth.user.username}`,
    });
  } catch (err) {
    log.error(`handlePatchGithubCredentials(${repoName}) write failed`, err);
    json(res, 500, {
      error:
        err instanceof Error
          ? err.message
          : "Failed to write GitHub credentials",
    });
    return;
  }

  // Refresh the cache so the snapshot we return — and any GET that
  // follows within the 5-min window — sees the new fingerprint.
  probeCache.set(repo.localPath, {
    validatedAt: probe.validatedAt,
    error: null,
    tokenFingerprint: tokenFingerprint(raw),
    expiresAtMs: Date.now() + PROBE_CACHE_TTL_MS,
  });

  const snapshot: GithubCredentialsSnapshot = {
    registered: true,
    token_shape_valid: true,
    last_validated_at: probe.validatedAt,
    last_validation_error: null,
  };
  json(res, 200, snapshot);
}
