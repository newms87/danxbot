import type { MessageEvent } from "./events.js";

export interface PerfStats {
  totalToolCalls: number;
  toolBreakdown: Record<string, number>;
  longestTool: { name: string; seconds: number } | null;
  apiTimeMs: number;
  wallTimeMs: number;
  toolTimeMs: number;
}

export const EMPTY_PERF_STATS: PerfStats = Object.freeze({
  totalToolCalls: 0,
  toolBreakdown: Object.freeze({}) as Record<string, number>,
  longestTool: null,
  apiTimeMs: 0,
  wallTimeMs: 0,
  toolTimeMs: 0,
});

export function computePerfStats(ev: MessageEvent): PerfStats {
  if (!ev.agentLog?.length) return EMPTY_PERF_STATS;

  const log = ev.agentLog;
  let totalToolCalls = 0;
  const toolBreakdown: Record<string, number> = {};
  let longestTool: { name: string; seconds: number } | null = null;

  for (const entry of log) {
    if (entry.type === "assistant" && entry.data?.content) {
      for (const block of entry.data.content as Array<{
        type: string;
        name?: string;
      }>) {
        if (block.type === "tool_use") {
          totalToolCalls++;
          const name = block.name || "unknown";
          toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
        }
      }
    }
    if (entry.type === "tool_progress" && entry.data) {
      const secs =
        (entry.data as { elapsed_time_seconds?: number })
          .elapsed_time_seconds || 0;
      if (!longestTool || secs > longestTool.seconds) {
        longestTool = {
          name:
            (entry.data as { tool_name?: string }).tool_name || "unknown",
          seconds: secs,
        };
      }
    }
  }

  const resultEntry = log.find((e) => e.type === "result");
  const apiTimeMs = resultEntry
    ? (resultEntry.data as { duration_api_ms?: number }).duration_api_ms || 0
    : 0;

  // Use listener wall-clock timestamps instead of SDK's duration_ms
  const wallTimeMs = ev.agentResponseAt
    ? ev.agentResponseAt - (ev.routerResponseAt || ev.receivedAt)
    : 0;

  // Clamp to zero: API time can exceed wall time when API calls stream in parallel
  const toolTimeMs = Math.max(0, wallTimeMs - apiTimeMs);

  return { totalToolCalls, toolBreakdown, longestTool, apiTimeMs, wallTimeMs, toolTimeMs };
}
