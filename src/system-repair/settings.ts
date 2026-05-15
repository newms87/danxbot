/**
 * DX-563 (Phase 3 of DX-560 — Self-Repair): canonical reader for
 * `selfRepair.threshold` + worker-side display-mirror helper.
 *
 * The dispatcher (`src/cron/jobs/self-repair-dispatch.ts`) reads the
 * threshold via {@link getSelfRepairThreshold}; the same module also
 * lazily mirrors it to `display.selfRepair` so the dashboard's Agents
 * panel reads display-shape state from one place. The mirror is
 * idempotent — `ensureSelfRepairDisplayMirror` skips the write when
 * the on-disk display value already matches.
 */

import {
  readSettings,
  writeSettings,
  DEFAULT_SELF_REPAIR_THRESHOLD,
} from "../settings-file.js";

export { DEFAULT_SELF_REPAIR_THRESHOLD };

export function getSelfRepairThreshold(repoLocalPath: string): number {
  const settings = readSettings(repoLocalPath);
  const configured = settings.selfRepair?.threshold;
  if (typeof configured === "number" && configured >= 1) {
    return Math.floor(configured);
  }
  return DEFAULT_SELF_REPAIR_THRESHOLD;
}

/**
 * Idempotent mirror — writes `display.selfRepair = { threshold }` ONLY
 * when missing or stale. Safe to call on every dispatcher tick; the
 * common case is a no-op file read.
 */
export async function ensureSelfRepairDisplayMirror(
  repoLocalPath: string,
): Promise<void> {
  const settings = readSettings(repoLocalPath);
  const threshold = getSelfRepairThreshold(repoLocalPath);
  const current = (settings.display.selfRepair as { threshold?: unknown } | undefined)
    ?.threshold;
  if (current === threshold) return;

  await writeSettings(repoLocalPath, {
    display: {
      ...settings.display,
      selfRepair: { threshold },
    },
    writtenBy: "worker",
  });
}
