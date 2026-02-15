<script setup lang="ts">
import type { MessageEvent } from "../types";

defineProps<{
  event: MessageEvent;
}>();
</script>

<template>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
    <div v-if="event.routerResponse">
      <div class="text-xs text-gray-500 uppercase mb-1">Router Response</div>
      <div class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-sm text-blue-700 dark:text-blue-300 whitespace-pre-wrap">{{ event.routerResponse }}</div>
    </div>
    <div v-if="event.agentResponse">
      <div class="text-xs text-gray-500 uppercase mb-1">Agent Response</div>
      <div class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-sm text-purple-700 dark:text-purple-300 whitespace-pre-wrap max-h-64 overflow-y-auto">{{ event.agentResponse }}</div>
    </div>
  </div>
</template>
