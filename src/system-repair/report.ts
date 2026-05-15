/**
 * DX-562 (Phase 2 of DX-560 — Self-Repair): the fire-and-forget wrapper
 * that turns a thrown error at a deterministic callsite into a row in
 * `system_errors` via `recordError`. Callers stay on the synchronous
 * hot path — the wrapper swallows every DB failure to a single
 * `logger.warn` so a Postgres hiccup can never crash a worker boot
 * scan, a heal pass, an audit tick, a triage timer, the dispatcher, or
 * an MCP probe.
 *
 * Design rules:
 *
 * - Wrapper NEVER throws + NEVER rejects. The promise always resolves.
 *   Callers `await` it for ordering but a missed `await` cannot crash
 *   the process — an unhandled-rejection guard inside the function
 *   absorbs every reject path. DB pool unreachable, migration not
 *   applied, table missing — all collapse to one warn line and a
 *   resolved promise.
 * - Existing `logger.warn` / `logger.error` lines at each callsite stay
 *   verbatim. The wrapper is ADDITIVE — operators see the same stdout
 *   stream they always have; the DB accumulates the categorized count
 *   alongside.
 * - Sample payload is small. Default fills `raw_msg` from `err.message`
 *   and the last 5 stack frames; callers add `path` / `issue_id` /
 *   `line` for context. No env dump, no full stacks, no full file
 *   contents — Phase 3's repair agents need a hint, not a haystack.
 * - Accepts `err: unknown` so `catch (err)` blocks can pass it raw.
 *   Non-Error values are coerced via `new Error(String(err))` so the
 *   downstream `err.name` / `err.message` access always works.
 */

import type { Pool } from "pg";
import { getPool } from "../db/connection.js";
import { recordError } from "./categorize.js";
import { createLogger } from "../logger.js";
import type { SystemErrorSamplePayload } from "./types.js";

const log = createLogger("system-repair");

const STACK_FRAME_LIMIT = 5;

/**
 * One-warn-per-`(component, normalized-errMsg)` per process lifetime.
 * Without this, a missing migration / dead pool produces one warn per
 * deterministic-error fire — boot can emit 9+ identical lines, every
 * audit tick a handful more. Dedup keeps the operator-visible signal
 * clean. The wrapper STILL attempts the DB write every call (so when
 * the table reappears, counts accumulate correctly); only the warn
 * line is rate-limited. Reviewer test-reviewer flagged the spam risk
 * during DX-562 review.
 */
const warnedKeys = new Set<string>();

export interface ReportSystemErrorInput {
  repo: string;
  component: string;
  err: unknown;
  samplePayload?: Partial<SystemErrorSamplePayload>;
  /**
   * Pool override — test-only seam. Production callers omit this and
   * the wrapper resolves the shared `getPool()`. Splitting it out
   * keeps callsites terse + lets `report.test.ts` inject a stub pool
   * whose `query()` rejects to exercise the swallow path without
   * touching the global pool singleton.
   */
  db?: Pool;
}

/**
 * Fire-and-forget reporter for deterministic callsite errors. Every
 * branch resolves; no branch rejects.
 */
export async function reportSystemError(
  input: ReportSystemErrorInput,
): Promise<void> {
  const { repo, component, err, samplePayload } = input;
  const error = coerceToError(err);
  // Caller-supplied fields land FIRST so the wrapper-derived
  // `raw_msg` / `stack` win — keeps the 5-frame stack cap
  // un-defeatable from a caller that accidentally passed a full
  // stack via `samplePayload.stack` (caught in code review).
  const payload: SystemErrorSamplePayload = {
    ...samplePayload,
    raw_msg: error.message,
    ...(error.stack
      ? {
          stack: error.stack.split("\n").slice(0, STACK_FRAME_LIMIT).join("\n"),
        }
      : {}),
  };

  let pool: Pool;
  try {
    pool = input.db ?? getPool();
  } catch (poolErr) {
    warnOnce(
      component,
      error.message,
      `reportSystemError(component=${component}, repo=${repo}): DB pool unavailable — ${formatErr(poolErr)}`,
    );
    return;
  }

  try {
    await recordError({
      db: pool,
      repo,
      component,
      err: error,
      samplePayload: payload,
    });
  } catch (dbErr) {
    warnOnce(
      component,
      error.message,
      `reportSystemError(component=${component}, repo=${repo}): DB write failed — ${formatErr(dbErr)}`,
    );
  }
}

function warnOnce(component: string, errMsg: string, line: string): void {
  const key = `${component}\0${errMsg}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  log.warn(line);
}

/**
 * Test-only — clear the rate-limit memo between tests so each test
 * starts with a clean slate. NOT for production use.
 */
export function _resetWarnDedupForTest(): void {
  warnedKeys.clear();
}

function coerceToError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
