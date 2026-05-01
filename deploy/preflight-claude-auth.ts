/**
 * Deploy-time claude-auth preflight.
 *
 * The deploy step ships `<claudeAuthDir>/.claude.json` and
 * `<claudeAuthDir>/.claude/.credentials.json` to the EC2 instance, where
 * the worker container bind-mounts them and runs `claude` against the
 * live OAuth token. When `claude_auth_dir` points at a snapshot dir
 * (platform deploy uses `../../claude-auth/`) the host CLI never rotates
 * those files, so the token stamped at last login eventually expires and
 * every dispatch on the deployed worker dies with `claude-auth OAuth
 * token expired at …` (the runtime preflight in
 * `src/agent/claude-auth-preflight.ts` correctly attributes it but
 * cannot fix it from inside the container — only fresh creds + a
 * redeploy clear it).
 *
 * This deploy preflight closes that loop by validating + refreshing
 * creds BEFORE any destructive deploy step (SSM push, scp, terraform
 * apply, container recreate). Two-layer strategy:
 *
 *   1. **Refresh the OAuth bearer** via the same `refresh_token` grant
 *      `~/.claude/bin/clad` uses. Cheap (~150 ms), free, gives every
 *      deploy a fresh ~30-day expiresAt window. If the refresh succeeds
 *      we rewrite the file in place and continue.
 *   2. **If the refresh token itself is dead** (revoked, expired, or
 *      account changed), launch `claude auth login` against the snapshot
 *      dir so the user can re-auth in their browser and `/exit`. The
 *      deploy then re-reads the creds and continues — no manual rerun.
 *
 * The OAuth refresh endpoint + client_id are taken verbatim from clad
 * (also Anthropic's published OAuth flow). Using the same client_id is
 * what lets a manually-issued token survive across `clad` and this
 * preflight without re-login.
 */

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

export type PreflightOutcome =
  | { ok: true; action: "refreshed" | "kept" | "reauthed" }
  | { ok: false; reason: PreflightFailureReason; summary: string };

export type PreflightFailureReason =
  | "missing"
  | "malformed"
  | "reauth_failed";

/**
 * Thrown by `readCreds` when a credentials file exists but cannot be
 * parsed as JSON or fails the shape contract. Lets the caller surface
 * `reason: "malformed"` distinctly from `reason: "missing"` (file
 * absent → null return) so the operator gets an actionable diagnostic
 * instead of a silent reauth that overwrites recoverable state.
 */
export class MalformedCredsError extends Error {
  constructor(path: string, cause: string) {
    super(
      `claude-auth credentials at ${path} is unreadable: ${cause}. Inspect or delete the file before re-running deploy.`,
    );
    this.name = "MalformedCredsError";
  }
}

export interface PreflightDeps {
  /**
   * Read + parse credentials JSON. Resolves null when file is absent;
   * throws `MalformedCredsError` when the file exists but cannot be
   * parsed. Distinct return values keep "no creds yet" cleanly
   * separable from "creds present but corrupted" — the caller routes
   * each to a different summary.
   */
  readCreds: (path: string) => Promise<ClaudeCredentials | null>;
  /** Atomically rewrite credentials file. */
  writeCreds: (path: string, creds: ClaudeCredentials) => Promise<void>;
  /**
   * POST to the OAuth refresh endpoint. Resolves a refreshed pair on
   * success, null on any failure (network, invalid_grant, rate-limit,
   * malformed response). The caller decides whether to fall through to
   * reauth based on token expiry, not on this return value alone.
   */
  refreshOAuth: (refreshToken: string) => Promise<RefreshResponse | null>;
  /**
   * Run `claude auth login` interactively against the snapshot dir.
   * Returns when the user exits the spawned claude process. Throws on
   * spawn errors; non-zero exit codes are treated as user-cancelled
   * reauth (a subsequent `readCreds` will report whether the file
   * actually got refreshed).
   */
  spawnReauth: (claudeAuthDir: string) => Promise<void>;
  /** Now-clock for expiry comparison. Tests inject a fixed value. */
  now: () => number;
  /** Logger (defaults to console). Tests inject a noop. */
  log: (msg: string) => void;
}

/**
 * Resolve the canonical paths inside a snapshot auth dir. Mirrors
 * `deploy/workers.ts` (`claudeConfigFile` + `claudeCredsDir`) so a typo
 * here would break the worker bind-mount in lockstep — tests catch it.
 */
export function authPaths(claudeAuthDir: string): {
  claudeJson: string;
  credentials: string;
  credsDir: string;
} {
  return {
    claudeJson: resolve(claudeAuthDir, ".claude.json"),
    credsDir: resolve(claudeAuthDir, ".claude"),
    credentials: resolve(claudeAuthDir, ".claude", ".credentials.json"),
  };
}

export async function preflightClaudeAuth(
  claudeAuthDir: string,
  deps: PreflightDeps,
): Promise<PreflightOutcome> {
  const { credentials } = authPaths(claudeAuthDir);
  let creds: ClaudeCredentials | null;
  try {
    creds = await deps.readCreds(credentials);
  } catch (err) {
    if (err instanceof MalformedCredsError) {
      return { ok: false, reason: "malformed", summary: err.message };
    }
    throw err;
  }

  // Path 1: file missing entirely → reauth required.
  if (!creds) {
    deps.log(
      `claude-auth credentials missing at ${credentials} — launching reauth flow`,
    );
    return runReauth(claudeAuthDir, deps);
  }

  if (
    !creds.claudeAiOauth ||
    typeof creds.claudeAiOauth.refreshToken !== "string" ||
    typeof creds.claudeAiOauth.expiresAt !== "number"
  ) {
    return {
      ok: false,
      reason: "malformed",
      summary: `claude-auth credentials at ${credentials} is missing claudeAiOauth.{refreshToken,expiresAt} — delete the file and re-run deploy to trigger reauth`,
    };
  }

  // Path 2: try refresh unconditionally. Even a healthy token benefits
  // — every successful deploy resets the expiresAt window so the worker
  // has the longest possible runway before a future deploy is forced.
  const refreshed = await deps.refreshOAuth(creds.claudeAiOauth.refreshToken);
  if (refreshed) {
    const updated: ClaudeCredentials = {
      ...creds,
      claudeAiOauth: {
        ...creds.claudeAiOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: deps.now() + refreshed.expiresInSec * 1000,
      },
    };
    await deps.writeCreds(credentials, updated);
    deps.log(
      `claude-auth refreshed — new expiresAt=${new Date(updated.claudeAiOauth.expiresAt).toISOString()}`,
    );
    return { ok: true, action: "refreshed" };
  }

  // Path 3: refresh failed but token still has runway → ship it as-is
  // and warn. Worker will work until the existing expiresAt; next deploy
  // gets another chance to refresh or reauth.
  if (creds.claudeAiOauth.expiresAt > deps.now()) {
    deps.log(
      `WARNING: claude-auth refresh failed but token is still valid until ${new Date(creds.claudeAiOauth.expiresAt).toISOString()} — uploading existing creds. Next deploy will retry refresh.`,
    );
    return { ok: true, action: "kept" };
  }

  // Path 4: refresh failed AND token expired → reauth required.
  deps.log(
    `claude-auth token expired at ${new Date(creds.claudeAiOauth.expiresAt).toISOString()} and refresh failed — launching reauth flow`,
  );
  return runReauth(claudeAuthDir, deps);
}

async function runReauth(
  claudeAuthDir: string,
  deps: PreflightDeps,
): Promise<PreflightOutcome> {
  await deps.spawnReauth(claudeAuthDir);

  // Re-read after spawn returns. Two failure modes:
  //   - User canceled (Ctrl+C, /exit before completing /login) → file
  //     unchanged or absent → still expired/missing.
  //   - Login wrote creds but to wrong dir (HOME override broken) →
  //     file unchanged.
  // Both surface as the same retry hint. The user's next action is
  // re-running `make deploy TARGET=…` after fixing.
  const { credentials } = authPaths(claudeAuthDir);
  let after: ClaudeCredentials | null;
  try {
    after = await deps.readCreds(credentials);
  } catch (err) {
    if (err instanceof MalformedCredsError) {
      return { ok: false, reason: "malformed", summary: err.message };
    }
    throw err;
  }
  if (!after || !after.claudeAiOauth) {
    return {
      ok: false,
      reason: "reauth_failed",
      summary: `Reauth did not produce credentials at ${credentials}. Run \`HOME=${claudeAuthDir} claude auth login\` manually, then rerun deploy.`,
    };
  }
  if (
    typeof after.claudeAiOauth.expiresAt !== "number" ||
    after.claudeAiOauth.expiresAt <= deps.now()
  ) {
    return {
      ok: false,
      reason: "reauth_failed",
      summary: `Reauth left an expired/malformed token at ${credentials}. Run \`HOME=${claudeAuthDir} claude auth login\` manually, then rerun deploy.`,
    };
  }
  deps.log(
    `claude-auth reauth complete — expiresAt=${new Date(after.claudeAiOauth.expiresAt).toISOString()}`,
  );
  return { ok: true, action: "reauthed" };
}

/* ────────────────────────────────────────────────────────────────────
 *  Production deps: real fs + real fetch + real spawn
 * ──────────────────────────────────────────────────────────────────── */

export const realReadCreds: PreflightDeps["readCreds"] = async (path) => {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  try {
    return JSON.parse(raw) as ClaudeCredentials;
  } catch (err) {
    // File exists but is corrupted — surface distinctly so the caller
    // can route to `reason: "malformed"` instead of overwriting it via
    // a silent reauth. Both branches of the previous `catch { return
    // null }` collapsed missing-file and corrupt-file into the same
    // signal, defeating the operator-facing diagnostic.
    throw new MalformedCredsError(path, (err as Error).message);
  }
};

/**
 * Atomic write: stage at `<path>.tmp`, fsync via writeFile (Node's
 * fs.promises.writeFile fsyncs by default on POSIX), then rename over
 * the target. `rename` is atomic on the same filesystem, so a crash
 * mid-write leaves either the old file intact or the new one in place
 * — never a truncated/zero-byte creds file the worker would
 * bind-mount in production.
 */
export const realWriteCreds: PreflightDeps["writeCreds"] = async (
  path,
  creds,
) => {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(creds, null, 2), "utf-8");
  await rename(tmp, path);
};

export const realRefreshOAuth: PreflightDeps["refreshOAuth"] = async (
  refreshToken,
) => {
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
  } catch (err) {
    console.warn(
      `  claude-auth refresh: network error → ${(err as Error).message}`,
    );
    return null;
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ` body=${(await res.text()).slice(0, 200)}`;
    } catch {
      // Ignore — surfacing the status alone is enough.
    }
    console.warn(`  claude-auth refresh: HTTP ${res.status}${detail}`);
    return null;
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `  claude-auth refresh: response was not JSON → ${(err as Error).message}`,
    );
    return null;
  }
  const accessToken = body["access_token"];
  const newRefresh = body["refresh_token"];
  const expiresIn = body["expires_in"];
  if (
    typeof accessToken !== "string" ||
    typeof newRefresh !== "string" ||
    typeof expiresIn !== "number"
  ) {
    console.warn(
      `  claude-auth refresh: response missing access_token/refresh_token/expires_in (keys=${Object.keys(body).join(",")})`,
    );
    return null;
  }
  return {
    accessToken,
    refreshToken: newRefresh,
    expiresInSec: expiresIn,
  };
};

/**
 * Spawn `claude auth login` with HOME=<claudeAuthDir>. Claude reads
 * `$HOME/.claude.json` + `$HOME/.claude/.credentials.json` for OAuth
 * state, so overriding HOME points it at the snapshot dir without
 * touching the operator's primary `~/.claude/`. stdio is inherited so
 * the user can complete the browser flow and `/exit` interactively.
 *
 * The spawned env is built from a curated allowlist rather than
 * spreading `process.env`, because pre-existing `XDG_CONFIG_HOME`,
 * `CLAUDE_CONFIG_DIR`, `CLAUDE_AUTH_DIR`, `CLAUDE_CONFIG_FILE`, or
 * `CLAUDE_CREDS_DIR` would override the HOME redirect and write
 * creds to the wrong dir. Operator's broader env is irrelevant to the
 * `claude auth login` flow — only PATH, TERM, and the standard tty
 * descriptors matter.
 *
 * Promise resolves on process exit regardless of exit code — caller
 * verifies success by re-reading the credentials file. A non-zero exit
 * (user Ctrl+C, login canceled) leaves creds unchanged, which surfaces
 * as `reauth_failed` in the next preflight pass.
 */
export const realSpawnReauth: PreflightDeps["spawnReauth"] = async (
  claudeAuthDir,
) => {
  console.log(
    `\n── Launching \`claude auth login\` against ${claudeAuthDir} ──`,
  );
  console.log(
    "  Complete the browser flow, then type /exit to return to the deploy.\n",
  );
  const passthrough = ["PATH", "TERM", "LANG", "LC_ALL", "USER", "LOGNAME"];
  const env: Record<string, string> = { HOME: claudeAuthDir };
  for (const key of passthrough) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn("claude", ["auth", "login"], {
      stdio: "inherit",
      env,
    });
    child.on("error", rejectSpawn);
    child.on("exit", () => resolveSpawn());
  });
};

export function buildRealDeps(): PreflightDeps {
  return {
    readCreds: realReadCreds,
    writeCreds: realWriteCreds,
    refreshOAuth: realRefreshOAuth,
    spawnReauth: realSpawnReauth,
    now: () => Date.now(),
    log: (msg) => console.log(`  ${msg}`),
  };
}
