<script setup lang="ts">
import type { ParsedToolProgress } from "../../types";

defineProps<{ entry: ParsedToolProgress }>();
</script>

<template>
  <div class="rounded-lg border border-yellow-200 dark:border-yellow-900/50 bg-yellow-50/30 dark:bg-yellow-950/10 px-3 py-1.5">
    <div class="flex items-center gap-2 text-xs">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300">
        Progress
      </span>
      <span class="text-gray-600 dark:text-gray-400 font-mono">{{ entry.toolName }}</span>
      <span class="text-gray-500 dark:text-gray-500 text-[10px]">{{ entry.elapsedSeconds }}s elapsed</span>
    </div>
  </div>
</template>
