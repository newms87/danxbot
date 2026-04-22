<script setup lang="ts">
import { ref } from "vue";
import type { Feature } from "../../types";
import { useAgents } from "../../composables/useAgents";
import RepoCard from "./RepoCard.vue";

const { agents, loading, error, toggle, clearCriticalFailure, refresh } =
  useAgents();

// Track which feature is currently mid-PATCH on each repo, so we can
// disable that specific toggle while it's in flight without freezing the
// rest of the card. Keyed by `<repo>:<feature>` for uniqueness.
const busy = ref<Record<string, Feature | null>>({});
// Per-repo "clearing flag" flag — disables the Clear button while the
// DELETE round-trip is in flight so operators don't double-click.
const clearing = ref<Record<string, boolean>>({});

async function onToggle(
  repo: string,
  feature: Feature,
  enabled: boolean | null,
): Promise<void> {
  busy.value = { ...busy.value, [repo]: feature };
  try {
    await toggle(repo, feature, enabled);
  } finally {
    busy.value = { ...busy.value, [repo]: null };
  }
}

async function onClearCriticalFailure(repo: string): Promise<void> {
  clearing.value = { ...clearing.value, [repo]: true };
  try {
    await clearCriticalFailure(repo);
  } finally {
    clearing.value = { ...clearing.value, [repo]: false };
  }
}
</script>

<template>
  <section>
    <div v-if="error" class="mb-3 rounded-md border border-red-400 bg-red-50 dark:bg-red-900/20 dark:border-red-600 p-3 text-sm text-red-700 dark:text-red-300">
      {{ error }}
      <button type="button" class="ml-2 underline" @click="refresh">retry</button>
    </div>

    <div v-if="!agents.length && loading" class="text-gray-500 dark:text-gray-400 text-sm">
      Loading agents…
    </div>
    <div v-else-if="!agents.length" class="text-gray-500 dark:text-gray-400 text-sm">
      No repos configured. Add entries to the REPOS env var to see agents here.
    </div>

    <div v-else class="grid grid-cols-1 gap-4">
      <RepoCard
        v-for="agent in agents"
        :key="agent.name"
        :agent="agent"
        :busy-feature="busy[agent.name] ?? null"
        :clearing-critical-failure="clearing[agent.name] ?? false"
        @toggle="onToggle"
        @clear-critical-failure="onClearCriticalFailure"
      />
    </div>
  </section>
</template>
