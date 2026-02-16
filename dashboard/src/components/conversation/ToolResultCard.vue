<script setup lang="ts">
import { reactive } from "vue";
import type { ParsedToolResult } from "../../types";
import { formatMs } from "../../utils/format";

defineProps<{ entry: ParsedToolResult }>();

const expandedResults: Record<number, boolean> = reactive({});

function toggleResult(idx: number) {
  expandedResults[idx] = !expandedResults[idx];
}
</script>

<template>
  <div class="rounded-lg border border-green-200 dark:border-green-900/50 bg-green-50/30 dark:bg-green-950/10 px-3 py-2">
    <div class="flex items-center gap-2 text-xs mb-1">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-medium bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300">
        Tool Results
      </span>
      <span class="text-gray-500 dark:text-gray-500 text-[10px]">{{ entry.results.length }} result(s)</span>
      <span class="ml-auto text-gray-400 dark:text-gray-600 font-mono text-[10px]">{{ formatMs(entry.deltaMs) }}</span>
    </div>
    <div v-for="(result, idx) in entry.results" :key="idx" class="mt-1">
      <button
        class="flex items-center gap-1 text-[10px] font-mono"
        :class="result.isError
          ? 'text-red-500 dark:text-red-400'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
        @click="toggleResult(idx)"
      >
        <span>{{ expandedResults[idx] ? '▼' : '▶' }}</span>
        <span>{{ result.toolUseId.slice(0, 12) }}</span>
        <span v-if="result.isError" class="text-red-500 dark:text-red-400 font-medium">ERROR</span>
      </button>
      <div
        v-if="expandedResults[idx]"
        class="mt-1 text-xs bg-gray-100 dark:bg-gray-800 rounded p-2 max-h-40 overflow-y-auto overflow-x-auto whitespace-pre-wrap font-mono"
        :class="result.isError ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'"
      >{{ result.content }}</div>
    </div>
  </div>
</template>
