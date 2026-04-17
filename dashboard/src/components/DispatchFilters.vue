<script setup lang="ts">
import type { DispatchStatus, TriggerType } from "../types";

defineProps<{
  repos: { name: string; url: string }[];
  selectedRepo: string;
  selectedTrigger: TriggerType | "";
  selectedStatus: DispatchStatus | "";
  searchQuery: string;
}>();

const emit = defineEmits<{
  "update:selectedRepo": [value: string];
  "update:selectedTrigger": [value: TriggerType | ""];
  "update:selectedStatus": [value: DispatchStatus | ""];
  "update:searchQuery": [value: string];
}>();

const TRIGGERS: TriggerType[] = ["slack", "trello", "api"];
const STATUSES: DispatchStatus[] = [
  "running",
  "completed",
  "failed",
  "cancelled",
];
</script>

<template>
  <div class="flex flex-wrap gap-2 mb-4 items-center">
    <select
      v-if="repos.length > 1"
      :value="selectedRepo"
      class="px-3 py-1.5 bg-slate-800/60 border border-slate-700 rounded text-sm text-slate-200 outline-none"
      @change="emit('update:selectedRepo', ($event.target as HTMLSelectElement).value)"
    >
      <option value="">All repos</option>
      <option v-for="r in repos" :key="r.name" :value="r.name">{{ r.name }}</option>
    </select>

    <div class="flex gap-1">
      <button
        class="px-3 py-1 rounded-full text-xs border"
        :class="selectedTrigger === '' ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200' : 'bg-slate-800/40 border-slate-700 text-slate-300'"
        @click="emit('update:selectedTrigger', '')"
      >
        All
      </button>
      <button
        v-for="t in TRIGGERS"
        :key="t"
        class="px-3 py-1 rounded-full text-xs border capitalize"
        :class="selectedTrigger === t ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200' : 'bg-slate-800/40 border-slate-700 text-slate-300'"
        @click="emit('update:selectedTrigger', t)"
      >
        {{ t }}
      </button>
    </div>

    <div class="flex gap-1">
      <button
        class="px-3 py-1 rounded-full text-xs border"
        :class="selectedStatus === '' ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200' : 'bg-slate-800/40 border-slate-700 text-slate-300'"
        @click="emit('update:selectedStatus', '')"
      >
        Any status
      </button>
      <button
        v-for="s in STATUSES"
        :key="s"
        class="px-3 py-1 rounded-full text-xs border capitalize"
        :class="selectedStatus === s ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200' : 'bg-slate-800/40 border-slate-700 text-slate-300'"
        @click="emit('update:selectedStatus', s)"
      >
        {{ s }}
      </button>
    </div>

    <input
      :value="searchQuery"
      placeholder="Search summary..."
      class="ml-auto px-3 py-1.5 bg-slate-800/60 border border-slate-700 rounded text-sm text-slate-200 outline-none min-w-[220px]"
      @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>
