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
const TOKEN_PREFIX_LENGTH = 7;
const TOKEN_SUFFIX_LENGTH = 4;
const GITHUB_EXPIRY_HEADER = "github-authentication-token-expiration";
// GitHub stamps the PAT expiry as `YYYY-MM-DD HH:MM:SS UTC` on every authed
// response (always present for fine-grained PATs; classic PATs include it
// only when the operator set one at creation). Strict regex up front so a
// malformed header turns into `null` instead of an invalid Date that the
// SPA renders as `NaN`.
const GITHUB_EXPIRY_HEADER_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;

export interface GithubCredentialsSnapshot {
  registered: boolean;
  token_shape_valid: boolean;
  last_validated_at: string | null;
  last_validation_error: string | null;
  /**
   * First `TOKEN_PREFIX_LENGTH` chars of the on-disk token (e.g. `ghp_abc`
   * or `github_`). Empty string when unregistered. Seven chars matches the
   * token-type discriminator length so the operator can tell classic vs
   * fine-grained at a glance without losing entropy.
   */
  token_prefix: string;
  /**
   * Last `TOKEN_SUFFIX_LENGTH` chars of the on-disk token. Empty string
   * when unregistered. Four trailing characters is below the brute-forceable
   * threshold but enough to differentiate two rotations of the same type.
   */
  token_suffix: string;
  /**
   * ISO-8601 timestamp parsed from the probe response's
   * `github-authentication-token-expiration` header (which GitHub ships as
   * `YYYY-MM-DD HH:MM:SS UTC`). `null` when GitHub did not return the
   * header (classic PATs without expiry) OR when the probe has not yet
   * run for this snapshot (cold cache + `{probe: false}`).
   */
  token_expires_at: string | null;
  /**
   * GitHub login string parsed from the `/user` probe response body's
   * `login` field. `null` when the probe failed before the body was
   * read, when the body did not include a `login`, OR when the probe has
   * not yet run for this snapshot.
   */
  token_user_login: string | null;
}

interface ProbeCacheEntry {
  validatedAt: string;
  error: string | null;
  /** Identifies which token produced this result so a rotation invalidates. */
  tokenFingerprint: string;
  cacheExpiresAtMs: number;
  /** Captured from the probe response — see snapshot fields. */
  tokenExpiresAt: string | null;
  userLogin: string | null;
}

/**
 * Metadata extracted from a successful `/user` probe response.
 *
 * Owned by `extractProbeMetadata` so the parsing rules (header regex,
 * body shape, non-2xx fall-through) live in one place. `probeGithubToken`
 * is the sole caller in production; tests can call directly with a
 * fabricated `Response` to pin header-parse edge cases without standing
 * up a fetch mock.
 */
export interface ProbeMetadata {
  expiresAt: string | null;
  userLogin: string | null;
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

/**
 * Canonical "no token registered" snapshot. Shared between
 * `readGithubCredentialsSnapshot`'s unregistered branch and
 * `agents-list.ts#buildSnapshot`'s reader-throws fallback so the empty
 * shape lives in exactly one place — every future field add only
 * touches the interface + this const.
 */
export const UNREGISTERED_GITHUB_SNAPSHOT: GithubCredentialsSnapshot = {
  registered: false,
  token_shape_valid: false,
  last_validated_at: null,
  last_validation_error: null,
  token_prefix: "",
  token_suffix: "",
  token_expires_at: null,
  token_user_login: null,
};

/** Stable fingerprint that changes when the token does but never echoes it. */
function tokenFingerprint(token: string): string {
  // First 8 chars + length is enough to detect rotation without persisting
  // anything an attacker could correlate against a leaked log line.
  return `${token.slice(0, 8)}:${token.length}`;
}

/** Mask the on-disk token to `prefix…suffix` bytes for snapshot display. */
function maskToken(token: string | null): {
  prefix: string;
  suffix: string;
} {
  if (token === null) return { prefix: "", suffix: "" };
  return {
    prefix: token.slice(0, TOKEN_PREFIX_LENGTH),
    suffix:
      token.length <= TOKEN_PREFIX_LENGTH
        ? ""
        : token.slice(-TOKEN_SUFFIX_LENGTH),
  };
}

/**
 * Parse the `github-authentication-token-expiration` header + JSON body
 * `login` from a successful `/user` probe response. Returns `{null, null}`
 * for non-2xx responses, header-absent responses, malformed headers, and
 * any body-parse failure — so the snapshot's existing
 * `last_validation_error` remains the single source of truth for "probe
 * went wrong."
 *
 * Body read is fail-safe: if the response is opaque / not JSON / lacks a
 * `login` field, `userLogin` falls through to `null` rather than throwing.
 * Header parse is strict via `GITHUB_EXPIRY_HEADER_RE` so a garbled header
 * never lands in the snapshot as an invalid Date the SPA renders `NaN` on.
 */
export async function extractProbeMetadata(
  response: Response,
): Promise<ProbeMetadata> {
  if (!response.ok) return { expiresAt: null, userLogin: null };

  const headerValue = response.headers.get(GITHUB_EXPIRY_HEADER);
  const expiresAt = parseGithubExpiryHeader(headerValue);

  let userLogin: string | null = null;
  try {
    const body = (await response.json()) as unknown;
    if (
      body !== null &&
      typeof body === "object" &&
      typeof (body as { login?: unknown }).login === "string" &&
      (body as { login: string }).login.length > 0
    ) {
      userLogin = (body as { login: string }).login;
    }
  } catch {
    // Body absent / not JSON / already consumed — leave userLogin null.
  }

  return { expiresAt, userLogin };
}

/**
 * Convert GitHub's `YYYY-MM-DD HH:MM:SS UTC` PAT expiry header to ISO-8601.
 * Exported only for the unit test to pin edge cases (UTC suffix, padding,
 * malformed strings); production code calls `extractProbeMetadata`.
 */
export function parseGithubExpiryHeader(header: string | null): string | null {
  if (!header) return null;
  const m = GITHUB_EXPIRY_HEADER_RE.exec(header.trim());
  if (!m) return null;
  // `new Date("YYYY-MM-DDTHH:MM:SSZ")` is the canonical ISO-8601 path —
  // parse via Date then re-serialize so the snapshot is deterministic
  // regardless of host TZ.
  const iso = `${m[1]}T${m[2]}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
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

interface ProbeResult {
  validatedAt: string;
  error: string | null;
  expiresAt: string | null;
  userLogin: string | null;
}

async function probeGithubToken(token: string): Promise<ProbeResult> {
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
        expiresAt: null,
        userLogin: null,
      };
    }
    if (response.status === 403) {
      return {
        validatedAt,
        error: "GitHub returned 403 Forbidden — token lacks required scope or is rate-limited.",
        expiresAt: null,
        userLogin: null,
      };
    }
    if (!response.ok) {
      return {
        validatedAt,
        error: `GitHub probe returned status ${response.status}.`,
        expiresAt: null,
        userLogin: null,
      };
    }
    const meta = await extractProbeMetadata(response);
    return {
      validatedAt,
      error: null,
      expiresAt: meta.expiresAt,
      userLogin: meta.userLogin,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      validatedAt,
      error: `GitHub probe network error: ${msg}`,
      expiresAt: null,
      userLogin: null,
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
    return { ...UNREGISTERED_GITHUB_SNAPSHOT };
  }
  // Mask the on-disk token once — prefix/suffix are deterministic per
  // token value, so we surface them on every snapshot regardless of
  // shape validity or cache freshness. The full token never leaves
  // this function except via these masked slices.
  const { prefix, suffix } = maskToken(token);
  const shapeOk = TOKEN_PATTERN.test(token);
  if (!shapeOk) {
    return {
      registered: true,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error:
        "Token does not match expected GitHub PAT shape (ghp_/ghs_/github_pat_).",
      token_prefix: prefix,
      token_suffix: suffix,
      token_expires_at: null,
      token_user_login: null,
    };
  }
  const fp = tokenFingerprint(token);
  const cached = probeCache.get(repoLocalPath);
  if (
    cached &&
    cached.tokenFingerprint === fp &&
    cached.cacheExpiresAtMs > Date.now()
  ) {
    return {
      registered: true,
      token_shape_valid: true,
      last_validated_at: cached.validatedAt,
      last_validation_error: cached.error,
      token_prefix: prefix,
      token_suffix: suffix,
      token_expires_at: cached.tokenExpiresAt,
      token_user_login: cached.userLogin,
    };
  }
  if (!probe) {
    // Snapshot-aggregation path: never hit the network. SPA renders
    // "not yet validated" until a GET / PATCH against this repo
    // populates the cache. Prefix/suffix are still surfaced — they
    // come from the on-disk token, not the network.
    return {
      registered: true,
      token_shape_valid: true,
      last_validated_at: null,
      last_validation_error: null,
      token_prefix: prefix,
      token_suffix: suffix,
      token_expires_at: null,
      token_user_login: null,
    };
  }
  const result = await probeGithubToken(token);
  probeCache.set(repoLocalPath, {
    validatedAt: result.validatedAt,
    error: result.error,
    tokenFingerprint: fp,
    cacheExpiresAtMs: Date.now() + PROBE_CACHE_TTL_MS,
    tokenExpiresAt: result.expiresAt,
    userLogin: result.userLogin,
  });
  return {
    registered: true,
    token_shape_valid: true,
    last_validated_at: result.validatedAt,
    last_validation_error: result.error,
    token_prefix: prefix,
    token_suffix: suffix,
    token_expires_at: result.expiresAt,
    token_user_login: result.userLogin,
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
    cacheExpiresAtMs: Date.now() + PROBE_CACHE_TTL_MS,
    tokenExpiresAt: probe.expiresAt,
    userLogin: probe.userLogin,
  });

  const { prefix, suffix } = maskToken(raw);
  const snapshot: GithubCredentialsSnapshot = {
    registered: true,
    token_shape_valid: true,
    last_validated_at: probe.validatedAt,
    last_validation_error: null,
    token_prefix: prefix,
    token_suffix: suffix,
    token_expires_at: probe.expiresAt,
    token_user_login: probe.userLogin,
  };
  json(res, 200, snapshot);
}
