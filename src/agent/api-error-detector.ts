/**
 * ApiErrorDetector (DX-259 / Phase 1 of DX-246).
 *
 * Subscribes to a SessionLogWatcher-like entry stream and fires a
 * caller-provided `onApiError` handler when Claude Code emits the synthetic
 * JSONL pair indicating the Anthropic API stream timed out mid-turn. Phase 2
 * wires the launcher's recover handler to `onApiError`; Phase 1 ships the
 * pure detector + unit tests.
 *
 * Observed signature (DX-235, 2026-05-10):
 *
 *   {
 *     "type": "assistant",
 *     "message": {"model": "<synthetic>", "stop_reason": "stop_sequence",
 *                 "content": [{"type": "text",
 *                              "text": "API Error: Stream idle timeout - partial response received"}]},
 *     "isApiErrorMessage": true,
 *     "error": "unknown"
 *   }
 *   {"type": "system", "subtype": "turn_duration", "durationMs": 1457211}
 *
 * The detector triggers on EITHER:
 *
 *   1. `raw.isApiErrorMessage === true`, OR
 *   2. `raw.message?.model === "<synthetic>"` AND content text matches /API Error/i
 *
 * Both forms are observed in practice; defense-in-depth catches whichever
 * surface Claude Code emits in the future.
 *
 * 5s confirmation window — on first match, the detector arms a 5s timer
 * instead of firing immediately. If a real assistant entry (model !==
 * "<synthetic>", no isApiErrorMessage flag) arrives during the window, the
 * API recovered on its own and the recover is cancelled. Otherwise the
 * handler fires after the window elapses. This protects against transient
 * Anthropic API stutter that resolves without operator intervention.
 *
 * Idempotency — once the handler fires, the detector remembers which
 * `recoverCount` epoch it fired at. Further synthetic entries in the same
 * epoch are no-ops. When the caller (Phase 2's launcher) bumps
 * `recoverCount` after invoking the recover handler, the next synthetic
 * entry re-arms the detector for the new epoch.
 *
 * Sub-agent (sidechain) entries are skipped — a sub-agent's API error must
 * not trigger a recover on the parent dispatch. The sub-agent stream is
 * decorated with `isSidechain: true` by Claude Code; the detector reads
 * the flag from `entry.data.raw`.
 */

import type { AgentLogEntry } from "../types.js";

export type EntryConsumer = (entry: AgentLogEntry) => void;

/**
 * Minimal interface the detector needs from a watcher. The production
 * `SessionLogWatcher` (`src/agent/session-log-watcher.ts`) implements this;
 * test doubles only need to invoke `consumer(entry)` for each entry they
 * want to forward. Decoupling the detector from the concrete watcher class
 * keeps the unit tests fast (no polling, no filesystem) and the production
 * wiring trivial.
 */
export interface WatcherLike {
  onEntry(consumer: EntryConsumer): void;
}

/**
 * DX-322 — discriminator on `ApiErrorInfo`. The handler in
 * `attach-monitoring-stack.ts` routes on this BEFORE incrementing the
 * recover counter:
 *
 *   - `"stream_idle"`: legacy Anthropic stream-idle synthetic; the
 *     recover loop bumps `recoverCount` and POSTs `/api/resume`.
 *   - `"rate_limit"`: account-wide Anthropic rate-limit ("You've hit
 *     your limit · resets …"). The recover loop is GUARANTEED to waste
 *     tokens — none of the retries land until the reset deadline — so
 *     the handler skips the loop entirely and writes a *throttle* flag
 *     with `resume_at` instead. Poller auto-clears the flag past
 *     `resume_at`, no operator round-trip.
 *
 * When the detector matches the rate-limit pattern but cannot parse a
 * usable `resume_at` from the error text (unknown wording, malformed
 * tz, time more than 24h out), it falls back to `"stream_idle"` so the
 * legacy recover path still runs — the original safety net stays
 * intact. The detector logs the unparsed string at WARN so an operator
 * sees the regression on the next dashboard tick.
 */
export type ApiErrorKind = "stream_idle" | "rate_limit";

export interface ApiErrorInfo {
  jobId: string;
  errorText: string;
  recoverCount: number;
  kind: ApiErrorKind;
  /**
   * Absolute UTC ISO timestamp at which the Anthropic limit resets,
   * present ONLY when `kind === "rate_limit"`. Past `resume_at` the
   * worker's poller auto-clears the throttle flag and resumes
   * dispatch.
   *
   * Clamped to `now + 24h` defensively — anything beyond is operator
   * territory (see `parseRateLimitResume`), and the detector falls
   * back to `kind: "stream_idle"` rather than stamp a year-out
   * `resume_at` that would make the throttle flag look like a
   * permanent halt.
   */
  resume_at?: string;
}

export interface ApiErrorDetectorOptions {
  jobId: string;
  watcher: WatcherLike;
  /** Reads the live recoverCount from the caller-owned counter (Phase 2). */
  getRecoverCount: () => number;
  /** Phase 2's recover handler — kills + resumes the dispatch chain. */
  onApiError: (info: ApiErrorInfo) => void;
  /** Confirmation window length in ms. Default 5000 — exposed for tests. */
  confirmationWindowMs?: number;
}

const DEFAULT_CONFIRMATION_WINDOW_MS = 5_000;
const SYNTHETIC_MODEL = "<synthetic>";
const API_ERROR_PATTERN = /API Error/i;

/**
 * DX-322 — defensive ceiling for parsed `resume_at`. Anything beyond is
 * either a parser regression (12-hour wrap miscalc, century roll, etc.)
 * or a genuinely long limit window that operators want to know about,
 * not silently park on. The detector falls back to `"stream_idle"` so
 * the legacy recover loop + CRITICAL_FAILURE flag fires instead — a
 * year-long throttle flag would otherwise look like a permanent halt
 * to the dashboard.
 */
const MAX_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * DX-322 — rate-limit synthetic patterns. Anthropic surfaces the limit
 * in multiple forms; defense-in-depth catches all of them so a future
 * wording change doesn't silently fall through to the legacy stream-
 * idle loop (which burns the recover-cap on every retry while the
 * limit holds).
 *
 *   - `RATE_LIMIT_PATTERN`: matches the error text as a whole. Catches
 *     `hit your limit`, `rate_limit`, `rate limit`, and bare `429`.
 *   - `RESET_TIME_PATTERN`: extracts `(hh):(mm)(am|pm) ((tz))`. The tz
 *     is an IANA name (`America/Montevideo`, `UTC`, etc.) — bare
 *     offsets like `-03:00` are NOT supported here; the parser falls
 *     back to legacy stream-idle when the tz cannot be looked up via
 *     `Intl.DateTimeFormat`.
 */
const RATE_LIMIT_PATTERN = /(hit your limit|rate[_ -]?limit|\b429\b)/i;
const RESET_TIME_PATTERN =
  /\bresets?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC)\)/i;

interface PendingRecover {
  timer: ReturnType<typeof setTimeout>;
  recoverCount: number;
  errorText: string;
  kind: ApiErrorKind;
  resumeAt?: string;
}

export class ApiErrorDetector {
  private readonly jobId: string;
  private readonly getRecoverCount: () => number;
  private readonly onApiError: (info: ApiErrorInfo) => void;
  private readonly confirmationWindowMs: number;
  /** Highest recoverCount epoch at which a fire has occurred. -1 = never. */
  private firedAtEpoch = -1;
  private pending: PendingRecover | null = null;
  private stopped = false;

  constructor(options: ApiErrorDetectorOptions) {
    this.jobId = options.jobId;
    this.getRecoverCount = options.getRecoverCount;
    this.onApiError = options.onApiError;
    this.confirmationWindowMs =
      options.confirmationWindowMs ?? DEFAULT_CONFIRMATION_WINDOW_MS;
    // Reject 0, negatives, and NaN at the gate. A 0 window would fire
    // onApiError on the next macrotask (no confirmation), defeating the
    // design; NaN from a malformed env-parse would surface as instant
    // fire too. The `> 0` check catches all three cases in one expression.
    if (!(this.confirmationWindowMs > 0)) {
      throw new Error(
        `ApiErrorDetector: confirmationWindowMs must be > 0 (got ${options.confirmationWindowMs})`,
      );
    }
    // Subscribe exactly once. The watcher's consumer list is append-only;
    // we deregister via the stopped flag rather than splice (the watcher
    // exposes no unsubscribe path today — see SessionLogWatcher).
    options.watcher.onEntry((entry) => this.handleEntry(entry));
  }

  /** Stop processing new entries and cancel any pending confirmation timer. */
  stop(): void {
    this.stopped = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }

  private handleEntry(entry: AgentLogEntry): void {
    if (this.stopped) return;
    if (entry.type !== "assistant") return;

    const data = entry.data as Record<string, unknown> | undefined;
    const raw = (data?.raw as Record<string, unknown> | undefined) ?? {};

    // Sub-agent streams are decorated with `isSidechain: true` by Claude
    // Code. Their failures stay scoped to the sub-agent — the parent
    // dispatch continues. Filter BEFORE running the synthetic-detect
    // logic so a sidechain synthetic error never even arms the timer.
    if (raw.isSidechain === true) return;

    const isSynthetic = matchesSynthetic(raw);

    if (isSynthetic) {
      const errorText = extractErrorText(raw);
      // DX-322 — classify the synthetic. Rate-limit pattern → try to
      // parse `resume_at`. Unparseable rate-limit string falls back to
      // `"stream_idle"` so the legacy recover loop + CRITICAL_FAILURE
      // path stays the safety net (never silently swallow). Stream-
      // idle synthetics carry no `resume_at`.
      const classified = classifyApiError(errorText, Date.now());
      this.armOrIgnore(errorText, classified.kind, classified.resumeAt);
      return;
    }

    // Real assistant entry. If a confirmation window is in flight, the
    // API recovered on its own — cancel the pending recover.
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }

  /**
   * Arm the 5s confirmation timer for a freshly-observed synthetic entry,
   * subject to epoch idempotency. If we've already fired at the current
   * epoch the call is a no-op. If a timer is already armed (a duplicate
   * synthetic within the window) we let the original timer run — re-
   * arming would let a flapping API push the recover indefinitely.
   *
   * DX-322 — `kind` + `resumeAt` ride along on the pending record so
   * `onApiError` receives the same classification the entry produced.
   * Re-arm semantics deliberately ignore later entries (rate-limit
   * after a stream-idle stays stream-idle for this window); the next
   * epoch can re-classify when the recover handler bumps the counter.
   */
  private armOrIgnore(
    errorText: string,
    kind: ApiErrorKind,
    resumeAt?: string,
  ): void {
    const currentEpoch = this.getRecoverCount();
    if (this.firedAtEpoch >= currentEpoch) return; // already fired this epoch
    if (this.pending) return; // timer already armed; do not re-arm

    const timer = setTimeout(() => {
      // Defensive re-check. stop() between arm + fire would have cleared
      // this.pending; the explicit guards cost nothing and protect
      // against future refactors that delay clearing.
      if (this.stopped) return;
      const info = this.pending;
      this.pending = null;
      if (!info) return;
      // Use the ARM-time epoch — the timer fires for the epoch it was
      // armed at, regardless of any external counter bump that arrived
      // between arm and fire. Phase 2's launcher always bumps recoverCount
      // strictly AFTER onApiError returns, so this branch is the
      // contractual one. Idempotency uses the same value so a subsequent
      // synthetic in the new epoch is correctly recognized as needing a
      // fresh fire.
      if (this.firedAtEpoch >= info.recoverCount) return;
      this.firedAtEpoch = info.recoverCount;
      const fired: ApiErrorInfo = {
        jobId: this.jobId,
        errorText: info.errorText,
        recoverCount: info.recoverCount,
        kind: info.kind,
      };
      if (info.resumeAt) fired.resume_at = info.resumeAt;
      this.onApiError(fired);
    }, this.confirmationWindowMs);

    this.pending = {
      timer,
      recoverCount: currentEpoch,
      errorText,
      kind,
      resumeAt,
    };
  }
}

/**
 * DX-322 — classify a synthetic error's text. Pure function so unit
 * tests can pin both arms without spinning up the detector. `nowMs` is
 * threaded through (not read from `Date.now()` inside) so tests can
 * pass a fixed time and assert deterministic `resume_at` values.
 *
 *   - Matches `RATE_LIMIT_PATTERN` → tries `parseRateLimitResume`. A
 *     successful parse returns `{kind: "rate_limit", resumeAt}`. A
 *     failed parse logs the original text at warn-level (for operator
 *     visibility) and falls back to `{kind: "stream_idle"}` so the
 *     legacy recover loop still runs.
 *   - No rate-limit signal → `{kind: "stream_idle"}` unchanged.
 *
 * Exported for the unit tests in `api-error-detector.test.ts`. Not
 * re-exported from the package root — internal seam.
 */
export function classifyApiError(
  errorText: string,
  nowMs: number,
): { kind: ApiErrorKind; resumeAt?: string } {
  if (!RATE_LIMIT_PATTERN.test(errorText)) {
    return { kind: "stream_idle" };
  }
  const resumeAt = parseRateLimitResume(errorText, nowMs);
  if (resumeAt) {
    return { kind: "rate_limit", resumeAt };
  }
  // Logging via console.warn rather than the package logger to keep the
  // detector module dependency-light (the launcher's createLogger is
  // module-scoped above and depends on config; importing it here would
  // pull the config chain into the pure function's transitive imports).
  // The launcher's recover handler logs the same text again with the
  // full job context, so this WARN is purely an operator-visible
  // breadcrumb for "rate-limit shape changed and we're back on the
  // legacy recover loop."
  // eslint-disable-next-line no-console
  console.warn(
    `[api-error-detector] rate-limit pattern matched but reset-time unparseable; falling back to stream_idle. errorText: ${errorText}`,
  );
  return { kind: "stream_idle" };
}

/**
 * DX-322 — parse `resets H:MM(am|pm) (IANA/TZ)` out of the error text
 * into an absolute UTC ISO `resume_at`. Returns `undefined` when:
 *
 *   - The pattern doesn't match.
 *   - The named IANA tz is unknown to `Intl.DateTimeFormat`.
 *   - The hour/minute is out of range.
 *   - The computed `resume_at` is more than 24h in the future
 *     (`MAX_RATE_LIMIT_WINDOW_MS`) — defensively rejected per spec.
 *
 * DST-correctness: the offset between the named tz's wall clock and
 * UTC is computed via `Intl.DateTimeFormat.formatToParts` against the
 * live `nowMs`. Hand-rolling offset math would miss Montevideo's 2026
 * DST transition (and every future DST tz change); this delegates to
 * the V8/ICU TZ database that ships with Node.
 *
 * 12-hour wrap: if the parsed wall-clock is BEFORE `nowMs` in the
 * named tz, the reset is assumed to be tomorrow (the limit window
 * crossed midnight). If even tomorrow exceeds the 24h cap, the parse
 * fails fast.
 */
export function parseRateLimitResume(
  errorText: string,
  nowMs: number,
): string | undefined {
  const match = errorText.match(RESET_TIME_PATTERN);
  if (!match) return undefined;
  const hour12 = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = match[3].toLowerCase();
  const tz = match[4];

  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return undefined;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return undefined;

  const hour24 =
    meridiem === "am"
      ? hour12 === 12
        ? 0
        : hour12
      : hour12 === 12
        ? 12
        : hour12 + 12;

  let tzWallParts: TzWallParts;
  try {
    tzWallParts = formatTzWallParts(new Date(nowMs), tz);
  } catch {
    // `Intl.DateTimeFormat` throws `RangeError` on an unknown timeZone.
    // Caller falls back to stream_idle.
    return undefined;
  }

  // Step 1 — guess: assume the reset is today in the named tz. Compute
  // the UTC instant whose wall-clock representation in `tz` is
  // `today @ hour24:minute:00`.
  let candidateUtcMs = wallClockToUtc(
    tzWallParts.year,
    tzWallParts.month,
    tzWallParts.day,
    hour24,
    minute,
    tz,
  );
  if (candidateUtcMs === undefined) return undefined;

  // Step 2 — if the reset is already in the past for this tz date, it
  // must mean the limit window crosses midnight. Bump to tomorrow in
  // the named tz and re-resolve to UTC. (Naive `+24h` would miss DST
  // transitions where today and tomorrow differ by 23h or 25h; we go
  // back through the wall-clock conversion so the live offset is read
  // for the rolled-over date.)
  if (candidateUtcMs <= nowMs) {
    const tomorrowMs = candidateUtcMs + 24 * 60 * 60 * 1_000;
    const tomorrowParts = formatTzWallParts(new Date(tomorrowMs), tz);
    candidateUtcMs = wallClockToUtc(
      tomorrowParts.year,
      tomorrowParts.month,
      tomorrowParts.day,
      hour24,
      minute,
      tz,
    );
    if (candidateUtcMs === undefined) return undefined;
  }

  // Defensive 24h cap — anything farther is operator territory per
  // spec (`Reset-time parser invariants`).
  if (candidateUtcMs - nowMs > MAX_RATE_LIMIT_WINDOW_MS) return undefined;
  // Also defensively reject anything still in the past — should be
  // unreachable after the tomorrow-bump, but a malformed tz could in
  // theory return a wall clock that places the reset in the past
  // again (e.g. a 23h DST spring-forward where +24h still lands
  // before `now`). Fail closed to legacy stream-idle in that case.
  if (candidateUtcMs <= nowMs) return undefined;

  return new Date(candidateUtcMs).toISOString();
}

interface TzWallParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

function formatTzWallParts(date: Date, tz: string): TzWallParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  // `hour: "2-digit"` with `hourCycle: "h23"` produces "00".."23" but
  // older Node/ICU bundles have been observed to emit "24" for the
  // midnight hour; normalize to keep arithmetic consistent.
  let hour = Number.parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10),
    hour,
    minute: Number.parseInt(parts.minute, 10),
    second: Number.parseInt(parts.second, 10),
  };
}

/**
 * Convert a "wall clock" datetime `(year, month, day, hour, minute)`
 * IN `tz` to its absolute UTC ms equivalent. Returns `undefined` if
 * the tz is unknown to `Intl.DateTimeFormat`.
 *
 * Two-pass to handle DST: the offset between tz and UTC depends on
 * the wall-clock date itself, so we use the initial guess to compute
 * the offset, then correct. One iteration suffices for non-DST-
 * transition wall clocks; on the spring-forward / fall-back hour the
 * answer is ambiguous and we return whichever instant V8/ICU's
 * formatter chooses (acceptable for rate-limit purposes — the reset
 * is a rough deadline, not a billing event).
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number | undefined {
  try {
    const naiveMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    const guessOffsetMs = tzOffsetMs(new Date(naiveMs), tz);
    const firstPassMs = naiveMs - guessOffsetMs;
    // Refine once — DST transitions move the offset between the naïve
    // guess and the corrected instant.
    const refinedOffsetMs = tzOffsetMs(new Date(firstPassMs), tz);
    return naiveMs - refinedOffsetMs;
  } catch {
    return undefined;
  }
}

/**
 * Difference (in ms) between the wall-clock representation of `date`
 * IN `tz` and the same wall clock interpreted as UTC. For a tz west
 * of UTC (e.g. America/Montevideo, UTC-3) the result is negative;
 * for a tz east of UTC the result is positive.
 */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = formatTzWallParts(date, tz);
  const tzWallAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return tzWallAsUtcMs - date.getTime();
}

/**
 * Return true when a raw JSONL payload matches either synthetic-error
 * signature. Pure function — no detector state read.
 */
function matchesSynthetic(raw: Record<string, unknown>): boolean {
  if (raw.isApiErrorMessage === true) return true;
  const message = raw.message as Record<string, unknown> | undefined;
  if (!message) return false;
  if (message.model !== SYNTHETIC_MODEL) return false;
  const content = message.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block.type !== "text") return false;
    const text = block.text;
    return typeof text === "string" && API_ERROR_PATTERN.test(text);
  });
}

/**
 * Pull the human-readable error text out of the synthetic entry. Falls back
 * to a stable string when the payload is malformed so the recover handler
 * always receives non-empty `errorText` for its log line.
 */
function extractErrorText(raw: Record<string, unknown>): string {
  const message = raw.message as Record<string, unknown> | undefined;
  const content = message?.content as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = block.text;
      if (typeof text === "string" && text.length > 0) return text;
    }
  }
  if (typeof raw.error === "string" && raw.error.length > 0) return raw.error;
  return "API error (synthetic — no error text in JSONL)";
}
