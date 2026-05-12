<script setup lang="ts">
import type { DispatchStatus } from "../types";

defineProps<{ status: DispatchStatus }>();

const LABELS: Record<DispatchStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  recovered: "Recovered",
  // DX-322 — distinct from `failed`/`recovered`: dispatch was killed
  // by the rate-limit throttle handler and the worker is waiting for
  // the limit to reset before re-dispatching.
  throttled: "Throttled",
};

const CLASSES: Record<DispatchStatus, string> = {
  queued: "bg-slate-700/40 text-slate-200",
  running: "bg-amber-500/20 text-amber-300",
  completed: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-slate-500/25 text-slate-300",
  // DX-260 (Phase 2 of DX-246) — distinct hue so operators can spot
  // chains that auto-recovered from an Anthropic stream-idle synthetic.
  // Sky blue: "intervened but didn't fail" — the recover child carries
  // the user-facing outcome.
  recovered: "bg-sky-500/20 text-sky-300",
  // DX-322 — orange (distinct from running amber + completed emerald
  // + failed red + recovered sky). The throttle banner uses amber for
  // the banner border + bg; the dispatches-table pill uses orange so
  // operators don't confuse a terminal "throttled" row with a live
  // "running" row (both would be amber otherwise).
  throttled: "bg-orange-500/25 text-orange-200",
};
</script>

<template>
  <span
    class="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold"
    :class="CLASSES[status]"
  >
    {{ LABELS[status] }}
  </span>
</template>
