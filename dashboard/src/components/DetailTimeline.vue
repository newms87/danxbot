<script setup lang="ts">
import type { MessageEvent } from "../types";
import { formatMs } from "../utils/format";

defineProps<{
  event: MessageEvent;
}>();
</script>

<template>
  <div class="mt-4">
    <div class="text-xs text-gray-500 uppercase mb-2">Timeline</div>
    <div class="flex items-center gap-2 text-xs">
      <div class="bg-gray-100 dark:bg-gray-800 rounded px-2 py-1 text-gray-600 dark:text-gray-400">Received</div>
      <template v-if="event.routerResponseAt">
        <div class="text-gray-400 dark:text-gray-600">→ {{ formatMs(event.routerResponseAt - event.receivedAt) }} →</div>
        <div class="bg-blue-100 dark:bg-blue-900/50 rounded px-2 py-1 text-blue-700 dark:text-blue-300">Router</div>
      </template>
      <template v-if="event.agentResponseAt">
        <div class="text-gray-400 dark:text-gray-600">→ {{ formatMs(event.agentResponseAt - (event.routerResponseAt ?? event.receivedAt)) }} →</div>
        <div class="bg-purple-100 dark:bg-purple-900/50 rounded px-2 py-1 text-purple-700 dark:text-purple-300">Agent</div>
      </template>
      <template v-if="event.status === 'complete'">
        <div class="text-gray-400 dark:text-gray-600">→</div>
        <div class="bg-green-100 dark:bg-green-900/50 rounded px-2 py-1 text-green-700 dark:text-green-300">
          Total: {{ formatMs((event.agentResponseAt || event.routerResponseAt || event.receivedAt) - event.receivedAt) }}
        </div>
      </template>
    </div>
  </div>
</template>
