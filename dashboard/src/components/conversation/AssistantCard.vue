<script setup lang="ts">
import { ref } from "vue";
import type { ParsedAssistant } from "../../types";
import { formatMs, formatTokens } from "../../utils/format";

defineProps<{ entry: ParsedAssistant }>();

const showThinking = ref(false);
</script>

<template>
  <div class="rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50/50 dark:bg-blue-950/20 px-3 py-2">
    <!-- Header -->
    <div class="flex items-center gap-2 text-xs mb-1">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300">
        Assistant
      </span>
      <span v-if="entry.model" class="text-gray-500 dark:text-gray-500 font-mono text-[10px]">{{ entry.model }}</span>
      <span class="ml-auto text-gray-400 dark:text-gray-600 font-mono text-[10px]">{{ formatMs(entry.deltaMs) }}</span>
      <template v-if="entry.usage">
        <span class="text-gray-400 dark:text-gray-600">|</span>
        <span class="text-gray-500 dark:text-gray-500 font-mono text-[10px]">
          {{ formatTokens(entry.usage.inputTokens) }}in
          {{ formatTokens(entry.usage.outputTokens) }}out
        </span>
      </template>
    </div>

    <!-- Thinking (collapsible) -->
    <div v-if="entry.thinking" class="mt-1">
      <button
        class="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400"
        @click="showThinking = !showThinking"
      >
        <span>{{ showThinking ? '▼' : '▶' }}</span> Thinking
      </button>
      <div
        v-if="showThinking"
        class="mt-1 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono"
      >{{ entry.thinking }}</div>
    </div>

    <!-- Response text -->
    <div v-if="entry.text" class="mt-1 text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
      {{ entry.text }}
    </div>

    <!-- Tool calls -->
    <div v-if="entry.toolCalls.length > 0" class="mt-1.5 flex flex-wrap gap-1">
      <span
        v-for="tc in entry.toolCalls"
        :key="tc.id"
        class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/50"
      >
        <span class="font-semibold">{{ tc.name }}</span>
        <span v-if="tc.inputSummary" class="text-indigo-500 dark:text-indigo-400 truncate max-w-[200px]">{{ tc.inputSummary }}</span>
      </span>
    </div>
  </div>
</template>
