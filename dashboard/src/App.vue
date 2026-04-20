<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import DashboardHeader, { type TabId } from "./components/DashboardHeader.vue";
import DispatchList from "./components/DispatchList.vue";
import DispatchFilters from "./components/DispatchFilters.vue";
import DispatchDetail from "./components/DispatchDetail.vue";
import AgentsPage from "./components/agents/AgentsPage.vue";
import { useDispatches } from "./composables/useDispatches";
import { fetchRepos, type RepoInfo } from "./api";
import type { Dispatch } from "./types";

const repos = ref<RepoInfo[]>([]);
const selectedDispatch = ref<Dispatch | null>(null);
const activeTab = ref<TabId>("dispatches");

const {
  dispatches,
  loading,
  selectedRepo,
  selectedTrigger,
  selectedStatus,
  searchQuery,
  refresh,
  init,
  destroy,
} = useDispatches();

onMounted(async () => {
  repos.value = await fetchRepos();
  init();
});
onUnmounted(destroy);

function selectDispatch(d: Dispatch): void {
  selectedDispatch.value = d;
}
</script>

<template>
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
