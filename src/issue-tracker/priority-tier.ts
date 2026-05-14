import { PRIORITY_MIN, PRIORITY_MAX } from "./yaml.js";

/**
 * 6-tier priority classification (DX-521 / DX-520).
 *
 * Maps a numeric priority value in the open interval `(0, 6)` to one of
 * six ordered tiers. The dashboard renders a colored icon per tier; the
 * dispatch sort uses the continuous `Issue.priority` value directly
 * (not the tier label) — this helper exists so both the backend display
 * surface and the frontend share a single classification module.
 *
 * | Tier        | Range          | Default |
 * |-------------|----------------|---------|
 * | lowest      | `(0, 1)`       | 0.5     |
 * | low         | `[1, 2)`       | 1.5     |
 * | medium      | `[2, 3)`       | 2.5     |
 * | high        | `[3, 4)`       | 3.5     |
 * | very_high   | `[4, 5)`       | 4.5     |
 * | critical    | `[5, 5.99]`    | 5.5     |
 *
 * Bucket semantics are `[min, max)` for tiers 1..5 (lowest..very_high)
 * and `[5.0, 5.99]` for critical — the upper clamp (`PRIORITY_MAX =
 * 5.99` in `yaml.ts`) lands inside critical so a clamped value never
 * falls outside any tier. `defaultValue` is the midpoint of the bucket;
 * the dashboard menu commits this value when an operator picks a tier
 * label without typing a numeric override.
 *
 * Lockstep partner: `PRIORITY_MIN` / `PRIORITY_MAX` in
 * `src/issue-tracker/yaml.ts`. The first tier's `min` matches
 * `PRIORITY_MIN` and the last tier's `max` matches `PRIORITY_MAX` so
 * the helper covers the full clamp range.
 */

export type PriorityTierKey =
  | "lowest"
  | "low"
  | "medium"
  | "high"
  | "very_high"
  | "critical";

export interface PriorityTier {
  key: PriorityTierKey;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
}

/**
 * Ordered low → high. Position in the array IS the canonical tier
 * ordering; callers that need "next tier up" / "previous tier down"
 * walk by index, not by key.
 */
export const PRIORITY_TIERS: readonly PriorityTier[] = [
  { key: "lowest", label: "Lowest", min: 0.01, max: 1.0, defaultValue: 0.5 },
  { key: "low", label: "Low", min: 1.0, max: 2.0, defaultValue: 1.5 },
  { key: "medium", label: "Medium", min: 2.0, max: 3.0, defaultValue: 2.5 },
  { key: "high", label: "High", min: 3.0, max: 4.0, defaultValue: 3.5 },
  {
    key: "very_high",
    label: "Very High",
    min: 4.0,
    max: 5.0,
    defaultValue: 4.5,
  },
  { key: "critical", label: "Critical", min: 5.0, max: 5.99, defaultValue: 5.5 },
] as const;

/**
 * Import-time lockstep guard — fail loud if a `yaml.ts` bounds edit
 * drifts from the tier table here. A future operator widening the
 * clamp range in `yaml.ts` without also updating PRIORITY_TIERS would
 * silently produce values outside every tier; this throw forces the
 * coupling. Pre-DX-521 the bounds were `[1.0, 5.0]`; DX-521 widened
 * to `[0.01, 5.99]` to fit the six labelled tiers.
 */
if (PRIORITY_TIERS[0].min !== PRIORITY_MIN) {
  throw new Error(
    `priority-tier.ts lockstep violation: PRIORITY_TIERS[0].min=${PRIORITY_TIERS[0].min} != PRIORITY_MIN=${PRIORITY_MIN} from yaml.ts`,
  );
}
if (PRIORITY_TIERS[PRIORITY_TIERS.length - 1].max !== PRIORITY_MAX) {
  throw new Error(
    `priority-tier.ts lockstep violation: PRIORITY_TIERS[last].max=${PRIORITY_TIERS[PRIORITY_TIERS.length - 1].max} != PRIORITY_MAX=${PRIORITY_MAX} from yaml.ts`,
  );
}

/**
 * Classify a priority value into one of six tiers.
 *
 * The function trusts its input — caller is responsible for clamping
 * via `clampPriority` (`yaml.ts`) before display. Inputs outside the
 * clamp range still classify deterministically (`p < 1.0` → "lowest",
 * `p >= 5.0` → "critical") so a future caller that hasn't clamped does
 * not throw or return undefined.
 */
export function priorityTier(p: number): PriorityTierKey {
  if (p < 1.0) return "lowest";
  if (p < 2.0) return "low";
  if (p < 3.0) return "medium";
  if (p < 4.0) return "high";
  if (p < 5.0) return "very_high";
  return "critical";
}
