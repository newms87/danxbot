<script setup lang="ts">
import { computed } from "vue";
import type { Dispatch } from "../types";
import TriggerBadge from "./TriggerBadge.vue";
import StatusBadge from "./StatusBadge.vue";

const props = defineProps<{
  dispatches: Dispatch[];
  loading: boolean;
}>();

defineEmits<{ select: [dispatch: Dispatch] }>();

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(11, 19);
}

function formatDuration(d: Dispatch): string {
  const end = d.completedAt ?? Date.now();
  const secs = Math.max(0, Math.floor((end - d.startedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function summaryContext(d: Dispatch): string {
  switch (d.trigger) {
    case "slack": {
      const m = d.triggerMetadata as { userName: string | null; user: string };
      return m.userName || m.user;
    }
    case "trello": {
      const m = d.triggerMetadata as { cardName: string };
      return m.cardName;
    }
    case "api": {
      const m = d.triggerMetadata as { endpoint: string };
      return m.endpoint;
    }
  }
}

const hasDispatches = computed(() => props.dispatches.length > 0);
</script>

<template>
  <div class="overflow-x-auto border border-slate-800 rounded-lg">
    <table class="w-full text-[12.5px] border-collapse">
      <thead>
        <tr class="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
          <th class="p-3 whitespace-nowrap">Started</th>
          <th class="p-3 whitespace-nowrap">Job</th>
          <th class="p-3 whitespace-nowrap">Trigger</th>
          <th class="p-3 whitespace-nowrap">Repo</th>
          <th class="p-3 whitespace-nowrap">Summary</th>
          <th class="p-3 whitespace-nowrap">Status</th>
          <th class="p-3 text-right whitespace-nowrap">Duration</th>
          <th class="p-3 text-right whitespace-nowrap">Tools</th>
          <th class="p-3 text-right whitespace-nowrap">Sub-ag</th>
          <th class="p-3 text-right whitespace-nowrap">Tok total</th>
          <th class="p-3 text-right whitespace-nowrap">Tok in</th>
          <th class="p-3 text-right whitespace-nowrap">Tok out</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading && !hasDispatches" class="text-slate-500">
          <td class="p-6 text-center" colspan="12">Loading…</td>
        </tr>
        <tr v-else-if="!hasDispatches" class="text-slate-500">
          <td class="p-6 text-center" colspan="12">No dispatches yet.</td>
        </tr>
        <tr
          v-for="d in dispatches"
          :key="d.id"
          class="border-b border-slate-800/50 hover:bg-slate-800/20 cursor-pointer"
          @click="$emit('select', d)"
        >
          <td class="p-3 font-mono whitespace-nowrap">
            <div class="text-[11px] text-slate-400">{{ formatDate(d.startedAt) }}</div>
            <div class="text-slate-200">{{ formatTime(d.startedAt) }}</div>
          </td>
          <td class="p-3 font-mono text-slate-300 whitespace-nowrap" :title="d.id">{{ d.id.slice(0, 8) }}</td>
          <td class="p-3"><TriggerBadge :trigger="d.trigger" /></td>
          <td class="p-3 text-slate-400">{{ d.repoName }}</td>
          <td class="p-3">
            <div class="text-[11px] text-slate-400">{{ summaryContext(d) }}</div>
            <div class="text-slate-200 font-medium line-clamp-2">
              {{ d.summary || (d.status === 'running' ? 'Running…' : (d.error || '—')) }}
            </div>
          </td>
          <td class="p-3"><StatusBadge :status="d.status" /></td>
          <td class="p-3 text-right font-mono text-slate-300">{{ formatDuration(d) }}</td>
          <td class="p-3 text-right font-mono text-slate-300">{{ d.toolCallCount }}</td>
          <td class="p-3 text-right">
            <span
              class="inline-block min-w-[24px] text-center px-1.5 rounded-full text-[11.5px] font-semibold font-mono"
              :class="d.subagentCount > 0
                ? 'bg-pink-500/20 text-pink-300'
                : 'bg-slate-700/30 text-slate-500 font-normal'"
            >{{ d.subagentCount }}</span>
          </td>
          <td class="p-3 text-right font-mono text-slate-300">{{ d.tokensTotal.toLocaleString() }}</td>
          <td class="p-3 text-right font-mono text-slate-400">{{ d.tokensIn.toLocaleString() }}</td>
          <td class="p-3 text-right font-mono text-slate-400">{{ d.tokensOut.toLocaleString() }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
