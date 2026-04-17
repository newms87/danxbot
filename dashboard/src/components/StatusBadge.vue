<script setup lang="ts">
import type { DispatchStatus } from "../types";

defineProps<{ status: DispatchStatus }>();

const LABELS: Record<DispatchStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const CLASSES: Record<DispatchStatus, string> = {
  queued: "bg-slate-700/40 text-slate-200",
  running: "bg-amber-500/20 text-amber-300",
  completed: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-slate-500/25 text-slate-300",
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
