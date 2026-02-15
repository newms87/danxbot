<script setup lang="ts">
import type { AnalyticsSummary } from "../types";
import { formatMs } from "../utils/format";

defineProps<{
  analytics: AnalyticsSummary;
}>();
</script>

<template>
  <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
    <div class="bg-white dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
      <div class="text-xs text-gray-500 uppercase tracking-wide">Total</div>
      <div class="text-2xl font-bold text-gray-900 dark:text-white mt-1">{{ analytics.totalMessages }}</div>
    </div>
    <div class="bg-white dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
      <div class="text-xs text-gray-500 uppercase tracking-wide">Router Only</div>
      <div class="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{{ analytics.routerOnlyMessages }}</div>
      <div class="text-xs text-gray-500 mt-1">avg {{ formatMs(analytics.avgRouterTimeMs) }}</div>
    </div>
    <div class="bg-white dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
      <div class="text-xs text-gray-500 uppercase tracking-wide">Agent</div>
      <div class="text-2xl font-bold text-purple-600 dark:text-purple-400 mt-1">{{ analytics.agentMessages }}</div>
      <div class="text-xs text-gray-500 mt-1">avg {{ formatMs(analytics.avgAgentTimeMs) }}</div>
    </div>
    <div class="bg-white dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
      <div class="text-xs text-gray-500 uppercase tracking-wide">Avg Total</div>
      <div class="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{{ formatMs(analytics.avgTotalTimeMs) }}</div>
    </div>
    <div class="bg-white dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
      <div class="text-xs text-gray-500 uppercase tracking-wide">Total Cost</div>
      <div class="text-2xl font-bold text-yellow-600 dark:text-yellow-400 mt-1">${{ analytics.totalCostUsd?.toFixed(4) || '0.0000' }}</div>
      <div class="text-xs text-gray-500 mt-1">{{ analytics.errorCount }} errors</div>
    </div>
    <div class="bg-white dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
      <div class="text-xs text-gray-500 uppercase tracking-wide">Feedback</div>
      <div class="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
        👍 {{ analytics.feedbackPositive || 0 }} · 👎 {{ analytics.feedbackNegative || 0 }}
      </div>
      <div class="text-xs text-gray-500 mt-1">{{ ((analytics.feedbackRate || 0) * 100).toFixed(0) }}% rate</div>
    </div>
  </div>
</template>
