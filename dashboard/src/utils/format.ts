export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/**
 * Operator-locale absolute timestamp suitable for tooltips + hover panels
 * where the relative label ("3h ago") is the primary display and the
 * absolute time is the disambiguator. Shape: "Wed, May 8, 4:13 PM" — no
 * year (year clutter is rarely useful for in-the-moment ops), no
 * seconds, weekday shorthand for at-a-glance day-of-week recall.
 *
 * One formatter instance, lazily built on first call so locale lookup
 * happens exactly once per tab session — `Intl.DateTimeFormat` is
 * non-trivial to construct.
 */
let absoluteFormatter: Intl.DateTimeFormat | null = null;
export function formatAbsoluteDateTime(ts: number): string {
  if (!absoluteFormatter) {
    absoluteFormatter = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return absoluteFormatter.format(new Date(ts));
}

export function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

export function relativeTime(ts: number, baseTs: number): string {
  return ((ts - baseTs) / 1000).toFixed(1);
}

export function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
