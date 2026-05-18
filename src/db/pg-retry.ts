/**
 * Transient-pg-error classifier + retry-with-backoff helper for the
 * issues-mirror hot path.
 *
 * Background: a stale idle client checked out of `pg.Pool` after the
 * Postgres side has closed the socket throws "Connection terminated due
 * to connection timeout" — a transient runtime error, not a data /
 * schema error. Pre-DX-616 the issues-mirror treated EVERY pg failure
 * (transient OR fatal) the same way: write `CRITICAL_FAILURE` + halt the
 * worker's cron + bubble out. A single 5-second TCP hiccup parked the
 * poller until a human cleared the flag.
 *
 * Contract:
 *   - `isTransientPgError(err)` returns true for the connection /
 *     timeout / admin-shutdown error classes that should be silently
 *     retried.
 *   - `retryTransient(fn, opts)` runs `fn`, retrying on transient errors
 *     with exponential backoff + jitter until either (a) the call
 *     succeeds, (b) a non-transient error is thrown (rethrown
 *     immediately), or (c) the cumulative `budgetMs` elapses (rethrows
 *     the last transient error so the caller's fatal-path runs as a
 *     safety net for a genuine multi-minute outage).
 *
 * The mirror's `reportFailure` path remains exactly as it was — every
 * call still ends in `writeFlag` if the error escapes. The wrapper just
 * keeps a normal network blip from escaping in the first place.
 */

const DEFAULT_BUDGET_MS = 5 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 30_000;

// Postgres SQLSTATE codes for transient connection / shutdown failures.
// 08xxx = connection exception family; 57P0x = operator-intervention
// family (admin shutdown, crash shutdown, cannot connect now).
const TRANSIENT_PG_SQLSTATES = new Set<string>([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

// Node-level transient socket / OS errors.
const TRANSIENT_NODE_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

// pg-pool throws plain `Error` (no `code`) with this exact message when
// an idle client's underlying socket has gone away before checkout.
const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
  /Connection terminated/i,
  /Connection terminated due to connection timeout/i,
  /Client has encountered a connection error/i,
  /timeout exceeded when trying to connect/i,
  /the database system is starting up/i,
  /the database system is shutting down/i,
  /terminating connection due to administrator command/i,
];

export function isTransientPgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_NODE_CODES.has(code)) return true;
    if (TRANSIENT_PG_SQLSTATES.has(code)) return true;
  }
  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(err.message)) return true;
  }
  return false;
}

export interface RetryOpts {
  /** Cumulative ceiling. Beyond this, the last transient error rethrows. */
  budgetMs?: number;
  /** First sleep duration on retry #1, before jitter. */
  initialDelayMs?: number;
  /** Sleep ceiling — exponential growth caps here. */
  maxDelayMs?: number;
  /** Callback per retry — used by the mirror to log a warn line. */
  onRetry?: (err: Error, attempt: number, delayMs: number) => void;
  /** Overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests. */
  now?: () => number;
}

export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const initial = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  const start = now();
  let delay = initial;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientPgError(err)) throw err;
      const elapsed = now() - start;
      if (elapsed >= budget) throw err;
      attempt += 1;
      const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
      const wait = Math.min(Math.max(1, Math.round(delay * jitter)), cap);
      opts.onRetry?.(err as Error, attempt, wait);
      await sleep(wait);
      delay = Math.min(delay * 2, cap);
    }
  }
}
