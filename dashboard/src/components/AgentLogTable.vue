<script setup lang="ts">
import { reactive } from "vue";
import type { AgentLogEntry } from "../types";
import { relativeTime } from "../utils/format";
import { logTypeBadge } from "../utils/status";

defineProps<{
  log: AgentLogEntry[];
}>();

const expandedRows: Record<number, boolean> = reactive({});

function toggleRow(idx: number) {
  expandedRows[idx] = !expandedRows[idx];
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-xs">
      <thead>
        <tr class="text-left text-gray-500 uppercase border-b border-gray-300 dark:border-gray-700">
          <th class="px-2 py-1.5 w-20">Time</th>
          <th class="px-2 py-1.5 w-24">Type</th>
          <th class="px-2 py-1.5">Summary</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="(entry, idx) in log" :key="idx">
          <tr
            class="border-b border-gray-100 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 cursor-pointer"
            @click="toggleRow(idx)"
          >
            <td class="px-2 py-1.5 text-gray-500 font-mono whitespace-nowrap">
              +{{ relativeTime(entry.timestamp, log[0].timestamp) }}s
            </td>
            <td class="px-2 py-1.5">
              <span :class="logTypeBadge(entry.type)" class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium">
                {{ entry.type }}{{ entry.subtype ? '.' + entry.subtype : '' }}
              </span>
            </td>
            <td class="px-2 py-1.5 text-gray-700 dark:text-gray-300 truncate max-w-lg">
              {{ entry.summary }}
            </td>
          </tr>
          <tr v-if="expandedRows[idx]">
            <td colspan="3" class="px-2 py-2">
              <pre class="bg-gray-100 dark:bg-gray-800 rounded p-2 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto max-h-64 overflow-y-auto font-mono">{{ JSON.stringify(entry.data, null, 2) }}</pre>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
