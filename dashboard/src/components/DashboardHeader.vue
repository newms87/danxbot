<script setup lang="ts">
import { useTheme } from "../composables/useTheme";
import type { RepoInfo } from "../api";

export type TabId = "dispatches" | "agents";

defineProps<{
  connected: boolean;
  eventCount: number;
  repos: RepoInfo[];
  selectedRepo: string;
  activeTab: TabId;
}>();

const emit = defineEmits<{
  refresh: [];
  "update:selectedRepo": [value: string];
  "update:activeTab": [value: TabId];
}>();

const { isDark, toggleTheme } = useTheme();
</script>

<template>
  <div class="mb-8">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Danxbot Dashboard</h1>
        <p class="text-gray-500 dark:text-gray-400 text-sm mt-1">
          <span :class="connected ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'">●</span>
          {{ connected ? 'Connected' : 'Disconnected' }}
          <span v-if="activeTab === 'dispatches'"> · {{ eventCount }} dispatches tracked</span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <select
          v-if="repos.length > 1 && activeTab === 'dispatches'"
          :value="selectedRepo"
          class="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm text-gray-600 dark:text-gray-300 border-0 outline-none cursor-pointer"
          @change="emit('update:selectedRepo', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">All repos</option>
          <option v-for="repo in repos" :key="repo.name" :value="repo.name">
            {{ repo.name }}
          </option>
        </select>
        <button
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          class="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm text-gray-600 dark:text-gray-300"
          @click="toggleTheme"
        >
          {{ isDark ? '☀️' : '🌙' }}
        </button>
        <button
          class="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm text-gray-600 dark:text-gray-300"
          @click="emit('refresh')"
        >
          Refresh
        </button>
      </div>
    </div>

    <nav class="mt-5 border-b border-gray-200 dark:border-gray-700 flex gap-1" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'dispatches'"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'dispatches'
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'"
        @click="emit('update:activeTab', 'dispatches')"
      >
        Dispatches
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'agents'"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'agents'
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'"
        @click="emit('update:activeTab', 'agents')"
      >
        Agents
      </button>
    </nav>
  </div>
</template>
