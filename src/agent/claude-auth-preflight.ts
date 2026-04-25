/**
 * Claude-auth preflight (Trello 3l2d7i46).
 *
 * Three claude-auth misconfigurations all surface as the SAME silent dispatch
 * timeout — `claude -p` exits 0 with empty stdout, the watcher never attaches,
 * the worker eventually times out with a useless "Agent timed out after N
 * seconds of inactivity" summary that points at network/model/dispatch
 * instead of at the actual problem (broken auth files):
 *
 *   1. Read-only bind mount on `~/.claude.json` or `~/.claude/.credentials.json`
 *      — claude tries to rewrite session metadata or rotate the OAuth token,
 *      the write fails, `-p` mode exits silently. Original incident: PHevzRil.
 *   2. Expired OAuth token — snapshot dir that never rotated, `expiresAt` is
 *      in the past. Refresh attempt fails inside `-p` mode, exits silently.
 *   3. Half-configured layout — one of the auth files missing entirely
 *      (e.g. dev shell that ran `cp` for the config but skipped the creds).
 *
 * This preflight runs before `spawnAgent` actually forks claude and
 * before the more expensive MCP probe, so a broken auth chain fails the
 * dispatch loudly at launch instead of burning N seconds of inactivity
 * timeout. Cost is bounded by file IO on the bind — well under 1ms.
 *
 * The summary strings reference the actual misconfiguration AND the trail
 * back to the operator action that fixes it (compose mount for RO, host
 * claude refresh / worker redeploy for expiry). They are surfaced verbatim
 * to the dispatch caller as the launch-failure error string AND to the
 * operator via the worker `/health` endpoint's `claude_auth.summary` field.
 */

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PreflightFailureReason =
  | "missing"
  | "readonly"
  | "expired"
  | "malformed"
  | "unreachable";

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: PreflightFailureReason; summary: string };

export interface PreflightOptions {
  /**
   * Path to the `.claude.json` session-metadata file. Defaults to
   * `${homedir()}/.claude.json`. Tests inject a temp path; the worker
   * runs claude as the `danxbot` user whose `$HOME` is `/home/danxbot`,
   * so the default resolves correctly inside the container.
   */
  claudeJsonPath?: string;
  /**
   * Path to the `.credentials.json` OAuth bearer file. Defaults to
   * `${homedir()}/.claude/.credentials.json`.
   */
  credentialsPath?: string;
  /**
   * Now-clock for the `expiresAt` comparison. Default `() => Date.now()`.
   * Tests inject a fixed value so expiry-window assertions are
   * deterministic.
   */
  now?: () => number;
}

function defaultClaudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

function defaultCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

/**
 * Run the four-step preflight. Steps short-circuit at the first failure
 * — once we know `.claude.json` is missing, we don't bother probing
 * `.credentials.json`, because the operator is going to re-run the auth
 * setup script anyway and a single concise reason is more actionable
 * than a list of cascading failures.
 *
 * Symlinks are followed: `fs.access(W_OK)` checks the symlink target's
 * permissions, which is exactly what we need — the canonical container
 * layout puts symlinks at `~/.claude.json` / `~/.claude/.credentials.json`
 * pointing at the bind-mount source under `$CLAUDE_AUTH_DIR`. RO bind
 * → target is RO → access(W_OK) → EACCES → reason="readonly".
 */
export async function preflightClaudeAuth(
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const credentialsPath = opts.credentialsPath ?? defaultCredentialsPath();
  const now = opts.now ?? Date.now;

  const claudeJsonCheck = await checkWritable(claudeJsonPath, ".claude.json");
  if (!claudeJsonCheck.ok) return claudeJsonCheck;

  const credsCheck = await checkWritable(credentialsPath, ".credentials.json");
  if (!credsCheck.ok) return credsCheck;

  let raw: string;
  try {
    raw = await readFile(credentialsPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      summary: `Cannot read claude-auth credentials at ${credentialsPath}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      summary: `claude-auth credentials at ${credentialsPath} is not valid JSON: ${(err as Error).message}`,
    };
  }

  const expiresAt = extractExpiresAt(parsed);
  if (expiresAt === null) {
    return {
      ok: false,
      reason: "malformed",
      summary: `claude-auth credentials at ${credentialsPath} is missing claudeAiOauth.expiresAt (number, epoch ms)`,
    };
  }

  if (expiresAt < now()) {
    const expiredAtIso = new Date(expiresAt).toISOString();
    return {
      ok: false,
      reason: "expired",
      summary: `claude-auth OAuth token expired at ${expiredAtIso} — host claude needs to refresh, or worker needs a redeploy`,
    };
  }

  return { ok: true };
}

/**
 * Single-file check: existence + writability. Distinguishes ENOENT (missing)
 * from EACCES/EPERM (read-only). Anything else is reported as "missing" with
 * the underlying error message — those are not failure modes the AC bullets
 * promise to classify, but lumping them with "missing" still gives the
 * operator a clear "your auth chain is broken" signal.
 */
async function checkWritable(
  filePath: string,
  label: string,
): Promise<PreflightResult> {
  try {
    await access(filePath, fsConstants.W_OK);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: "missing",
        summary: `claude-auth file ${label} is missing at ${filePath} — re-run scripts/claude-auth-setup.sh or restart the worker`,
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        reason: "readonly",
        summary: `claude-auth file ${label} at ${filePath} is read-only — fix the bind mount in compose.yml so claude can rotate credentials`,
      };
    }
    // Anything else: EIO, ELOOP, EROFS, ENOTDIR. Distinct reason from
    // "missing" so the dashboard's category-specific remediation hint
    // doesn't say "re-run setup" for an IO error.
    return {
      ok: false,
      reason: "unreachable",
      summary: `claude-auth file ${label} at ${filePath} is unreachable: ${(err as Error).message}`,
    };
  }
}

/**
 * Pluck `claudeAiOauth.expiresAt` from a parsed credentials object. Returns
 * null when the field is missing or not a number — both surface as the
 * same "malformed" reason because both produce the same operator action
 * (re-run claude-auth setup on the host, then redeploy / restart the worker).
 */
function extractExpiresAt(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const expiresAt = (oauth as Record<string, unknown>).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return expiresAt;
}

/**
 * Throw-shaped wrapper for callers that prefer typed errors over union
 * results. Used by `spawnAgent` so the dispatch path can `catch
 * (ClaudeAuthError)` and map to a 503 response without re-classifying.
 */
export class ClaudeAuthError extends Error {
  readonly reason: PreflightFailureReason;
  constructor(result: Extract<PreflightResult, { ok: false }>) {
    super(result.summary);
    this.name = "ClaudeAuthError";
    this.reason = result.reason;
  }
}
