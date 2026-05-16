/**
 * DX-242: replay queued `danxbot_complete` signals at worker boot.
 *
 * When the worker is down at the moment an agent calls
 * `danxbot_complete`, the MCP server's fallback chain may write a
 * queue entry at `<repo>/.danxbot/dispatch-stops/<dispatchId>.json`
 * (see `src/mcp/danxbot-stop-fallback.ts`). On the next worker boot,
 * THIS module reads each entry and runs the same finalization the
 * live `handleStop` HTTP path runs — auto-sync the tracked YAML to
 * the tracker, mark the dispatch row terminal, then delete the queue
 * file.
 *
 * Idempotent: a row already in a terminal state is left alone (the
 * original terminal reason wins). Per-entry failures are logged +
 * recorded as `stop-replay`-source system errors so the dashboard
 * surfaces them; boot continues. The queue file stays on disk only if
 * the failure was transient — a retry on the NEXT boot cycle will
 * replay it cleanly.
 *
 * `critical_failure` semantics mirror the in-memory + `handleStopFromDb`
 * branches: the agent's halt signal lives in the per-repo flag file.
 * The MCP fallback's filesystem queue write does NOT generate the
 * `CRITICAL_FAILURE` flag — that's deferred to this replay path because
 * the worker is the only process that knows the repo's
 * `.danxbot/CRITICAL_FAILURE` path. Replay therefore writes the flag
 * here on the `critical_failure` branch.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import {
  getDispatchById,
  updateDispatch,
} from "../dashboard/dispatches-db.js";
import { isTerminalStatus } from "../dashboard/dispatches.js";
import { autoSyncTrackedIssue } from "./auto-sync.js";
import { writeFlag } from "../critical-failure.js";
import {
  COMPLETE_STATUSES,
  isCompleteStatus,
  mapCompleteToTerminalStatus,
} from "../mcp/danxbot-server.js";
import { stampIssueBlocked } from "../issue/stamp-blocked.js";
import type { RepoContext } from "../types.js";

const log = createLogger("replay-stop-queue");

export const STOP_QUEUE_DIR = join(".danxbot", "dispatch-stops");

interface StopQueueEntry {
  dispatchId: string;
  status: (typeof COMPLETE_STATUSES)[number];
  summary: string;
  timestamp: string;
}

export interface ReplayResult {
  scanned: number;
  replayed: string[];
  /** Already-terminal rows — file deleted, no DB write needed. */
  skipped: string[];
  /** Per-entry failures — file kept on disk for the next boot to retry. */
  failed: Array<{ file: string; error: string }>;
}

/**
 * Lazy-load `processCompletion` so this module's top-level import doesn't
 * pull `src/config.ts` (whose env validation triggers in tests that don't
 * configure the DB stack). Mirrors the same pattern `auto-sync.ts` uses
 * for `getDispatchById`.
 */
async function defaultGetDispatch(jobId: string) {
  return getDispatchById(jobId);
}

export interface ReplayStopQueueDeps {
  getDispatch?: typeof defaultGetDispatch;
  updateDispatchFn?: typeof updateDispatch;
  autoSync?: typeof autoSyncTrackedIssue;
  writeFlagFn?: typeof writeFlag;
  stampBlocked?: typeof stampIssueBlocked;
}

/**
 * Scan the queue directory and replay every entry. Caller is the
 * worker boot path in `src/index.ts`.
 *
 * Per-entry replay path:
 *   1. Read + parse the JSON. Malformed → log, recordSystemError,
 *      delete the file (a permanently-broken file would otherwise loop
 *      every boot).
 *   2. `getDispatchById(entry.dispatchId)`. Missing → delete (the row
 *      was cleaned up out of band).
 *   3. Already-terminal → delete (idempotent — the original terminal
 *      reason wins; this entry is leftover).
 *   4. `critical_failure` → write the per-repo critical-failure flag
 *      with the entry summary; mark the row `failed`.
 *   5. Otherwise → `autoSyncTrackedIssue` (best-effort tracker push)
 *      then `updateDispatch` to terminal status, then delete the file.
 *
 * On any IO failure during step 4/5: the file STAYS on disk so the
 * next boot retries. We log + recordSystemError so the dashboard
 * surfaces it. The `failed[]` return field captures these for tests.
 */
export async function replayStopQueue(
  repo: RepoContext,
  deps: ReplayStopQueueDeps = {},
): Promise<ReplayResult> {
  const dir = join(repo.localPath, STOP_QUEUE_DIR);
  const result: ReplayResult = {
    scanned: 0,
    replayed: [],
    skipped: [],
    failed: [],
  };

  // mkdirSync is idempotent — ensures the directory exists for future
  // queue writes even when boot finds nothing to replay.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // The directory creation MUST succeed on boot — without it the
    // MCP fallback can't queue future stops. Log + return; the next
    // boot retries.
    log.error(`[${repo.name}] Failed to ensure ${dir}`, err);
    return result;
  }

  if (!existsSync(dir)) return result;

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  result.scanned = files.length;
  if (files.length === 0) return result;

  const getDispatch = deps.getDispatch ?? defaultGetDispatch;
  const updateFn = deps.updateDispatchFn ?? updateDispatch;
  const autoSync = deps.autoSync ?? autoSyncTrackedIssue;
  const writeFlagFn = deps.writeFlagFn ?? writeFlag;
  const stampIssueBlockedFn = deps.stampBlocked ?? stampIssueBlocked;

  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const entry = parseEntry(fullPath);
      if (!entry) {
        // Malformed — surface and delete so we don't loop every boot.
        recordSystemError({
          source: "stop-replay",
          severity: "warn",
          repo: repo.name,
          message: `Discarded malformed stop-queue entry: ${file}`,
        });
        unlinkSync(fullPath);
        result.failed.push({ file, error: "malformed" });
        continue;
      }

      const dispatch = await getDispatch(entry.dispatchId);
      if (!dispatch) {
        // Row gone — drop the queue entry; nothing left to update.
        unlinkSync(fullPath);
        result.skipped.push(entry.dispatchId);
        log.info(
          `[${repo.name}] Stop-queue entry ${entry.dispatchId} has no dispatch row — discarded`,
        );
        continue;
      }

      if (isTerminalStatus(dispatch.status)) {
        // Already finalized (in-memory handleStop got there first, or a
        // prior boot replayed it). Idempotent — keep the prior reason.
        unlinkSync(fullPath);
        result.skipped.push(entry.dispatchId);
        continue;
      }

      // agent_blocked: stamp the candidate YAML before finalizing the
      // row. Boot replay mirrors the live handleStop ordering. Missing
      // issueId is non-fatal here (row still finalizes as failed); a
      // queue entry produced by a live agent_blocked call ALWAYS
      // carries a dispatch row with issueId (the MCP server gates on
      // it), so the no-issueId branch is defensive only.
      const terminatedAt = Date.now();
      if (entry.status === "agent_blocked") {
        if (dispatch.issueId) {
          try {
            stampIssueBlockedFn({
              repoLocalPath: repo.localPath,
              candidateId: dispatch.issueId,
              expectedPrefix: repo.issuePrefix,
              reason: entry.summary,
              at: new Date(terminatedAt).toISOString(),
            });
          } catch (err) {
            log.error(
              `[${repo.name}] replay stampIssueBlocked failed for ${dispatch.issueId} (continuing finalize)`,
              err,
            );
          }
        } else {
          log.warn(
            `[${repo.name}] queued agent_blocked entry ${entry.dispatchId} has no issueId on the row — finalizing without YAML stamp`,
          );
        }
        await autoSync(entry.dispatchId, repo);
        await updateFn(entry.dispatchId, {
          status: "failed",
          summary: entry.summary,
          completedAt: terminatedAt,
          pidTerminatedAt: terminatedAt,
        });
        unlinkSync(fullPath);
        result.replayed.push(entry.dispatchId);
        continue;
      }

      // critical_failure: write the halt flag like the live handleStop
      // does. The flag is the operator's surface; the row goes
      // `failed` (not `critical_failure` — the DB schema collapses).
      if (entry.status === "critical_failure") {
        writeFlagFn(repo.localPath, {
          source: "agent",
          dispatchId: entry.dispatchId,
          reason: "Agent-signaled critical failure (replayed from queue)",
          detail: entry.summary,
        });
        await updateFn(entry.dispatchId, {
          status: "failed",
          summary: entry.summary,
          completedAt: terminatedAt,
          pidTerminatedAt: terminatedAt,
        });
        unlinkSync(fullPath);
        result.replayed.push(entry.dispatchId);
        continue;
      }

      // DX-322 — `rate_limited` flows through the normal terminal
      // mapping (→ DispatchStatus `"throttled"`); no critical_failure
      // flag write. The live `handleRateLimitThrottle` in the worker
      // already wrote the throttle flag (with `resume_at`) before the
      // queue entry was produced. Re-writing here without `resume_at`
      // (the queued entry doesn't carry it) would degrade the flag to
      // an unparseable shape and re-halt the poller — exactly the
      // failure mode the throttle feature exists to prevent.

      // Normal terminal: best-effort auto-sync (tracker push), then
      // finalize the row, then delete the file. Same ordering as the
      // live handleStop path. `mapCompleteToTerminalStatus` is the
      // shared collapse helper — sole source of truth for the
      // critical_failure → failed mapping (DX-242).
      await autoSync(entry.dispatchId, repo);
      const dbStatus = mapCompleteToTerminalStatus(entry.status);
      await updateFn(entry.dispatchId, {
        status: dbStatus,
        summary: entry.summary,
        completedAt: terminatedAt,
        pidTerminatedAt: terminatedAt,
      });
      unlinkSync(fullPath);
      result.replayed.push(entry.dispatchId);
      log.info(
        `[${repo.name}] Replayed queued stop ${entry.dispatchId} → ${dbStatus}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[${repo.name}] Failed to replay stop-queue entry ${file}: ${message}`,
      );
      recordSystemError({
        source: "stop-replay",
        severity: "error",
        repo: repo.name,
        message: `Failed to replay queued stop ${file}: ${message}`,
        details: { file },
      });
      // Leave the file on disk for the next boot.
      result.failed.push({ file, error: message });
    }
  }

  return result;
}

function parseEntry(path: string): StopQueueEntry | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const dispatchId = obj.dispatchId;
  const status = obj.status;
  const summary = obj.summary;
  const timestamp = obj.timestamp;
  if (
    typeof dispatchId !== "string" ||
    !isCompleteStatus(status) ||
    typeof summary !== "string" ||
    typeof timestamp !== "string"
  ) {
    return undefined;
  }
  return { dispatchId, status, summary, timestamp };
}
