<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import DashboardHeader from "./components/DashboardHeader.vue";
import DispatchList from "./components/DispatchList.vue";
import DispatchFilters from "./components/DispatchFilters.vue";
import { useDispatches } from "./composables/useDispatches";
import { fetchRepos, type RepoInfo } from "./api";
import type { Dispatch } from "./types";

const repos = ref<RepoInfo[]>([]);
const selectedDispatch = ref<Dispatch | null>(null);

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
      :connected="true"
      :event-count="dispatches.length"
      :repos="repos"
      @refresh="refresh"
    />

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

    <div
      v-if="selectedDispatch"
      class="fixed right-0 top-0 h-full w-[520px] bg-slate-900 border-l border-slate-800 shadow-2xl overflow-auto p-6 z-50"
    >
      <div class="flex justify-between items-start mb-4">
        <h2 class="text-lg font-bold text-slate-100">
          Dispatch {{ selectedDispatch.id.slice(0, 8) }}
        </h2>
        <button
          class="text-slate-500 hover:text-slate-200"
          @click="selectedDispatch = null"
        >✕</button>
      </div>
      <pre class="text-xs text-slate-300 whitespace-pre-wrap">{{ JSON.stringify(selectedDispatch, null, 2) }}</pre>
      <p class="text-xs text-slate-500 mt-4">
        Full detail view arrives in Phase 6.
      </p>
    </div>
  </div>
</template>
