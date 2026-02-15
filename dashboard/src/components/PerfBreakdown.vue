<script setup lang="ts">
import { toRef } from "vue";
import type { MessageEvent } from "../types";
import { formatMs } from "../utils/format";
import { usePerfStats } from "../composables/usePerfStats";

const props = defineProps<{
  event: MessageEvent;
}>();

const { perfStats } = usePerfStats(toRef(props, "event") as import("vue").Ref<MessageEvent | null>);
</script>

<template>
  <div class="bg-gray-100 dark:bg-gray-800 rounded p-3">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
      <div>
        <div class="text-gray-500 uppercase">Tool Calls</div>
        <div class="text-lg font-bold text-gray-900 dark:text-white mt-0.5">{{ perfStats.totalToolCalls }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase">API Time</div>
        <div class="text-lg font-bold text-blue-600 dark:text-blue-400 mt-0.5">{{ formatMs(perfStats.apiTimeMs) }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase">Wall Time</div>
        <div class="text-lg font-bold text-purple-600 dark:text-purple-400 mt-0.5">{{ formatMs(perfStats.wallTimeMs) }}</div>
      </div>
      <div>
        <div class="text-gray-500 uppercase">Tool Time</div>
        <div class="text-lg font-bold text-yellow-600 dark:text-yellow-400 mt-0.5">{{ formatMs(perfStats.wallTimeMs - perfStats.apiTimeMs) }}</div>
      </div>
    </div>
    <div v-if="Object.keys(perfStats.toolBreakdown).length" class="mt-3 flex flex-wrap gap-2">
      <span
        v-for="(count, name) in perfStats.toolBreakdown"
        :key="name"
        class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
      >
        {{ name }}: {{ count }}
      </span>
    </div>
    <div v-if="perfStats.longestTool" class="mt-2 text-xs text-gray-600 dark:text-gray-400">
      Longest tool: <span class="text-yellow-700 dark:text-yellow-300">{{ perfStats.longestTool.name }}</span>
      ({{ perfStats.longestTool.seconds }}s)
    </div>
  </div>
</template>
