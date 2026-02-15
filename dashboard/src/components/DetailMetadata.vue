<script setup lang="ts">
import type { MessageEvent } from "../types";

defineProps<{
  event: MessageEvent;
}>();
</script>

<template>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div>
      <div class="text-xs text-gray-500 uppercase mb-1">User Message</div>
      <div class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{{ event.text }}</div>
    </div>
    <div>
      <div class="text-xs text-gray-500 uppercase mb-1">Metadata</div>
      <div class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-xs text-gray-600 dark:text-gray-400 space-y-1 font-mono">
        <div>Thread: {{ event.threadTs }}</div>
        <div>Message: {{ event.messageTs }}</div>
        <div>Channel: {{ event.channelId }}</div>
        <div>Status: {{ event.status }}</div>
        <div
          v-if="event.feedback"
          :class="event.feedback === 'positive' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
        >
          Feedback: {{ event.feedback === 'positive' ? '👍 Positive' : '👎 Negative' }}
        </div>
        <div v-if="event.error" class="text-red-600 dark:text-red-400">Error: {{ event.error }}</div>
      </div>
    </div>
  </div>
</template>
