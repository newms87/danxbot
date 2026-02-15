import { computed, type Ref } from "vue";
import type { MessageEvent } from "../types";
import { computePerfStats, EMPTY_PERF_STATS } from "@backend/dashboard/perf-stats";

export type { PerfStats } from "@backend/dashboard/perf-stats";

export function usePerfStats(event: Ref<MessageEvent | null>) {
  const perfStats = computed(() => {
    const ev = event.value;
    if (!ev) return EMPTY_PERF_STATS;
    return computePerfStats(ev);
  });

  return { perfStats };
}
