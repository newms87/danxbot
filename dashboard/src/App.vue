<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import DashboardHeader, { type TabId } from "./components/DashboardHeader.vue";
import DispatchList from "./components/DispatchList.vue";
import DispatchFilters from "./components/DispatchFilters.vue";
import DispatchDetail from "./components/DispatchDetail.vue";
import SystemErrorsBanner from "./components/SystemErrorsBanner.vue";
import BrokenAgentsBanner from "./components/BrokenAgentsBanner.vue";
import AgentsPage from "./components/agents/AgentsPage.vue";
import IssuesPage from "./components/issues/IssuesPage.vue";
import SelfRepairTab from "./components/self-repair/SelfRepairTab.vue";
import SettingsPage from "./components/SettingsPage.vue";
import Login from "./components/auth/Login.vue";
import { useDispatches } from "./composables/useDispatches";
import { useSystemErrors } from "./composables/useSystemErrors";
import { useAuth } from "./composables/useAuth";
import { fetchRepos, type RepoInfo } from "./api";
import type { Dispatch } from "./types";

const { currentUser, init, handleExpired } = useAuth();

const repos = ref<RepoInfo[]>([]);
const selectedDispatch = ref<Dispatch | null>(null);
const authReady = ref(false);

const VALID_TABS: readonly TabId[] = [
  "dispatches",
  "issues",
  "agents",
  "self-repair",
  "settings",
];

function readUrlTab(): TabId {
  const params = new URLSearchParams(window.location.search);
  const t = params.get("tab");
  return (VALID_TABS as readonly string[]).includes(t ?? "")
    ? (t as TabId)
    : "dispatches";
}

function writeUrlTab(tab: TabId): void {
  const url = new URL(window.location.href);
  if (tab === "dispatches") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  window.history.replaceState({}, "", url.toString());
}

const activeTab = ref<TabId>(readUrlTab());

watch(activeTab, (next) => writeUrlTab(next));

function onPopState(): void {
  activeTab.value = readUrlTab();
}

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

const {
  visible: systemErrors,
  dismiss: dismissSystemError,
  init: initSystemErrors,
  destroy: destroySystemErrors,
} = useSystemErrors();

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
  destroySystemErrors();
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
  void initSystemErrors();
}

onMounted(async () => {
  window.addEventListener("auth:expired", onAuthExpired);
  window.addEventListener("popstate", onPopState);
  await init();
  authReady.value = true;
});

onUnmounted(() => {
  window.removeEventListener("auth:expired", onAuthExpired);
  window.removeEventListener("popstate", onPopState);
  destroy();
  destroySystemErrors();
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

/**
 * DX-164 Phase 6 — handler for the issue-drawer agent badge click.
 * Switching `activeTab` writes the URL via the existing watcher; the
 * AgentsPage already scopes to `selectedRepo` so the agent's roster
 * card is in view on render.
 */
function onOpenAgent(): void {
  activeTab.value = "agents";
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
    <div :class="['w-full px-4 py-6', activeTab === 'issues' ? 'h-screen flex flex-col overflow-hidden' : '']">
      <DashboardHeader
        v-model:selected-repo="selectedRepo"
        v-model:active-tab="activeTab"
        :connected="true"
        :event-count="dispatches.length"
        :repos="repos"
        :refreshing="loading"
        @refresh="refresh"
      />

      <SystemErrorsBanner
        :errors="systemErrors"
        @dismiss="dismissSystemError"
      />

      <!--
        DX-369 (Phase 6 of DX-363) — persistent red banner. Always
        mounted below the header so the banner stays visible across
        every dashboard page. NOT dismissible — auto-clears when the
        composable's broken-agent list goes empty (silence is the
        green state). Clicking "View agent" jumps to the Agents tab
        so the operator can see full dispatch history.
      -->
      <BrokenAgentsBanner @open-agent="onOpenAgent" />

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

      <IssuesPage
        v-else-if="activeTab === 'issues'"
        v-model:selected-repo="selectedRepo"
        class="flex-1 min-h-0"
        @open-agent="onOpenAgent"
      />

      <AgentsPage v-else-if="activeTab === 'agents'" :selected-repo="selectedRepo" :repos="repos" />

      <SelfRepairTab v-else-if="activeTab === 'self-repair'" :selected-repo="selectedRepo" />

      <SettingsPage v-else-if="activeTab === 'settings'" :selected-repo="selectedRepo" :repos="repos" />
    </div>
  </template>
</template>
