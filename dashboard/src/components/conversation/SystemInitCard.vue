<script setup lang="ts">
import type { ParsedSystemInit } from "../../types";

defineProps<{ entry: ParsedSystemInit }>();
</script>

<template>
  <div class="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
    <div class="flex items-center gap-2 text-xs">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-medium bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
        INIT
      </span>
      <span class="text-gray-600 dark:text-gray-400 font-mono">{{ entry.model }}</span>
      <span class="text-gray-400 dark:text-gray-600">|</span>
      <span class="text-gray-500 dark:text-gray-500">{{ entry.tools.join(', ') }}</span>
      <span class="ml-auto text-gray-400 dark:text-gray-600 font-mono text-[10px]">{{ entry.sessionId.slice(0, 8) }}</span>
    </div>
  </div>
</template>
