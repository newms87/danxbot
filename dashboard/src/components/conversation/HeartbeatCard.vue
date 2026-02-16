<script setup lang="ts">
import { ref } from "vue";
import type { ParsedHeartbeat } from "../../types";

defineProps<{ entry: ParsedHeartbeat }>();

const showSummary = ref(false);
</script>

<template>
  <div
    class="rounded-lg border px-3 py-2"
    :style="{ borderColor: entry.color + '40', backgroundColor: entry.color + '08' }"
  >
    <div class="flex items-center gap-2 text-xs">
      <span
        class="inline-flex items-center px-1.5 py-0.5 rounded font-medium text-[10px]"
        :style="{ backgroundColor: entry.color + '20', color: entry.color }"
      >
        Heartbeat
      </span>
      <span class="text-gray-700 dark:text-gray-300">{{ entry.text }}</span>
    </div>
    <div v-if="entry.activitySummary" class="mt-1">
      <button
        class="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400"
        @click="showSummary = !showSummary"
      >
        <span>{{ showSummary ? '&#x25BC;' : '&#x25B6;' }}</span> Activity
      </button>
      <div
        v-if="showSummary"
        class="mt-1 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono"
      >{{ entry.activitySummary }}</div>
    </div>
  </div>
</template>
