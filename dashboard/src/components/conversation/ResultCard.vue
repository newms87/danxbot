<script setup lang="ts">
import { DanxChip } from "danx-ui";
import type { ParsedResult } from "../../types";
import { formatMs } from "../../utils/format";

defineProps<{ entry: ParsedResult }>();
</script>

<template>
  <div
    class="rounded-lg border-2 px-3 py-2"
    :class="entry.isError
      ? 'border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20'
      : 'border-purple-300 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20'"
  >
    <div class="flex items-center gap-2 text-xs mb-1">
      <DanxChip
        :type="entry.isError ? 'danger' : ''"
        size="xs"
        :label="entry.subtype"
      />
      <span class="text-gray-600 dark:text-gray-400 font-mono text-[10px]">{{ entry.numTurns }} turns</span>
      <span class="text-gray-400 dark:text-gray-600">|</span>
      <span class="text-gray-600 dark:text-gray-400 font-mono text-[10px]">{{ formatMs(entry.durationMs) }} wall</span>
      <span class="text-gray-400 dark:text-gray-600">|</span>
      <span class="text-gray-600 dark:text-gray-400 font-mono text-[10px]">{{ formatMs(entry.durationApiMs) }} api</span>
      <span
        class="ml-auto font-semibold text-[11px]"
        :class="entry.isError ? 'text-red-600 dark:text-red-400' : 'text-purple-700 dark:text-purple-300'"
      >
        ${{ entry.totalCostUsd.toFixed(4) }}
      </span>
    </div>
    <div v-if="entry.resultText" class="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap line-clamp-3">
      {{ entry.resultText }}
    </div>
  </div>
</template>
