<script setup lang="ts">
import type { ParsedLogEntry } from "../types";
import RouterCard from "./conversation/RouterCard.vue";
import SystemInitCard from "./conversation/SystemInitCard.vue";
import AssistantCard from "./conversation/AssistantCard.vue";
import ToolResultCard from "./conversation/ToolResultCard.vue";
import ToolProgressCard from "./conversation/ToolProgressCard.vue";
import ResultCard from "./conversation/ResultCard.vue";
import ErrorCard from "./conversation/ErrorCard.vue";
import HeartbeatCard from "./conversation/HeartbeatCard.vue";

defineProps<{
  entries: ParsedLogEntry[];
}>();
</script>

<template>
  <div class="space-y-2">
    <template v-for="(entry, idx) in entries" :key="idx">
      <RouterCard v-if="entry.type === 'router'" :entry="entry" />
      <SystemInitCard v-else-if="entry.type === 'system_init'" :entry="entry" />
      <AssistantCard v-else-if="entry.type === 'assistant'" :entry="entry" />
      <ToolResultCard v-else-if="entry.type === 'tool_result'" :entry="entry" />
      <ToolProgressCard v-else-if="entry.type === 'tool_progress'" :entry="entry" />
      <ResultCard v-else-if="entry.type === 'result'" :entry="entry" />
      <ErrorCard v-else-if="entry.type === 'error'" :entry="entry" />
      <HeartbeatCard v-else-if="entry.type === 'heartbeat'" :entry="entry" />
    </template>
  </div>
</template>
