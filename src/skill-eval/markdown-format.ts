/**
 * Shared markdown formatters for the skill-eval harness.
 *
 * Centralizing keeps every renderer using the same percentage / cost /
 * elapsed shapes so REPORT.md, SWEEP.md, and the iterate report read
 * identically — operators eyeballing the three rendered files in
 * sequence never have to ask "wait, is that 2dp or 1dp?".
 *
 * `formatPercent` is the default 2dp form for accuracy tables. The
 * iterate report's per-iteration history table uses `formatPctOneDp`
 * (one decimal) because the column is narrow and the third digit was
 * never carrying information — `iterate.ts`'s convergence threshold is
 * coarser than 1dp anyway.
 *
 * `formatCostUsd` carries the load-bearing `~$` prefix: the figure is
 * an ESTIMATE based on `--pricing-model`, not a per-message exact
 * charge. Stripping the tilde would imply precision the harness does
 * not yet deliver until per-message model extraction lands.
 */

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

export function formatPctOneDp(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatCostUsd(usd: number): string {
  return `~$${usd.toFixed(4)}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}
