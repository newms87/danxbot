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

export interface ApiErrorInfo {
  jobId: string;
  errorText: string;
  recoverCount: number;
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

interface PendingRecover {
  timer: ReturnType<typeof setTimeout>;
  recoverCount: number;
  errorText: string;
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
      this.armOrIgnore(extractErrorText(raw));
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
   */
  private armOrIgnore(errorText: string): void {
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
      this.onApiError({
        jobId: this.jobId,
        errorText: info.errorText,
        recoverCount: info.recoverCount,
      });
    }, this.confirmationWindowMs);

    this.pending = { timer, recoverCount: currentEpoch, errorText };
  }
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
