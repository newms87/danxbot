/**
 * Worker self-restart orchestration (ISS-71, parent epic ISS-70).
 *
 * Pure orchestration — no HTTP shape. The HTTP route in `server.ts`
 * unwraps the body and forwards to `restartWorker`, then writes the
 * resulting `{ status, body }` to the response.
 *
 * # Design decisions (recorded so the code below makes sense)
 *
 * 1. **Detached finalizer is a separate child process**, not the new
 *    worker itself. The new worker's startup may fail; we still want
 *    the audit row to land with `outcome = "spawn_failed"` or
 *    `"health_timeout"`. The finalizer survives independently because
 *    `spawn(..., { detached: true }).unref()` reparents it to PID 1.
 *
 * 2. **`requesting_dispatch_id` is metadata, not authorization.**
 *    Cross-repo refusal compares `body.repo` against `ctx.name`. A
 *    no-DB-lookup operator-curl with a synthetic dispatch id still
 *    gets through. The audit row records what the caller claimed.
 *
 * 3. **`spawn` and `killSelf` are deps-injected.** Tests must never
 *    fall through to a real `process.kill(process.pid, "SIGTERM")`
 *    or a real fork — both would crash vitest. The deps interface
 *    types both explicitly so a missing mock surfaces as a TS error.
 *
 * 4. **HTTP response is flushed BEFORE SIGTERM.** The route handler
 *    receives `{ status: 202, body, postFlush }`. After `res.end()`,
 *    `setImmediate(postFlush)` fires the kill — guarantees the caller
 *    sees the response even when the worker dies sub-millisecond
 *    after the body lands.
 */

import type { RepoContext } from "../types.js";
import { createLogger } from "../logger.js";
import {
  insertRestart,
  completeRestart,
  getLatestSuccessfulRestart,
  type RestartOutcome,
} from "./worker-restarts-db.js";

const log = createLogger("worker-restart");

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RESERVED_RESPAWN_MS = 5_000;
export const DEFAULT_COOLDOWN_MS = 30_000;

export interface RestartRequest {
  /**
   * The URL path's `:dispatchId` — the dispatch row that requested
   * the restart. Owned by the route layer; `parseRestartRequest`
   * does NOT read it from the body. Required (non-empty) so the
   * audit row always carries a caller identifier.
   */
  requestingDispatchId: string;
  repo: string;
  reason: string;
  drainInFlight?: boolean;
  timeoutMs?: number;
}

export interface RestartDeps {
  /** Spawn the detached finalizer. MUST be mocked in tests. */
  spawnFinalizer: (input: SpawnFinalizerInput) => void;
  /** SIGTERM the current worker. MUST be mocked in tests. */
  killSelf: () => void;
  /** Wallclock — `Date.now()` in production. */
  now: () => number;
  /** Best-effort `lsof -i :<port>` PID lookup. Returns null if unavailable. */
  resolveOldPid: (port: number) => number | null;
  /** "docker" or "host" — injected so tests don't depend on /.dockerenv. */
  runtime: "docker" | "host";
  cooldownMs: number;
}

export interface SpawnFinalizerInput {
  restartId: number;
  repo: string;
  port: number;
  timeoutMs: number;
  reservedRespawnMs: number;
  startedAt: number;
}

export type RestartResponse =
  | RestartRefusedResponse
  | RestartAcceptedResponse;

export interface RestartRefusedResponse {
  accepted: false;
  status: number;
  body: { error: string; outcome: RestartOutcome };
}

export interface RestartAcceptedResponse {
  accepted: true;
  status: 202;
  body: {
    started: true;
    oldPid: number | null;
    restartId: number;
    outcome: "started";
  };
  /**
   * Caller invokes this AFTER `res.end()` to fire SIGTERM. Wrapping
   * the kill in a callback (instead of running it inline here) is
   * what guarantees the response body reaches the wire before the
   * process dies.
   */
  postFlush: () => void;
}

/**
 * In-memory cooldown map. Per-process state — the worker_restarts
 * table reseeds it on cold boot via `seedCooldownFromDb`.
 */
const cooldownMap = new Map<string, number>();

export function _resetCooldownForTests(): void {
  cooldownMap.clear();
}

export function getCooldown(repo: string): number | null {
  return cooldownMap.get(repo) ?? null;
}

export function setCooldown(repo: string, at: number): void {
  cooldownMap.set(repo, at);
}

/**
 * Worker boot hook — pulls the latest successful restart timestamp
 * for this repo from `worker_restarts` so a restart-then-restart-again
 * attack across a worker boundary still hits the cooldown.
 */
export async function seedCooldownFromDb(repo: string): Promise<void> {
  const latest = await getLatestSuccessfulRestart(repo);
  if (latest && latest.completed_at) {
    cooldownMap.set(repo, new Date(latest.completed_at).getTime());
    log.info(
      `Seeded cooldown for "${repo}" from worker_restarts: ${latest.completed_at}`,
    );
  }
}

/**
 * Pure-input validation. Returns the trimmed string or null.
 */
function requireNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parse the body of a restart request. The route layer owns the
 * `requestingDispatchId` (it comes from the URL path) and is
 * responsible for injecting it into the returned value before passing
 * it to `restartWorker`. Keeping it out of the body parser prevents a
 * silent empty-string fallback and reflects the actual contract.
 */
export function parseRestartRequest(
  raw: Record<string, unknown>,
):
  | { ok: true; value: Omit<RestartRequest, "requestingDispatchId"> }
  | { ok: false; status: number; error: string } {
  const repo = requireNonEmptyString(raw.repo);
  if (!repo) {
    return {
      ok: false,
      status: 400,
      error: "Missing or empty required field: repo",
    };
  }
  const reason = requireNonEmptyString(raw.reason);
  if (!reason) {
    return {
      ok: false,
      status: 400,
      error: "Missing or empty required field: reason",
    };
  }
  const drainInFlight = raw.drainInFlight === true;
  const timeoutMs =
    typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
      ? raw.timeoutMs
      : undefined;
  return {
    ok: true,
    value: {
      repo,
      reason,
      drainInFlight,
      timeoutMs,
    },
  };
}

/**
 * Run the full guard pipeline + audit-row write + spawn. Returns
 * either a refusal response (caller writes status + body and
 * returns) or an accepted response with `postFlush` the caller MUST
 * invoke after `res.end()`.
 */
export async function restartWorker(
  request: RestartRequest,
  ctx: RepoContext,
  deps: RestartDeps,
): Promise<RestartResponse> {
  const startedAt = deps.now();

  // Guard 3: cross-repo
  if (request.repo !== ctx.name) {
    await writeAudit({
      request,
      outcome: "cross_repo",
      oldPid: null,
      startedAt,
    });
    return {
      accepted: false,
      status: 403,
      body: {
        error: `Cross-repo restart refused — this worker serves "${ctx.name}", not "${request.repo}"`,
        outcome: "cross_repo",
      },
    };
  }

  // Guard 4: docker self-restart
  if (deps.runtime === "docker") {
    await writeAudit({
      request,
      outcome: "docker_self",
      oldPid: null,
      startedAt,
    });
    return {
      accepted: false,
      status: 409,
      body: {
        error:
          "Docker-mode self-restart is unsupported — restart the container instead",
        outcome: "docker_self",
      },
    };
  }

  // Guard 5: cooldown
  const lastAt = cooldownMap.get(ctx.name);
  if (lastAt !== undefined && startedAt - lastAt < deps.cooldownMs) {
    const waitMs = deps.cooldownMs - (startedAt - lastAt);
    await writeAudit({
      request,
      outcome: "cooldown",
      oldPid: null,
      startedAt,
    });
    return {
      accepted: false,
      status: 429,
      body: {
        error: `Restart on cooldown — try again in ${Math.ceil(waitMs / 1000)}s`,
        outcome: "cooldown",
      },
    };
  }

  // Guard 6: best-effort PID sanity
  const oldPid = deps.resolveOldPid(ctx.workerPort);

  // Audit: mark started
  const restartId = await writeAudit({
    request,
    outcome: "started",
    oldPid,
    startedAt,
  });

  // Cooldown stamp: mark NOW so a fast retry within deps.cooldownMs is
  // refused even if the new worker hasn't booted yet. NOTE the asymmetry
  // with `seedCooldownFromDb`: this in-process map uses the start-time,
  // but `seedCooldownFromDb` reads `completed_at` from the latest
  // `success` row. A health_timeout finalizer never updates the row's
  // `completed_at` (well, it does — to the timeout instant — but with
  // outcome='health_timeout', and the seed query filters to
  // outcome='success'). Result: a failed restart leaves NO durable
  // cooldown across worker boots, only this in-process stamp until the
  // worker dies. That's intentional — a failed restart is not a
  // "we just restarted, slow down" signal; it's a "try again".
  cooldownMap.set(ctx.name, startedAt);

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    deps.spawnFinalizer({
      restartId,
      repo: ctx.name,
      port: ctx.workerPort,
      timeoutMs,
      reservedRespawnMs: DEFAULT_RESERVED_RESPAWN_MS,
      startedAt,
    });
  } catch (err) {
    log.error("spawnFinalizer failed", err);
    // Honest audit: stamp the row from "started" → "spawn_failed" so
    // a query for stuck-but-actually-failed restarts doesn't have to
    // pattern-match on null `completed_at`. Best-effort — if the
    // completion update itself throws, log and continue (the started
    // row at least exists).
    const completedAt = deps.now();
    await completeRestart({
      id: restartId,
      outcome: "spawn_failed",
      newPid: null,
      completedAt,
    }).catch((failErr) => {
      log.error("failed to mark restart row as spawn_failed", failErr);
    });
    return {
      accepted: false,
      status: 500,
      body: {
        error: `Failed to spawn restart finalizer: ${
          err instanceof Error ? err.message : String(err)
        }`,
        outcome: "spawn_failed",
      },
    };
  }

  return {
    accepted: true,
    status: 202,
    body: {
      started: true,
      oldPid,
      restartId,
      outcome: "started",
    },
    postFlush: () => {
      try {
        deps.killSelf();
      } catch (err) {
        log.error("killSelf failed", err);
      }
    },
  };
}

async function writeAudit(input: {
  request: RestartRequest;
  outcome: RestartOutcome;
  oldPid: number | null;
  startedAt: number;
}): Promise<number> {
  return insertRestart({
    requestingDispatchId: input.request.requestingDispatchId,
    repo: input.request.repo,
    reason: input.request.reason,
    outcome: input.outcome,
    oldPid: input.oldPid,
    startedAt: input.startedAt,
  });
}

/**
 * Health-poll helper used by the detached finalizer. Returns true if
 * `/health` returned 200 within the deadline. Pure function with
 * deps-injected fetch + sleep so unit tests don't actually wait.
 */
export interface PollHealthDeps {
  fetch: (url: string) => Promise<{ ok: boolean; status: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export async function pollHealth(
  port: number,
  deadlineMs: number,
  deps: PollHealthDeps,
  intervalMs: number = 1_000,
): Promise<boolean> {
  const url = `http://localhost:${port}/health`;
  while (deps.now() < deadlineMs) {
    try {
      const res = await deps.fetch(url);
      if (res.ok) return true;
    } catch (err) {
      // ECONNREFUSED is expected while the new worker is still booting;
      // anything else (DNS, TLS, unexpected throw) is logged at debug
      // so it's visible without aborting the loop.
      log.debug(
        `pollHealth fetch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (deps.now() >= deadlineMs) return false;
    await deps.sleep(intervalMs);
  }
  return false;
}
