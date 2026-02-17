<script setup lang="ts">
import { reactive } from "vue";
import { CodeViewer, DanxChip } from "danx-ui";
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
      <DanxChip type="success" size="xs" label="Tool Results" />
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
        <span>{{ expandedResults[idx] ? '\u25BC' : '\u25B6' }}</span>
        <span>{{ result.toolUseId.slice(0, 12) }}</span>
        <DanxChip v-if="result.isError" type="danger" size="xxs" label="ERROR" />
      </button>
      <CodeViewer
        v-if="expandedResults[idx]"
        :model-value="result.content"
        format="text"
        :hide-footer="true"
        theme="dark"
        class="mt-1"
      />
    </div>
  </div>
</template>
