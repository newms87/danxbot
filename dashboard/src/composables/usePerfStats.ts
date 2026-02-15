import { computed, type Ref } from "vue";
import type { MessageEvent } from "../types";

export interface PerfStats {
  totalToolCalls: number;
  toolBreakdown: Record<string, number>;
  longestTool: { name: string; seconds: number } | null;
  apiTimeMs: number;
  wallTimeMs: number;
}

const EMPTY: PerfStats = {
  totalToolCalls: 0,
  toolBreakdown: {},
  longestTool: null,
  apiTimeMs: 0,
  wallTimeMs: 0,
};

export function usePerfStats(event: Ref<MessageEvent | null>) {
  const perfStats = computed<PerfStats>(() => {
    const ev = event.value;
    if (!ev?.agentLog?.length) return EMPTY;

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
    const wallTimeMs = resultEntry
      ? (resultEntry.data as { duration_ms?: number }).duration_ms || 0
      : 0;

    return { totalToolCalls, toolBreakdown, longestTool, apiTimeMs, wallTimeMs };
  });

  return { perfStats };
}
