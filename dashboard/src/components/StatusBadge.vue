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
