<script setup lang="ts">
import { computed } from "vue";
import { DanxButton, DanxTabs, DanxTooltip, type DanxTab } from "@thehammer/danx-ui";
import { useTheme } from "../composables/useTheme";
import { useAuth } from "../composables/useAuth";
import type { RepoInfo } from "../api";

export type TabId = "dispatches" | "issues" | "agents" | "settings";

const props = defineProps<{
  connected: boolean;
  eventCount: number;
  repos: RepoInfo[];
  selectedRepo: string;
  activeTab: TabId;
  refreshing?: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
  "update:selectedRepo": [value: string];
  "update:activeTab": [value: TabId];
}>();

const { isDark, toggleTheme } = useTheme();
const { currentUser, logout } = useAuth();

async function onLogout(): Promise<void> {
  await logout();
}

const tabs = computed<DanxTab[]>(() => [
  { value: "dispatches", label: "Dispatches", count: props.eventCount },
  { value: "issues", label: "Issues" },
  { value: "agents", label: "Agents" },
  { value: "settings", label: "Settings" },
]);

const activeTabModel = computed<string>({
  get: () => props.activeTab,
  set: (v) => emit("update:activeTab", v as TabId),
});
</script>

<template>
  <header class="mb-6 flex items-center gap-12 border-b border-gray-200 dark:border-gray-700 pb-2">
    <div class="shrink-0 flex items-baseline gap-3">
      <h1 class="text-base font-semibold text-gray-900 dark:text-white leading-tight">Danxbot Dashboard</h1>
      <p class="text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">
        <span :class="connected ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'">●</span>
        {{ connected ? 'Connected' : 'Disconnected' }}
      </p>
    </div>

    <DanxTabs v-model="activeTabModel" :tabs="tabs" class="self-end" />

    <div class="flex items-center gap-2 ml-auto shrink-0">
      <span
        v-if="currentUser"
        data-test="current-user"
        class="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        <span class="hidden sm:inline">{{ currentUser.username }}</span>
      </span>

      <select
        v-if="repos.length > 1 && (activeTab === 'dispatches' || activeTab === 'issues' || activeTab === 'settings' || activeTab === 'agents')"
        :value="selectedRepo"
        class="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm text-gray-600 dark:text-gray-300 border-0 outline-none cursor-pointer"
        @change="emit('update:selectedRepo', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="activeTab === 'dispatches' || activeTab === 'issues'" value="">All repos</option>
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

      <DanxTooltip tooltip="Refresh">
        <template #trigger>
          <DanxButton
            size="sm"
            icon="refresh"
            aria-label="Refresh"
            :disabled="refreshing"
            :class="{ 'refresh-spinning': refreshing }"
            @click="emit('refresh')"
          />
        </template>
      </DanxTooltip>

      <DanxTooltip v-if="currentUser" tooltip="Log out">
        <template #trigger>
          <DanxButton
            size="sm"
            variant="danger"
            icon="cancel"
            aria-label="Log out"
            data-test="logout-button"
            @click="onLogout"
          />
        </template>
      </DanxTooltip>
    </div>
  </header>
</template>

<style scoped>
.refresh-spinning :deep(svg) {
  animation: dx-spin 0.8s linear infinite;
}
@keyframes dx-spin {
  to { transform: rotate(360deg); }
}
</style>
