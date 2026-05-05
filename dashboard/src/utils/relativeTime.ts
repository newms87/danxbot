const I_MIN = 60_000;
const I_HOUR = 3_600_000;
const I_DAY = 86_400_000;

export function relativeTime(ms: number, now: number = Date.now()): string {
  const d = now - ms;
  if (d < I_MIN) return "just now";
  if (d < I_HOUR) return `${Math.floor(d / I_MIN)}m ago`;
  if (d < I_DAY) return `${Math.floor(d / I_HOUR)}h ago`;
  return `${Math.floor(d / I_DAY)}d ago`;
}
