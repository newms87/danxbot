<script setup lang="ts">
import type { ParsedRouter } from "../../types";

defineProps<{ entry: ParsedRouter }>();
</script>

<template>
  <div class="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/30 dark:bg-amber-950/10 px-3 py-2">
    <div class="flex items-center gap-2 text-xs mb-1">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
        Router
      </span>
      <span
        class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono"
        :class="entry.needsAgent
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
          : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'"
      >
        {{ entry.needsAgent ? 'Agent needed' : 'Router only' }}
      </span>
      <span class="text-gray-500 dark:text-gray-500 font-mono text-[10px]">{{ entry.complexity }}</span>
      <span
        v-if="entry.costUsd > 0"
        class="ml-auto font-semibold text-[11px] text-amber-700 dark:text-amber-300"
      >
        ${{ entry.costUsd.toFixed(4) }}
      </span>
    </div>
    <div v-if="entry.quickResponse" class="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
      {{ entry.quickResponse }}
    </div>
    <div v-if="entry.reason" class="text-[10px] text-gray-400 dark:text-gray-500 mt-1 italic">
      {{ entry.reason }}
    </div>
  </div>
</template>
