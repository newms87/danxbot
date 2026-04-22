/**
 * Per-repo critical-failure flag at `<repo>/.danxbot/CRITICAL_FAILURE`.
 *
 * The worker writes this file when an environment-level blocker makes
 * further poller dispatches pointless — either because the agent
 * explicitly signalled `danxbot_complete({status:"critical_failure"})` or
 * because the post-dispatch "card didn't move out of ToDo" check caught a
 * zero-progress dispatch. The poller reads it at the top of every tick
 * and refuses to dispatch while it's present. The dashboard surfaces the
 * contents as a banner on the Agents tab.
 *
 * Ownership:
 * - Sole writer: the worker process (agent-signal path in
 *   `src/worker/dispatch.ts`, post-dispatch-check path in
 *   `src/poller/index.ts`).
 * - Readers: the poller's halt gate, `/health`, the dashboard's
 *   `/api/agents` surface, and the clear endpoint.
 * - Cleared by `rm` on disk or `DELETE /api/agents/:repo/critical-failure`
 *   from the dashboard — next poller tick resumes automatically.
 *
 * Format: pretty-printed JSON at the path. JSON (vs `key: value` plaintext)
 * because the dashboard reads this file via an HTTP endpoint and surfaces
 * the structured fields in the banner UI. Humans can still `cat` the file.
 *
 * No lock file: only one worker per repo writes, and writes are rare. The
 * tmp+rename pattern keeps readers from ever observing a half-written
 * file. See `.claude/rules/agent-dispatch.md` "Critical failure flag" for
 * the contract.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("critical-failure");

export type CriticalFailureSource =
  | "agent"
  | "post-dispatch-check"
  | "unparseable";

export interface CriticalFailurePayload {
  timestamp: string;
  source: CriticalFailureSource;
  dispatchId: string;
  reason: string;
  cardId?: string;
  cardUrl?: string;
  detail?: string;
}

const FLAG_FILENAME = "CRITICAL_FAILURE";

/**
 * Reason text returned to callers when the flag file exists but can't be
 * parsed. The poller halt gate must stay TRIPPED in this state — a
 * corrupt file should not silently re-enable dispatches. Operators clear
 * the flag by fixing or removing the file.
 */
const UNPARSEABLE_REASON =
  "Critical-failure flag file present but unparseable — operator must investigate";

export function flagPath(localPath: string): string {
  return resolve(localPath, ".danxbot", FLAG_FILENAME);
}

/**
 * Accept payloads that have the three required fields and a valid
 * `source`. Unknown extra fields are dropped. Invalid shapes return null
 * so `readFlag` can swap in the synthetic "unparseable" payload — a
 * corrupt file must still keep the poller halted (fail-closed).
 */
function normalize(raw: unknown): CriticalFailurePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const source = r.source;
  if (
    source !== "agent" &&
    source !== "post-dispatch-check" &&
    source !== "unparseable"
  ) {
    return null;
  }

  if (typeof r.timestamp !== "string" || !r.timestamp) return null;
  if (typeof r.dispatchId !== "string" || !r.dispatchId) return null;
  if (typeof r.reason !== "string" || !r.reason) return null;

  return {
    timestamp: r.timestamp,
    source,
    dispatchId: r.dispatchId,
    reason: r.reason,
    cardId: typeof r.cardId === "string" && r.cardId ? r.cardId : undefined,
    cardUrl: typeof r.cardUrl === "string" && r.cardUrl ? r.cardUrl : undefined,
    detail: typeof r.detail === "string" && r.detail ? r.detail : undefined,
  };
}

/**
 * Build the synthetic payload returned when the flag file exists but
 * can't be parsed. Fail-CLOSED behavior: the poller must stay halted
 * until a human investigates, so we never return `null` on parse
 * failure — only when the file is genuinely absent.
 */
function unparseablePayload(path: string): CriticalFailurePayload {
  return {
    timestamp: new Date().toISOString(),
    source: "unparseable",
    dispatchId: "unparseable",
    reason: UNPARSEABLE_REASON,
    detail:
      `File at ${path} could not be parsed as a critical-failure flag. ` +
      `Content may be corrupted. Poller stays halted until the file is fixed or cleared.`,
  };
}

/**
 * Read the flag. Returns `null` only when the file is absent. When the
 * file exists but fails to parse (I/O error, invalid JSON, missing
 * fields, unknown source), returns a synthetic "unparseable" payload so
 * the poller halt gate stays tripped — a corrupt file must not silently
 * re-enable dispatches. Never throws; callers depend on read-safety.
 */
export function readFlag(localPath: string): CriticalFailurePayload | null {
  const path = flagPath(localPath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const normalized = normalize(JSON.parse(raw));
    if (!normalized) {
      log.error(
        `Critical-failure flag at ${path} has invalid shape — treating as unparseable halt signal`,
      );
      return unparseablePayload(path);
    }
    return normalized;
  } catch (err) {
    log.error(`Failed to parse critical-failure flag at ${path}`, err);
    return unparseablePayload(path);
  }
}

/**
 * Write the flag. Stamps a timestamp if the caller didn't supply one,
 * creates `.danxbot/` if missing, and writes atomically via tmp+rename.
 * Returns the final payload that was persisted.
 */
export function writeFlag(
  localPath: string,
  payload: Omit<CriticalFailurePayload, "timestamp"> & { timestamp?: string },
): CriticalFailurePayload {
  const path = flagPath(localPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const final: CriticalFailurePayload = {
    timestamp: payload.timestamp ?? new Date().toISOString(),
    source: payload.source,
    dispatchId: payload.dispatchId,
    reason: payload.reason,
    cardId: payload.cardId,
    cardUrl: payload.cardUrl,
    detail: payload.detail,
  };

  const body = JSON.stringify(final, null, 2) + "\n";
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);

  log.warn(
    `Critical failure flag written at ${path}: ${final.reason} (source=${final.source})`,
  );
  return final;
}

/**
 * Remove the flag. Returns true when the file existed and was deleted,
 * false when it was already absent (idempotent). Throws only if the
 * unlink fails for a reason other than ENOENT. Uses a try/catch rather
 * than the existsSync pre-check so that a race between two concurrent
 * clears (operator rm + dashboard DELETE) resolves cleanly instead of
 * TOCTOU-throwing.
 */
export function clearFlag(localPath: string): boolean {
  const path = flagPath(localPath);
  try {
    unlinkSync(path);
    log.info(`Critical failure flag cleared at ${path}`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
