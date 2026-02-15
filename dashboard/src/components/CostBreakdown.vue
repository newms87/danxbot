<script setup lang="ts">
import type { MessageEvent } from "../types";

defineProps<{
  event: MessageEvent;
}>();

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtCost(n: number): string {
  return "$" + n.toFixed(6);
}
</script>

<template>
  <div class="space-y-4">
    <!-- API Costs -->
    <div v-if="event.apiCalls?.length">
      <div class="flex items-baseline gap-2 mb-2">
        <span class="text-xs font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wide">API Costs</span>
        <span class="text-xs text-gray-500">{{ fmtCost(event.apiCostUsd ?? 0) }} total</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-left text-gray-500 uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
              <th class="px-2 py-1">Source</th>
              <th class="px-2 py-1">Model</th>
              <th class="px-2 py-1 text-right">In</th>
              <th class="px-2 py-1 text-right">Out</th>
              <th class="px-2 py-1 text-right">Cache W</th>
              <th class="px-2 py-1 text-right">Cache R</th>
              <th class="px-2 py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody class="text-gray-700 dark:text-gray-300">
            <tr v-for="(call, i) in event.apiCalls" :key="i" class="border-b border-gray-100 dark:border-gray-800/50">
              <td class="px-2 py-1 capitalize">{{ call.source }}</td>
              <td class="px-2 py-1 font-mono text-[11px]">{{ call.model.replace('claude-', '').replace('-20251001', '') }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(call.inputTokens) }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(call.outputTokens) }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(call.cacheCreationInputTokens) }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(call.cacheReadInputTokens) }}</td>
              <td class="px-2 py-1 text-right font-medium">{{ fmtCost(call.costUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Subscription Costs (Agent Usage) -->
    <div v-if="event.agentUsage">
      <div class="flex items-baseline gap-2 mb-2">
        <span class="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">Subscription Costs</span>
        <span class="text-xs text-gray-500">{{ fmtCost(event.agentUsage.totalCostUsd) }} total</span>
      </div>

      <!-- Aggregate stats -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-xs text-gray-600 dark:text-gray-400">
        <div>Input: <span class="text-gray-800 dark:text-gray-200 font-medium">{{ fmt(event.agentUsage.inputTokens) }}</span></div>
        <div>Output: <span class="text-gray-800 dark:text-gray-200 font-medium">{{ fmt(event.agentUsage.outputTokens) }}</span></div>
        <div>Cache Read: <span class="text-gray-800 dark:text-gray-200 font-medium">{{ fmt(event.agentUsage.cacheReadInputTokens) }}</span></div>
        <div>Cache Write: <span class="text-gray-800 dark:text-gray-200 font-medium">{{ fmt(event.agentUsage.cacheCreationInputTokens) }}</span></div>
      </div>

      <!-- Per-model breakdown -->
      <div v-if="Object.keys(event.agentUsage.modelUsage).length" class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-left text-gray-500 uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
              <th class="px-2 py-1">Model</th>
              <th class="px-2 py-1 text-right">In</th>
              <th class="px-2 py-1 text-right">Out</th>
              <th class="px-2 py-1 text-right">Cache R</th>
              <th class="px-2 py-1 text-right">Cache W</th>
              <th class="px-2 py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody class="text-gray-700 dark:text-gray-300">
            <tr v-for="(mu, model) in event.agentUsage.modelUsage" :key="model" class="border-b border-gray-100 dark:border-gray-800/50">
              <td class="px-2 py-1 font-mono text-[11px]">{{ String(model).replace('claude-', '') }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(mu.inputTokens) }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(mu.outputTokens) }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(mu.cacheReadInputTokens) }}</td>
              <td class="px-2 py-1 text-right">{{ fmt(mu.cacheCreationInputTokens) }}</td>
              <td class="px-2 py-1 text-right font-medium">{{ fmtCost(mu.costUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Duration info -->
      <div class="mt-2 text-xs text-gray-500">
        Duration: {{ (event.agentUsage.durationMs / 1000).toFixed(1) }}s
        (API: {{ (event.agentUsage.durationApiMs / 1000).toFixed(1) }}s)
        &middot; {{ event.agentUsage.numTurns }} turns
      </div>
    </div>

    <!-- No cost data -->
    <div v-if="!event.apiCalls?.length && !event.agentUsage" class="text-xs text-gray-400">
      No cost data available for this event.
    </div>
  </div>
</template>
