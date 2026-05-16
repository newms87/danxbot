/**
 * DX-294: replay queued prep-verdict signals at worker boot.
 *
 * When the worker is down at the moment a prep agent calls
 * `danxbot_prep_verdict`, the MCP server's fallback chain writes a
 * queue entry at `<repo>/.danxbot/prep-verdicts/<dispatchId>.json`
 * (see `src/mcp/danxbot-prep-verdict.ts`). On the next worker boot,
 * THIS module reads each entry and applies the verdict's YAML /
 * settings side-effects + finalizes the dispatch row by replaying the
 * payload through the same helpers `handlePrepVerdict` runs in the
 * live path.
 *
 * **Mirrors `replay-stop-queue.ts`.** Both modules consume MCP-side
 * fallback queues at boot; the verdict queue differs only in (a) the
 * directory name (`prep-verdicts/` vs `dispatch-stops/`) and (b) the
 * side-effect surface (verdicts mutate YAML / settings; completion
 * mutates the dispatches row + auto-syncs the tracker). Sharing the
 * shape lets a future operator-facing audit view treat both queues
 * uniformly.
 *
 * Idempotency: a row already terminal is left alone (the original
 * terminal reason wins). YAML side-effects are themselves idempotent
 * — re-applying a `conflict_on` payload appends only the missing ids
 * (dedup by id, first-reason-wins); re-applying a `blocked` payload
 * re-stamps the timestamp but the status + reason are stable. The
 * `abort` path re-stamps `agents.<name>.broken.set_at` — that's a
 * non-issue because the picker filter cares about non-null, not
 * timestamp freshness.
 *
 * Per-entry failures are logged + recorded as `prep-verdict-replay`
 * source system errors so the dashboard surfaces them; the queue file
 * stays on disk for the next boot to retry. Malformed files are
 * deleted (a permanently-broken file would otherwise loop every
 * boot).
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
import {
  PREP_VERDICT_QUEUE_DIR,
  parsePrepVerdictArgs,
  mapTerminalVerdictToDispatchStatus,
  type PrepVerdictPayload,
} from "../mcp/danxbot-prep-verdict.js";
import { defaultBrokenEvaluator, setAgentBroken } from "../settings-file.js";
import {
  parseIssue,
  serializeIssue,
  IssueParseError,
} from "../issue-tracker/yaml.js";
import { issuePath } from "../poller/yaml-lifecycle.js";
import { writeFileSync } from "node:fs";
import type { Issue } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

const log = createLogger("replay-prep-verdict-queue");

export interface QueuedPrepVerdict {
  dispatchId: string;
  payload: PrepVerdictPayload;
  timestamp: string;
}

export interface PrepVerdictReplayResult {
  scanned: number;
  replayed: string[];
  /** Already-terminal rows OR rows whose dispatch row vanished — file deleted, no work needed. */
  skipped: string[];
  /** Per-entry failures — file kept on disk for the next boot to retry. */
  failed: Array<{ file: string; error: string }>;
}

/**
 * Injectable deps mirroring the ones `replay-stop-queue.ts` uses, so
 * test fixtures can stub the DB lookup + settings writer + tracker
 * primitives without dragging in the full worker boot path.
 */
export interface ReplayPrepVerdictQueueDeps {
  getDispatch?: typeof getDispatchById;
  updateDispatchFn?: typeof updateDispatch;
  setBroken?: typeof setAgentBroken;
}

async function defaultGetDispatch(jobId: string) {
  return getDispatchById(jobId);
}

function parseEntry(path: string): QueuedPrepVerdict | undefined {
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
  const rawPayload = obj.payload;
  const timestamp = obj.timestamp;
  if (
    typeof dispatchId !== "string" ||
    typeof timestamp !== "string" ||
    typeof rawPayload !== "object" ||
    rawPayload === null
  ) {
    return undefined;
  }
  let payload: PrepVerdictPayload;
  try {
    payload = parsePrepVerdictArgs(rawPayload as Record<string, unknown>);
  } catch {
    return undefined;
  }
  return { dispatchId, payload, timestamp };
}

/**
 * Apply the queued verdict's YAML / settings side-effects against
 * the live filesystem. Mirrors the live handler's branches but takes
 * the candidate id + agent name as args (they came off the dispatch
 * row at queue-write time → re-read off the row at replay time).
 *
 * Throws on parse / IO failure so the replay loop logs + leaves the
 * file on disk.
 */
async function applyQueuedVerdict(
  payload: PrepVerdictPayload,
  repo: RepoContext,
  candidateId: string | null,
  agentName: string | null,
  setBroken: typeof setAgentBroken,
): Promise<void> {
  if (payload.verdict === "ok") {
    // No YAML / settings side-effect for `ok`. The only effect is
    // the dispatches row terminal status, which the caller writes
    // after this returns.
    return;
  }
  if (payload.verdict === "conflict_on") {
    if (!candidateId) {
      throw new Error("conflict_on replay missing issue_id on dispatch row");
    }
    const filePath = issuePath(repo.localPath, candidateId, "open");
    if (!existsSync(filePath)) {
      throw new Error(`candidate YAML not found at ${filePath}`);
    }
    const issue = parseIssue(readFileSync(filePath, "utf-8"), {
      expectedPrefix: repo.issuePrefix,
    });
    const existing = new Set(issue.conflict_on.map((c) => c.id));
    const additions: { id: string; reason: string }[] = [];
    for (const id of payload.conflict_with ?? []) {
      if (existing.has(id)) continue;
      existing.add(id);
      additions.push({ id, reason: payload.reason });
    }
    if (additions.length === 0) return;
    const next: Issue = {
      ...issue,
      conflict_on: [...issue.conflict_on, ...additions],
    };
    writeFileSync(filePath, serializeIssue(next));
    return;
  }
  if (payload.verdict === "waiting_on") {
    if (!candidateId) {
      throw new Error("waiting_on replay missing issue_id on dispatch row");
    }
    const filePath = issuePath(repo.localPath, candidateId, "open");
    if (!existsSync(filePath)) {
      throw new Error(`candidate YAML not found at ${filePath}`);
    }
    const issue = parseIssue(readFileSync(filePath, "utf-8"), {
      expectedPrefix: repo.issuePrefix,
    });
    const existingBy = issue.waiting_on?.by ?? [];
    const seen = new Set(existingBy);
    const mergedBy = [...existingBy];
    for (const id of payload.depends_on) {
      if (seen.has(id)) continue;
      seen.add(id);
      mergedBy.push(id);
    }
    const noChange =
      issue.waiting_on !== null &&
      issue.waiting_on.reason === payload.reason &&
      mergedBy.length === existingBy.length;
    if (noChange) return;
    const next: Issue = {
      ...issue,
      waiting_on: {
        by: mergedBy,
        reason: payload.reason,
        timestamp: new Date().toISOString(),
      },
    };
    writeFileSync(filePath, serializeIssue(next));
    return;
  }
  if (payload.verdict === "blocked") {
    if (!candidateId) {
      throw new Error("blocked replay missing issue_id on dispatch row");
    }
    const filePath = issuePath(repo.localPath, candidateId, "open");
    if (!existsSync(filePath)) {
      throw new Error(`candidate YAML not found at ${filePath}`);
    }
    const issue = parseIssue(readFileSync(filePath, "utf-8"), {
      expectedPrefix: repo.issuePrefix,
    });
    const next: Issue = {
      ...issue,
      status: "Blocked",
      blocked: {
        reason: payload.reason,
        at: new Date().toISOString(),
      },
      waiting_on: null,
    };
    writeFileSync(filePath, serializeIssue(next));
    return;
  }
  // abort
  if (!agentName) {
    throw new Error("abort replay missing agent_name on dispatch row");
  }
  await setBroken(
    repo.localPath,
    agentName,
    {
      reason: payload.reason,
      suggested_steps:
        payload.broken_details?.suggested_steps ?? [],
      set_at: new Date().toISOString(),
      // DX-364 — replay path mirrors `applyAbortVerdict`.
      ...defaultBrokenEvaluator(),
    },
    "worker",
  );
}

/**
 * Scan the queue directory and replay every entry. Caller is the
 * worker boot path in `src/worker/server.ts` (or wherever
 * `replay-stop-queue` is currently wired).
 */
export async function replayPrepVerdictQueue(
  repo: RepoContext,
  deps: ReplayPrepVerdictQueueDeps = {},
): Promise<PrepVerdictReplayResult> {
  const dir = join(repo.localPath, PREP_VERDICT_QUEUE_DIR);
  const result: PrepVerdictReplayResult = {
    scanned: 0,
    replayed: [],
    skipped: [],
    failed: [],
  };

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error(`[${repo.name}] Failed to ensure ${dir}`, err);
    return result;
  }

  if (!existsSync(dir)) return result;

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  result.scanned = files.length;
  if (files.length === 0) return result;

  const getDispatch = deps.getDispatch ?? defaultGetDispatch;
  const updateFn = deps.updateDispatchFn ?? updateDispatch;
  const setBroken = deps.setBroken ?? setAgentBroken;

  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const entry = parseEntry(fullPath);
      if (!entry) {
        recordSystemError({
          source: "prep-verdict-replay",
          severity: "warn",
          repo: repo.name,
          message: `Discarded malformed prep-verdict queue entry: ${file}`,
        });
        unlinkSync(fullPath);
        result.failed.push({ file, error: "malformed" });
        continue;
      }

      const dispatch = await getDispatch(entry.dispatchId);
      if (!dispatch) {
        // Row gone — drop the entry; nothing to update.
        unlinkSync(fullPath);
        result.skipped.push(entry.dispatchId);
        log.info(
          `[${repo.name}] Prep-verdict entry ${entry.dispatchId} has no dispatch row — discarded`,
        );
        continue;
      }

      // YAML / settings side-effects are idempotent (re-apply is safe
      // for all branches — see file header). Apply BEFORE checking
      // dispatch-row terminal so a row that landed terminal via a
      // separate path (live handler that succeeded after the fs queue
      // was written) STILL gets the side-effect re-applied. The
      // dedupe protections cover the re-apply cost.
      await applyQueuedVerdict(
        entry.payload,
        repo,
        dispatch.issueId,
        dispatch.agentName,
        setBroken,
      );

      if (isTerminalStatus(dispatch.status)) {
        // Side-effect re-applied; dispatch row already terminal —
        // delete the file and move on.
        unlinkSync(fullPath);
        result.skipped.push(entry.dispatchId);
        continue;
      }

      // Finalize the dispatch row for terminating verdicts. `ok` in
      // combined mode would have kept running in the live path; the
      // worker-down scenario means the agent process is gone too, so
      // marking the row `completed` is the only sensible terminal.
      // `ok` in separate mode + every non-ok verdict map identically.
      const terminal =
        entry.payload.verdict === "ok"
          ? "completed"
          : mapTerminalVerdictToDispatchStatus(entry.payload.verdict);
      const terminatedAt = Date.now();
      await updateFn(entry.dispatchId, {
        status: terminal,
        summary: `prep verdict ${entry.payload.verdict} (boot-replayed): ${entry.payload.reason}`,
        completedAt: terminatedAt,
        pidTerminatedAt: terminatedAt,
      });
      unlinkSync(fullPath);
      result.replayed.push(entry.dispatchId);
      log.info(
        `[${repo.name}] Replayed queued prep-verdict ${entry.dispatchId} (${entry.payload.verdict} → ${terminal})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[${repo.name}] Failed to replay prep-verdict entry ${file}: ${message}`,
      );
      recordSystemError({
        source: "prep-verdict-replay",
        severity: "error",
        repo: repo.name,
        message: `Failed to replay queued prep-verdict ${file}: ${message}`,
        details: { file },
      });
      // Leave the file on disk for the next boot. `IssueParseError`
      // is wedge-territory — the file blocks every boot until a human
      // intervenes — but a stale YAML on disk is itself a corruption
      // signal the operator needs to see, not a boot-time problem to
      // silently delete around. Mirrors the stop-queue policy.
      void IssueParseError; // keep the import live for the type narrow above
      result.failed.push({ file, error: message });
    }
  }

  return result;
}
