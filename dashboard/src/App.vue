<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import DashboardHeader, { type TabId } from "./components/DashboardHeader.vue";
import DispatchList from "./components/DispatchList.vue";
import DispatchFilters from "./components/DispatchFilters.vue";
import DispatchDetail from "./components/DispatchDetail.vue";
import AgentsPage from "./components/agents/AgentsPage.vue";
import Login from "./components/auth/Login.vue";
import { useDispatches } from "./composables/useDispatches";
import { useAuth } from "./composables/useAuth";
import { fetchRepos, type RepoInfo } from "./api";
import type { Dispatch } from "./types";

const { currentUser, init, handleExpired } = useAuth();

const repos = ref<RepoInfo[]>([]);
const selectedDispatch = ref<Dispatch | null>(null);
const activeTab = ref<TabId>("dispatches");
const authReady = ref(false);

const {
  dispatches,
  loading,
  selectedRepo,
  selectedTrigger,
  selectedStatus,
  searchQuery,
  refresh,
  init: initDispatches,
  destroy,
} = useDispatches();

/**
 * Central 401 handler: `api.ts::fetchWithAuth` dispatches `auth:expired`
 * on any 401. Drop local auth state, which flips `currentUser` to null
 * and re-renders Login. The event-based wiring keeps `api.ts` free of
 * direct references to the App component tree.
 */
function onAuthExpired(): void {
  handleExpired();
  selectedDispatch.value = null;
  destroy();
}

async function loadDashboard(): Promise<void> {
  try {
    repos.value = await fetchRepos();
  } catch {
    // Likely a 401 — `fetchWithAuth` already fired `auth:expired`, which
    // the listener above handles by clearing state.
    return;
  }
  initDispatches();
}

onMounted(async () => {
  window.addEventListener("auth:expired", onAuthExpired);
  await init();
  authReady.value = true;
});

onUnmounted(() => {
  window.removeEventListener("auth:expired", onAuthExpired);
  destroy();
});

// Drive dashboard loading off a single source of truth. `immediate: true`
// covers the warm-token reload path (currentUser becomes non-null inside
// `init()`); successful logins later in the session trigger the same
// transition. This is the ONLY site that reacts to `currentUser` flipping
// truthy, so `loadDashboard` never double-fires.
watch(
  currentUser,
  async (user, prev) => {
    if (user && !prev) await loadDashboard();
  },
  { immediate: true },
);

function selectDispatch(d: Dispatch): void {
  selectedDispatch.value = d;
}
</script>

<template>
  <template v-if="!authReady">
    <!-- Blank frame while init() resolves; prevents a Login flash on a valid warm token. -->
    <div class="min-h-screen" />
  </template>
  <template v-else-if="!currentUser">
    <Login />
  </template>
  <template v-else>
    <div class="max-w-[1400px] mx-auto px-4 py-6">
      <DashboardHeader
        v-model:selected-repo="selectedRepo"
        v-model:active-tab="activeTab"
        :connected="true"
        :event-count="dispatches.length"
        :repos="repos"
        @refresh="refresh"
      />

      <template v-if="activeTab === 'dispatches'">
        <DispatchFilters
          v-model:selected-repo="selectedRepo"
          v-model:selected-trigger="selectedTrigger"
          v-model:selected-status="selectedStatus"
          v-model:search-query="searchQuery"
          :repos="repos"
        />

        <DispatchList
          :dispatches="dispatches"
          :loading="loading"
          @select="selectDispatch"
        />

        <DispatchDetail
          v-if="selectedDispatch"
          :dispatch="selectedDispatch"
          @close="selectedDispatch = null"
        />
      </template>

      <AgentsPage v-else-if="activeTab === 'agents'" />
    </div>
  </template>
</template>
