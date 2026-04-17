<script setup lang="ts">
import { onMounted, ref } from "vue";
import DashboardHeader from "./components/DashboardHeader.vue";
import { fetchRepos, type RepoInfo } from "./api";

const repos = ref<RepoInfo[]>([]);
const selectedRepo = ref<string>("");

onMounted(async () => {
  repos.value = await fetchRepos();
});
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 py-6">
    <DashboardHeader
      v-model:selected-repo="selectedRepo"
      :connected="false"
      :event-count="0"
      :repos="repos"
      @refresh="() => {}"
    />

    <div class="mt-8 text-center text-sm text-slate-500 dark:text-slate-400">
      Dispatch history is being rebuilt. Check back after the next deploy.
    </div>
  </div>
</template>
