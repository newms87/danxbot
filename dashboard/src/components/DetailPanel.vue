<script setup lang="ts">
import type { MessageEvent } from "../types";
import DetailMetadata from "./DetailMetadata.vue";
import DetailResponses from "./DetailResponses.vue";
import DetailTimeline from "./DetailTimeline.vue";
import DetailExpandable from "./DetailExpandable.vue";
import PerfBreakdown from "./PerfBreakdown.vue";
import CostBreakdown from "./CostBreakdown.vue";
import AgentLogTable from "./AgentLogTable.vue";

defineProps<{
  event: MessageEvent;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <div class="mt-4 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300">Message Detail</h3>
      <button class="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-sm" @click="emit('close')">Close</button>
    </div>

    <DetailMetadata :event="event" />
    <DetailResponses :event="event" />
    <DetailTimeline :event="event" />

    <!-- Router API Detail -->
    <DetailExpandable v-if="event.routerRequest" label="Router API Request" class="mt-4">
      <pre class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto max-h-80 overflow-y-auto font-mono">{{ JSON.stringify(event.routerRequest, null, 2) }}</pre>
    </DetailExpandable>

    <DetailExpandable v-if="event.routerRawResponse" label="Router API Response" class="mt-3">
      <pre class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto max-h-80 overflow-y-auto font-mono">{{ JSON.stringify(event.routerRawResponse, null, 2) }}</pre>
    </DetailExpandable>

    <!-- Agent Config -->
    <DetailExpandable v-if="event.agentConfig" label="Agent Config" class="mt-4">
      <div class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-xs text-gray-600 dark:text-gray-400 space-y-1 font-mono">
        <div>Model: <span class="text-gray-800 dark:text-gray-200">{{ (event.agentConfig as Record<string, unknown>).model }}</span></div>
        <div>Tools: <span class="text-gray-800 dark:text-gray-200">{{ ((event.agentConfig as Record<string, unknown>).allowedTools as string[] || []).join(', ') }}</span></div>
        <div>Max Turns: <span class="text-gray-800 dark:text-gray-200">{{ (event.agentConfig as Record<string, unknown>).maxTurns }}</span></div>
        <div>Max Budget: <span class="text-gray-800 dark:text-gray-200">${{ (event.agentConfig as Record<string, unknown>).maxBudgetUsd }}</span></div>
        <div>CWD: <span class="text-gray-800 dark:text-gray-200">{{ (event.agentConfig as Record<string, unknown>).cwd }}</span></div>
        <div v-if="(event.agentConfig as Record<string, unknown>).resume">
          Resumed Session: <span class="text-green-700 dark:text-green-300">{{ (event.agentConfig as Record<string, unknown>).resume }}</span>
        </div>
      </div>
      <DetailExpandable v-if="(event.agentConfig as Record<string, unknown>).systemPrompt" label="System Prompt" class="mt-2">
        <pre class="bg-gray-100 dark:bg-gray-800 rounded p-3 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto max-h-64 overflow-y-auto font-mono whitespace-pre-wrap">{{ (event.agentConfig as Record<string, unknown>).systemPrompt }}</pre>
      </DetailExpandable>
    </DetailExpandable>

    <!-- Performance Breakdown -->
    <DetailExpandable v-if="event.agentLog?.length" label="Performance Breakdown" class="mt-4">
      <PerfBreakdown :event="event" />
    </DetailExpandable>

    <!-- Cost Breakdown -->
    <DetailExpandable v-if="event.apiCalls?.length || event.agentUsage" label="Cost Breakdown" class="mt-4">
      <CostBreakdown :event="event" />
    </DetailExpandable>

    <!-- Agent Conversation Log -->
    <DetailExpandable v-if="event.agentLog?.length" :label="`Agent Conversation Log (${event.agentLog.length} entries)`" class="mt-4">
      <AgentLogTable :log="event.agentLog" />
    </DetailExpandable>
  </div>
</template>
