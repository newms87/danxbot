<script setup lang="ts">
import type { TriggerType } from "../types";

defineProps<{ trigger: TriggerType }>();

const LABELS: Record<TriggerType, string> = {
  slack: "Slack",
  trello: "Trello",
  api: "API",
};

const CLASSES: Record<TriggerType, string> = {
  slack: "bg-purple-900/30 text-purple-200 border-purple-700/40",
  trello: "bg-blue-900/30 text-blue-200 border-blue-700/40",
  api: "bg-emerald-900/30 text-emerald-200 border-emerald-700/40",
};
</script>

<template>
  <span
    class="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded border"
    :class="CLASSES[trigger]"
  >
    {{ LABELS[trigger] }}
  </span>
</template>
