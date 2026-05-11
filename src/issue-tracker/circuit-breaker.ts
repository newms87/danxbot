/**
 * Process-wide Trello circuit breaker (DX-300).
 *
 * One module-singleton cluster of state gates every Trello-bound HTTP
 * call. When Trello returns 429, the breaker trips to `open` for an
 * initial cooldown; every subsequent Trello-bound call short-circuits
 * with `TrelloCircuitOpen` so 20 concurrent callers don't all hammer
 * the API and extend the rate-limit window.
 *
 * State machine:
 *
 *   closed       — default; calls pass through.
 *   open(until)  — every call short-circuits until `until` wall-time.
 *   half-open    — first call after `until` passes through as a probe.
 *                  Success → closed, cooldown reset.
 *                  429    → open with doubled cooldown (cap 15min).
 *
 * Cooldown schedule on consecutive 429s: 60s → 120s → 240s → 480s →
 * 900s (cap) → 900s → ... Reset to 60s on first successful probe.
 *
 * The breaker is process-singleton — a single 429 from ANY caller
 * (retry-queue, per-tick mirror, reconcile, auto-sync, dashboard
 * proxy reads) pauses every caller until cooldown elapses. By
 * design: there is only one Trello API and the rate limit is a
 * per-token (i.e. per-process for danxbot's single-API-key
 * deployment) bucket, so a per-caller breaker would still see
 * 429s after the first caller tripped.
 *
 * Why not per-board / per-tracker-instance? The retry-queue's
 * `setRetryQueueTrackerForRepo` already keys by repoName, but the
 * underlying Trello rate-limit bucket is at the API-key level, not
 * the board level. Future multi-key deploys can re-key this state
 * by `apiKey` if needed; today the singleton matches reality.
 *
 * Why not subclass-of-Error sniffing instead of regex on the error
 * message? `TrelloTracker.requestJson` builds the error message
 * inline as `Trello API error: ${status} ${statusText} (${endpoint})`.
 * Introducing a typed `TrelloApiError` class for this one consumer
 * would force every other downstream consumer of that error to learn
 * the new shape — the regex is the smallest surface area for the
 * single signal we care about. See {@link is429}.
 */

/**
 * Constant prefix of the message `TrelloCircuitOpen` carries. Exported
 * so callers that fall through `attemptPush` (where the typed class
 * was already serialized to a `string`) can recognize the deferral
 * signal by stringly comparison without re-encoding the prefix at
 * each callsite — see `retry-queue.ts#isCircuitOpenMessage` and the
 * constructor below. Renaming this string is a breaking change.
 */
export const CIRCUIT_OPEN_MESSAGE_PREFIX = "Trello circuit open until ";

/**
 * Thrown by Trello client wrappers when the circuit is open. Callers
 * (retry-queue, reconcile/pushTrelloDiff) catch this distinctly from
 * "real" tracker errors so they can defer without bumping per-card
 * attempt counters or surfacing to the operator as a permanent failure.
 */
export class TrelloCircuitOpen extends Error {
  override readonly name = "TrelloCircuitOpen";
  constructor(public readonly retryAtMs: number) {
    super(`${CIRCUIT_OPEN_MESSAGE_PREFIX}${new Date(retryAtMs).toISOString()}`);
  }
}

export type CircuitState = "closed" | "open" | "half-open";

/** First open cooldown. Doubles on each subsequent 429 during half-open. */
export const INITIAL_COOLDOWN_MS = 60 * 1000;

/** Hard cap on the doubling. Prevents a sustained outage from arming a multi-hour open window. */
export const MAX_COOLDOWN_MS = 15 * 60 * 1000;

interface InternalState {
  state: CircuitState;
  openUntilMs: number;
  cooldownMs: number;
}

function freshState(): InternalState {
  return {
    state: "closed",
    openUntilMs: 0,
    cooldownMs: INITIAL_COOLDOWN_MS,
  };
}

const state: InternalState = freshState();

interface CircuitLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

// Default logger is a no-op so that test code which forgets to inject
// doesn't spam stdout. Production wires `setCircuitLogger` once at
// boot from `src/index.ts` (next to the retry-queue registration).
let log: CircuitLogger = { info: () => undefined, warn: () => undefined };
export function setCircuitLogger(l: CircuitLogger): void {
  log = l;
}

let nowProvider: () => number = () => Date.now();

/** Test seam — swap the wall-clock source. */
export function _setNowForTesting(f: () => number): void {
  nowProvider = f;
}

/**
 * Drive the open → half-open transition lazily. The breaker has no
 * timer of its own; the transition fires on whichever call observes
 * `now >= openUntilMs` first. This keeps the module side-effect-free
 * (no setTimeout to clean up at shutdown) and matches the contract
 * the spec describes: half-open is a STATE, not an EVENT.
 */
function transitionToHalfOpenIfDue(): void {
  if (state.state === "open" && nowProvider() >= state.openUntilMs) {
    state.state = "half-open";
  }
}

/**
 * `true` ⇒ callers MUST NOT issue the Trello request. Throw
 * `TrelloCircuitOpen` instead.
 *
 * Side-effect: drives the open → half-open transition on demand so
 * callers see a fresh state without paying for a timer.
 */
export function isOpen(): boolean {
  transitionToHalfOpenIfDue();
  return state.state === "open";
}

export function openUntilMs(): number {
  // Drive the lazy transition here too so a caller that reads this
  // value WITHOUT first calling `isOpen()` (today there are none, but
  // future callers shouldn't have to learn the call-order rule)
  // observes a fresh open-vs-half-open state.
  transitionToHalfOpenIfDue();
  return state.openUntilMs;
}

export function getState(): CircuitState {
  transitionToHalfOpenIfDue();
  return state.state;
}

/**
 * Called by Trello client wrappers AFTER every successful HTTP
 * response (2xx). In half-open this closes the circuit and resets
 * the doubling counter; in closed it's a no-op; in open it
 * shouldn't happen (the wrapper short-circuited before calling
 * fetch), but guards against re-entry just in case.
 */
export function recordSuccess(): void {
  transitionToHalfOpenIfDue();
  if (state.state === "half-open") {
    state.state = "closed";
    state.cooldownMs = INITIAL_COOLDOWN_MS;
    state.openUntilMs = 0;
    log.info("TrelloCircuit: closed (recovered, cooldown reset)");
  }
  // closed: no log, no state change (the common case — every
  //   successful call would otherwise log).
  // open: silently ignore (we shouldn't have issued the call).
}

/**
 * Called by Trello client wrappers AFTER every failed HTTP response.
 * Only 429s trip / extend the breaker. Other failures (5xx, 4xx,
 * network) feed through to the caller's normal error path without
 * gating other concurrent callers.
 *
 * Why endpoint? Logs are the operator's primary diagnostic; the
 * endpoint + status string in the log line is the breadcrumb that
 * tells them which kind of call exhausted the rate limit. Without
 * it the log just says "429" and the operator has to grep upstream.
 */
export function recordFailure(
  err: Error,
  opts?: { endpoint?: string },
): void {
  if (!is429(err)) return;
  transitionToHalfOpenIfDue();
  if (state.state === "open") {
    // Already open. Additional 429s arrive while concurrent callers
    // race to the wrapper; the FIRST 429 set the cooldown, the rest
    // are noise. (Without this guard the cooldown would grow
    // unboundedly within a single tick.)
    //
    // Concurrency model: this function is synchronous (no `await`),
    // and Node's single-threaded event loop serializes concurrent
    // `await fetch` callbacks at their `.then` boundaries. So two
    // in-flight callers landing 429s race to `recordFailure` but
    // execute it back-to-back without interleaving — the first
    // transitions to `open`, the second sees `state === "open"`
    // and bails. Reintroducing any `await` here would break this
    // assumption; keep the function strictly synchronous.
    return;
  }
  // Half-open + 429 → double; closed + 429 → start at INITIAL.
  const nextCooldownMs =
    state.state === "half-open"
      ? Math.min(state.cooldownMs * 2, MAX_COOLDOWN_MS)
      : INITIAL_COOLDOWN_MS;
  state.cooldownMs = nextCooldownMs;
  state.openUntilMs = nowProvider() + nextCooldownMs;
  state.state = "open";
  log.warn(
    `TrelloCircuit: opened (cooldown ${Math.round(nextCooldownMs / 1000)}s; trigger=429${
      opts?.endpoint ? ` on ${opts.endpoint}` : ""
    })`,
  );
}

/**
 * Matches the message shape `TrelloTracker.requestJson/requestVoid`
 * builds for a non-ok HTTP response:
 *
 *   `Trello API error: 429 Too Many Requests (GET /cards/abc)`
 *
 * Anchored on the literal `429 ` (space-separated) so that the
 * digit is not a prefix of e.g. `4290`. The regex is checked once
 * per failure, so the cost is negligible.
 */
export function is429(err: Error): boolean {
  return /Trello API error: 429\b/.test(err.message);
}

/**
 * Visible for tests + clean shutdown. Cancels nothing (no timers to
 * cancel — see `transitionToHalfOpenIfDue`) but resets state to
 * closed and unsets the now-provider seam.
 */
export function _resetForTesting(): void {
  Object.assign(state, freshState());
  nowProvider = () => Date.now();
  log = { info: () => undefined, warn: () => undefined };
}
