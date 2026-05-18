/**
 * DX-636 — event-loop delay monitor.
 *
 * Wires `perf_hooks.monitorEventLoopDelay` into the worker boot path so a
 * starvation regression (DX-633 root cause) surfaces on the dashboard's
 * system-errors stream BEFORE it manifests as a `Connection terminated`
 * outage. Tier 3 observability per the parent epic's Solution Quality Bar
 * — co-ships with Tier 1, never replaces it.
 *
 * Every {@link EventLoopMonitorOptions.intervalMs} the tick:
 *   1. Reads `{p50, p99, max}` from the histogram (nanoseconds → ms).
 *   2. Stores the sample for `/health` exposure via {@link getLatestEventLoopSample}.
 *   3. Resets the histogram (`.reset()`).
 *   4. If `p99 > stallThresholdMs`, emits a `severity: "warn"` system error
 *      with `source: "event-loop-stall"` so the banner fires.
 *
 * Tunable via env (`DANXBOT_LOOP_METRIC_INTERVAL_MS`, `DANXBOT_LOOP_STALL_THRESHOLD_MS`).
 * Defaults: 10000ms tick, 500ms p99 threshold. Resolution = 20ms (Node default).
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import {
  recordSystemError as defaultRecordSystemError,
  type RecordSystemErrorOptions,
} from "../dashboard/system-errors.js";

export interface EventLoopSample {
  /** p50 loop-delay in milliseconds. */
  p50: number;
  /** p99 loop-delay in milliseconds. */
  p99: number;
  /** Max observed loop-delay in milliseconds since the prior tick. */
  max: number;
  /** Wall-clock ms (Date.now()) when the sample was taken. */
  sampledAtMs: number;
}

export interface EventLoopMonitorOptions {
  /** Per-repo label propagated to recordSystemError. */
  repoName: string;
  /** Tick interval in ms. Default: env `DANXBOT_LOOP_METRIC_INTERVAL_MS` or 10000. */
  intervalMs?: number;
  /** Threshold above which p99 produces a system error. Default: env `DANXBOT_LOOP_STALL_THRESHOLD_MS` or 500. */
  stallThresholdMs?: number;
  /** Histogram resolution in ms (passed to monitorEventLoopDelay). Default 20. */
  resolutionMs?: number;
  /** Inject a histogram (tests). */
  histogram?: IntervalHistogram;
  /** Inject a recordSystemError sink (tests). */
  recordSystemError?: (opts: RecordSystemErrorOptions) => unknown;
}

export interface EventLoopMonitorHandle {
  stop(): void;
  /** Force one tick + return the new sample. Test helper. */
  tickNow(): EventLoopSample;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_STALL_THRESHOLD_MS = 500;
const DEFAULT_RESOLUTION_MS = 20;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let latestSample: EventLoopSample | null = null;

export function getLatestEventLoopSample(): EventLoopSample | null {
  return latestSample;
}

/** Test-only: drain the sample between cases. */
export function _resetLatestEventLoopSample(): void {
  latestSample = null;
}

export function startEventLoopMonitor(
  opts: EventLoopMonitorOptions,
): EventLoopMonitorHandle {
  const intervalMs =
    opts.intervalMs ??
    envNumber("DANXBOT_LOOP_METRIC_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const stallThresholdMs =
    opts.stallThresholdMs ??
    envNumber("DANXBOT_LOOP_STALL_THRESHOLD_MS", DEFAULT_STALL_THRESHOLD_MS);
  const resolutionMs = opts.resolutionMs ?? DEFAULT_RESOLUTION_MS;
  const record = opts.recordSystemError ?? defaultRecordSystemError;
  const histogram =
    opts.histogram ?? monitorEventLoopDelay({ resolution: resolutionMs });

  histogram.enable();

  const tick = (): EventLoopSample => {
    // Node histogram values are in nanoseconds — convert to ms.
    const p50 = histogram.percentile(50) / 1_000_000;
    const p99 = histogram.percentile(99) / 1_000_000;
    const max = histogram.max / 1_000_000;
    const sample: EventLoopSample = {
      p50,
      p99,
      max,
      sampledAtMs: Date.now(),
    };
    latestSample = sample;
    histogram.reset();

    if (p99 > stallThresholdMs) {
      record({
        source: "event-loop-stall",
        severity: "warn",
        repo: opts.repoName,
        message: `Event-loop p99 delay ${p99.toFixed(1)}ms exceeded threshold ${stallThresholdMs}ms`,
        details: { p50, p99, max, thresholdMs: stallThresholdMs },
      });
    }
    return sample;
  };

  const interval = setInterval(tick, intervalMs);
  // Don't keep the event loop alive for this timer — graceful shutdown
  // owns lifecycle; an unref'd timer lets the process exit naturally if
  // it's the only thing left running.
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop(): void {
      clearInterval(interval);
      histogram.disable();
    },
    tickNow: tick,
  };
}
