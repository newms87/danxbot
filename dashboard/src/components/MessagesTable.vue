<script setup lang="ts">
import type { MessageEvent } from "../types";
import { formatTime, formatMs } from "../utils/format";
import { statusClass, statusLabel } from "../utils/status";

defineProps<{
  filteredEvents: MessageEvent[];
  totalCount: number;
}>();

const searchQuery = defineModel<string>("searchQuery", { required: true });
const statusFilter = defineModel<string>("statusFilter", { required: true });

const emit = defineEmits<{
  select: [event: MessageEvent];
}>();
</script>

<template>
  <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-3 flex-wrap">
      <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300">
        Messages
        <span v-if="filteredEvents.length !== totalCount" class="font-normal text-gray-400 dark:text-gray-500 ml-1">
          ({{ filteredEvents.length }} of {{ totalCount }})
        </span>
      </h2>
      <div class="flex items-center gap-2">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search messages..."
          class="px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 w-48 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <select
          v-model="statusFilter"
          class="px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="all">All Statuses</option>
          <option value="complete">Complete</option>
          <option value="error">Error</option>
          <option value="agent_running">Agent Running</option>
          <option value="router_only">Router Only</option>
        </select>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-200 dark:border-gray-800">
            <th class="px-4 py-2">Status</th>
            <th class="px-4 py-2">Time</th>
            <th class="px-4 py-2">User</th>
            <th class="px-4 py-2">Message</th>
            <th class="px-4 py-2">Thread</th>
            <th class="px-4 py-2">Router</th>
            <th class="px-4 py-2">Agent</th>
            <th class="px-4 py-2">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="event in filteredEvents"
            :key="event.id"
            class="border-b border-gray-100 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer"
            @click="emit('select', event)"
          >
            <td class="px-4 py-2.5">
              <span :class="statusClass(event.status)" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium">
                {{ statusLabel(event.status) }}
              </span>
            </td>
            <td class="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {{ formatTime(event.receivedAt) }}
            </td>
            <td class="px-4 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">
              {{ event.userName || event.user }}
            </td>
            <td class="px-4 py-2.5 text-gray-800 dark:text-gray-200 max-w-xs truncate">
              {{ event.text }}
            </td>
            <td class="px-4 py-2.5 text-gray-400 dark:text-gray-500 font-mono text-xs whitespace-nowrap">
              {{ event.threadTs }}
            </td>
            <td class="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
              <template v-if="event.routerResponseAt">
                {{ formatMs(event.routerResponseAt - event.receivedAt) }}
                <span v-if="event.routerNeedsAgent && event.routerComplexity === 'very_low'" class="text-green-600 dark:text-green-400 ml-1">⚡VL</span>
                <span v-else-if="event.routerNeedsAgent && event.routerComplexity === 'low'" class="text-green-600 dark:text-green-400 ml-1">⚡L</span>
                <span v-else-if="event.routerNeedsAgent && event.routerComplexity === 'medium'" class="text-yellow-600 dark:text-yellow-400 ml-1">→ M</span>
                <span v-else-if="event.routerNeedsAgent && event.routerComplexity === 'high'" class="text-purple-600 dark:text-purple-400 ml-1">→ H</span>
                <span v-else-if="event.routerNeedsAgent && event.routerComplexity === 'very_high'" class="text-red-600 dark:text-red-400 ml-1">→ VH</span>
                <span v-else-if="event.routerNeedsAgent" class="text-purple-600 dark:text-purple-400 ml-1">→ agent</span>
              </template>
              <span v-else-if="event.status === 'routing'" class="text-yellow-600 dark:text-yellow-400">...</span>
            </td>
            <td class="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
              <template v-if="event.agentResponseAt">
                {{ formatMs(event.agentResponseAt - (event.routerResponseAt ?? event.receivedAt)) }}
                <span class="text-gray-400 dark:text-gray-600 ml-1">({{ event.agentTurns }}t)</span>
              </template>
              <span v-else-if="event.status === 'agent_running'" class="text-purple-600 dark:text-purple-400">...</span>
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap">
              <div class="flex flex-col gap-0.5">
                <span v-if="event.apiCostUsd != null" class="text-orange-600 dark:text-orange-400 text-xs">
                  ${{ event.apiCostUsd.toFixed(4) }} <span class="text-[10px] opacity-60">API</span>
                </span>
                <span v-if="event.subscriptionCostUsd != null" class="text-blue-600 dark:text-blue-400 text-xs">
                  ${{ event.subscriptionCostUsd.toFixed(4) }} <span class="text-[10px] opacity-60">Sub</span>
                </span>
              </div>
            </td>
          </tr>
          <tr v-if="filteredEvents.length === 0">
            <td colspan="8" class="px-4 py-8 text-center text-gray-400 dark:text-gray-600">
              <template v-if="totalCount === 0">No messages yet. Events will appear here when agents process messages.</template>
              <template v-else>No messages match your filters.</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
