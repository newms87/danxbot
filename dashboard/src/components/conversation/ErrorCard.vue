<script setup lang="ts">
import type { ParsedError } from "../../types";
import { formatMs } from "../../utils/format";

defineProps<{ entry: ParsedError }>();
</script>

<template>
  <div class="rounded-lg border border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 px-3 py-2">
    <div class="flex items-center gap-2 text-xs mb-1">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-medium bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300">
        Error
      </span>
      <span class="ml-auto text-gray-400 dark:text-gray-600 font-mono text-[10px]">{{ formatMs(entry.deltaMs) }}</span>
    </div>
    <div class="text-xs text-red-700 dark:text-red-300 font-mono">{{ entry.message }}</div>
    <div
      v-if="entry.stderr"
      class="mt-1 text-[10px] text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 rounded p-2 max-h-24 overflow-y-auto font-mono whitespace-pre-wrap"
    >{{ entry.stderr }}</div>
  </div>
</template>
