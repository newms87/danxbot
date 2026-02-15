export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

export function relativeTime(ts: number, baseTs: number): string {
  return ((ts - baseTs) / 1000).toFixed(1);
}
