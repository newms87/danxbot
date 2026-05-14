/**
 * Human-readable elapsed-time formatters. Two surfaces:
 *
 *   - `relativeTime(ms)` → freshness, e.g. "5m ago" / "just now". Used
 *     anywhere we want the operator to scan "did this change recently?".
 *   - `relativeOld(ms)`  → lifetime, e.g. "3d old" / "new". Used when we
 *     want the operator to scan "how long has this thing existed?".
 *
 * Both surfaces share one bucket function so the minute / hour / day
 * thresholds are defined exactly once. Adding a new bucket (e.g.
 * "month") is a one-line edit to `ageBuckets` plus the formatter switch
 * — never a hunt across files.
 */

const I_MIN = 60_000;
const I_HOUR = 3_600_000;
const I_DAY = 86_400_000;

type AgeUnit = "now" | "min" | "hour" | "day";

interface AgeBucket {
  /** Whole-number magnitude of the age in `unit`. `0` when `unit` is `"now"`. */
  count: number;
  unit: AgeUnit;
}

/**
 * Pure bucket math. Negative diffs (clock skew, future timestamp) collapse
 * to `"now"` so callers never render `-1m ago`. Exported for the few cases
 * a consumer needs the structured shape (e.g. CSS class derived from the
 * unit); both formatters below are the typical consumer.
 */
export function ageBuckets(diffMs: number): AgeBucket {
  if (diffMs < I_MIN) return { count: 0, unit: "now" };
  if (diffMs < I_HOUR) return { count: Math.floor(diffMs / I_MIN), unit: "min" };
  if (diffMs < I_DAY) return { count: Math.floor(diffMs / I_HOUR), unit: "hour" };
  return { count: Math.floor(diffMs / I_DAY), unit: "day" };
}

const SHORT: Record<Exclude<AgeUnit, "now">, string> = {
  min: "m",
  hour: "h",
  day: "d",
};

/** "X ago" / "just now". */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const b = ageBuckets(now - ms);
  if (b.unit === "now") return "just now";
  return `${b.count}${SHORT[b.unit]} ago`;
}

/** "X old" / "new". */
export function relativeOld(ms: number, now: number = Date.now()): string {
  const b = ageBuckets(now - ms);
  if (b.unit === "now") return "new";
  return `${b.count}${SHORT[b.unit]} old`;
}

/**
 * Compact "Nm" / "Nh" / "Nd" / "now" — no suffix, no space. Drives the
 * triage chip on `IssueCard.vue` where horizontal space is at a premium
 * and the surrounding label ("triaged Nm") already supplies the
 * "ago"-flavored context.
 */
export function compactAge(ms: number, now: number = Date.now()): string {
  const b = ageBuckets(now - ms);
  if (b.unit === "now") return "now";
  return `${b.count}${SHORT[b.unit]}`;
}
