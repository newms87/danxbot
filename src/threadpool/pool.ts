/**
 * DX-635 — worker_threads pool for CPU-bound primitives.
 *
 * Parent epic DX-633 (event-loop hardening). Phase 1 (DX-634) yielded the
 * main loop between batched ops; this phase removes the genuinely
 * CPU-bound work — canonical YAML→hash, large JSON.stringify, bulk YAML
 * parse — from the main loop entirely so IO + dispatch + scheduler stay
 * responsive while a 100-card audit pass churns.
 *
 * One singleton, lazily created. Workers retire after 30s idle. Inputs
 * MUST be plain serializable data (`structuredClone` semantics) — code
 * review's first audit pass for this module verifies no shared mutable
 * state crosses the thread boundary.
 *
 * Three task modules live under `tasks/` and are addressed by absolute
 * path at call time. Tests run them in-process via direct import + call
 * (sidesteps the worker_threads spawn).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Piscina from "piscina";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ThreadPoolStats {
  /** Configured pool size (worker count cap). */
  size: number;
  /**
   * Workers currently spawned and warm. Equals 0 until the first task
   * runs (lazy pool); rises toward `size` under load; falls back to 0
   * after the 30s `idleTimeout` retires workers. This is the truthful
   * "live workers" count — not "workers currently executing a task,"
   * which piscina v5 does not expose as a clean integer. `queued > 0`
   * with `active === size` indicates the pool is at capacity.
   */
  active: number;
  /** Tasks queued waiting for a free worker. */
  queued: number;
}

export const DEFAULT_SIZE = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

function resolveSize(): number {
  const raw = process.env.DANXBOT_THREADPOOL_SIZE;
  if (raw === undefined || raw === "") return DEFAULT_SIZE;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SIZE;
}

let pool: Piscina | null = null;

/**
 * Lazy singleton accessor. First call constructs the pool; subsequent
 * calls return it. `destroyPool` resets the singleton so a graceful
 * shutdown followed by a new dispatch (rare — only tests) starts fresh.
 *
 * Workers retire after `idleTimeout` ms idle so a quiescent worker
 * doesn't hold a thread forever. `concurrentTasksPerWorker: 1` is
 * deliberate — these tasks are CPU-bound and piscina would serialize
 * a second task on a busy worker anyway; the explicit value locks the
 * contract against piscina default drift across versions.
 */
export function getPool(): Piscina {
  if (pool === null) {
    pool = new Piscina({
      filename: resolve(__dirname, "tasks/canonical-hash.mjs"),
      minThreads: 0,
      maxThreads: resolveSize(),
      idleTimeout: DEFAULT_IDLE_TIMEOUT_MS,
      concurrentTasksPerWorker: 1,
      // Per-shutdown grace cap. piscina v5 retired the per-call
      // `destroy({timeout})` API in favor of this constructor option +
      // a runtime `close()` call. 5000ms matches the spec'd graceful-
      // shutdown budget. NOTE: piscina's `close({force: true})`
      // immediately rejects QUEUED tasks (with AbortError) and only
      // waits up to `closeTimeout` for in-flight tasks. `destroyPool`
      // uses the two-step drain (close → close({force}) fallback) to
      // give the queue its grace window before force.
      closeTimeout: DEFAULT_CLOSE_TIMEOUT_MS,
      // Task modules are plain `.mjs` so worker_threads load them
      // natively — tsx's ESM loader explicitly skips registration when
      // `isMainThread` is false, so a `.ts` task file inside a worker
      // would throw `ERR_UNKNOWN_FILE_EXTENSION`. See task module
      // headers for the full rationale.
    });
  }
  return pool;
}

export function getThreadPoolStats(): ThreadPoolStats {
  if (pool === null) {
    return { size: resolveSize(), active: 0, queued: 0 };
  }
  return {
    size: pool.options.maxThreads ?? resolveSize(),
    active: pool.threads.length,
    queued: pool.queueSize,
  };
}

/**
 * Run the canonical-hash task in the pool. Input is the parsed YAML
 * object; output is the canonical JSON bytes + sha256 hash. Matches the
 * sync `canonicalize` + `sha256` chain in `src/db/canonicalize.ts` so
 * the writer + watcher dedup contract stays bit-identical.
 */
export function runCanonicalHash(
  value: unknown,
): Promise<{ canonical: string; hash: string }> {
  return getPool().run(
    { value },
    { filename: resolve(__dirname, "tasks/canonical-hash.mjs") },
  );
}

/**
 * Run the JSON.stringify task in the pool. Input is any serializable
 * value; output is the stringified payload. Used (indirectly via
 * `recordError` in `src/system-repair/categorize.ts`) by the audit-
 * error reporting chain in `src/cron/audit-pass.ts` +
 * `src/issue/reconcile.ts`, where the `SystemErrorSamplePayload` can
 * grow large (5-frame stack + raw_msg + caller-supplied context).
 *
 * REJECTS `value === undefined` fail-loud — `JSON.stringify(undefined)`
 * returns the value `undefined` (not the string "undefined"), which
 * would then be passed to pg's jsonb parameter and crash with a type
 * error. Fail-loud at the boundary is the repo's standing principle
 * (`base:fail-loudly` skill) — every audit + recordError caller wraps
 * the payload to a plain object before invoking, so the undefined
 * input has no legitimate path.
 */
export function runJsonStringify(value: unknown): Promise<string> {
  if (value === undefined) {
    return Promise.reject(
      new Error(
        "runJsonStringify: value must be defined — pg jsonb cannot accept undefined. Wrap in {} or use null at the boundary.",
      ),
    );
  }
  return getPool().run(
    { value },
    { filename: resolve(__dirname, "tasks/json-stringify.mjs") },
  );
}

/**
 * Run the YAML batch parse task in the pool. Input is the raw YAML
 * texts; output is the parsed objects (or per-entry parse-error
 * sentinels). Used by `bootScan` so a 100-card cold boot does not
 * starve the event loop on the parse phase.
 */
export function runParseYamlBatch(
  texts: string[],
): Promise<Array<{ ok: true; data: unknown } | { ok: false; error: string }>> {
  return getPool().run(
    { texts },
    { filename: resolve(__dirname, "tasks/parse-yaml-batch.mjs") },
  );
}

/**
 * Graceful shutdown. Two-step drain to honor the spec'd 5s grace
 * window for BOTH queued and in-flight tasks:
 *
 *   1. `close()` (no force) — drains the queue + waits up to
 *      `closeTimeout` for in-flight tasks to complete.
 *   2. If `close()` rejects (timeout exceeded, queue refused to drain),
 *      fall through to `close({force: true})` to force-terminate
 *      remaining workers immediately.
 *
 * Idempotent — calling twice (or before any task ran) is a no-op. The
 * caller never needs to pass a timeout; the grace window is set at
 * pool construction via `closeTimeout: 5000`.
 */
export async function destroyPool(): Promise<void> {
  if (pool === null) return;
  const current = pool;
  pool = null;
  try {
    await current.close();
  } catch {
    // Graceful close timed out — force-terminate remaining workers.
    // The first close() already initiated shutdown; force is the
    // escalation, not a reset. piscina handles the double-close
    // idempotently.
    await current.close({ force: true });
  }
}

/**
 * Test-only — drop the singleton WITHOUT awaiting destroy. If a pool
 * exists at call time, its workers are NOT reaped: callers MUST pair
 * this with `await destroyPool()` (or accept that the next test will
 * spawn a fresh pool while the prior workers retire after their 30s
 * idle timeout). Production code never calls this.
 */
export function _resetPoolForTests(): void {
  pool = null;
}
