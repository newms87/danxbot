<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { fetchAgentRoster } from "../../api";
import type {
  AgentRecordWithName,
  AgentRosterResponse,
  RepoInfo,
} from "../../types";

/**
 * DX-159 Phase 1 — empty Agents tab stub.
 *
 * The previous "Agents" tab content (per-repo env-toggles aggregation
 * for every connected repo) moved to the Settings tab and is now
 * scoped to the operator's currently-selected repo. The Agents tab is
 * the new home for the multi-worker agent CRUD UI; Phase 1 only ships
 * the empty-state shell. Phase 2 (DX-160) lands creation, edit,
 * avatar upload, schedule editor, and delete.
 *
 * The component still calls `GET /api/agents?repo=<name>` so the typed
 * fetch wrapper has a real consumer in Phase 1 — and so the empty
 * state surfaces "0 agents" via the same code path that will render
 * the real roster in Phase 2.
 */

const props = defineProps<{
  selectedRepo: string;
  repos: RepoInfo[];
}>();

const activeRepoName = computed<string>(() => {
  if (props.selectedRepo) return props.selectedRepo;
  return props.repos[0]?.name ?? "";
});

const roster = ref<AgentRecordWithName[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);

async function loadRoster(): Promise<void> {
  if (!activeRepoName.value) {
    roster.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const body: AgentRosterResponse = await fetchAgentRoster(activeRepoName.value);
    roster.value = body.agents;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => void loadRoster());
watch(activeRepoName, () => void loadRoster());
</script>

<template>
  <section class="max-w-5xl">
    <header class="mb-4 flex items-start justify-between">
      <div>
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
          Agents — {{ activeRepoName || "(no repo selected)" }}
        </h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Named workers (Alice, Bob, …) with bios, schedules, capabilities, and persistent worktrees. Each agent serves one dispatch at a time across enabled types (issue-worker / Slack / API).
        </p>
      </div>
      <span
        class="inline-flex"
        title="Coming in Phase 2"
        data-test="new-agent-tooltip"
      >
        <button
          type="button"
          class="rounded-md bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-3 py-1.5 text-sm font-medium cursor-not-allowed"
          disabled
          data-test="new-agent-button"
        >
          + New Agent
        </button>
      </span>
    </header>

    <div
      v-if="error"
      class="rounded-md border border-red-400 bg-red-50 dark:bg-red-900/20 dark:border-red-600 p-3 text-sm text-red-700 dark:text-red-300 mb-4"
    >
      {{ error }}
      <button type="button" class="ml-2 underline" @click="loadRoster">retry</button>
    </div>

    <div
      v-if="loading"
      class="text-gray-500 dark:text-gray-400 text-sm"
    >
      Loading agents…
    </div>

    <div
      v-else-if="!activeRepoName"
      class="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-900 dark:text-amber-200"
    >
      No repo selected. Pick one from the repo switcher.
    </div>

    <div
      v-else-if="!roster.length"
      data-test="agents-empty-state"
      class="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800/50 p-8 text-center"
    >
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        No agents yet
      </h3>
      <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
        Phase 2 will add the CRUD UI. For now the schema is in place — see
        <code class="text-xs">{{ "<repo>/.danxbot/settings.json#agents" }}</code>.
      </p>
    </div>

    <div v-else class="grid grid-cols-1 gap-4">
      <article
        v-for="agent in roster"
        :key="agent.name"
        class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
      >
        <header class="flex items-start justify-between">
          <div>
            <h3 class="text-base font-bold text-gray-900 dark:text-white">{{ agent.name }}</h3>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ agent.capabilities.join(", ") }} · {{ agent.schedule.tz }}
            </p>
          </div>
          <span
            class="text-xs rounded-full px-2 py-0.5"
            :class="agent.enabled
              ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
              : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'"
          >
            {{ agent.enabled ? "enabled" : "disabled" }}
          </span>
        </header>
        <p class="mt-2 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{{ agent.bio }}</p>
      </article>
    </div>
  </section>
</template>
