<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { DanxButton, DanxDialog, useDialog } from "@thehammer/danx-ui";
import {
  fetchAgentRoster,
  patchAgentDefaults,
  resetAllData,
  type ResetAllDataResult,
  type RepoInfo,
  type ToggleError,
} from "../api";
import { useAgents } from "../composables/useAgents";
import RepoCard from "./agents/RepoCard.vue";
import type { Feature } from "../types";

/**
 * DX-159 Phase 1: Settings is now a per-repo page. The previous "Agents"
 * tab iterated every connected repo and rendered RepoCards inline; that
 * UI moved here, scoped to the operator's currently-selected repo. The
 * new Agents tab (sibling component) hosts the agent roster CRUD —
 * Phase 1 ships the empty-state stub.
 *
 * The Danger Zone (global Reset All Data) lives below the per-repo
 * section. Reset is a global operation regardless of repo, so it
 * doesn't move into per-repo handling.
 */

const props = defineProps<{
  selectedRepo: string;
  repos: RepoInfo[];
}>();

const {
  agents,
  loading: agentsLoading,
  error: agentsError,
  toggle,
  clearCriticalFailure,
  saveIssuePrefix,
  refresh: refreshAgents,
} = useAgents();

// The single repo this page renders. Empty `selectedRepo` falls back to
// the first configured repo so the page is never blank when only one
// repo exists (or when the operator hasn't picked yet). Watch keeps the
// pick in sync with the dropdown selection.
const activeRepoName = computed<string>(() => {
  if (props.selectedRepo) return props.selectedRepo;
  return props.repos[0]?.name ?? "";
});

const activeAgent = computed(() =>
  agents.value.find((a) => a.name === activeRepoName.value) ?? null,
);

// Per-feature busy state — disables the toggle while PATCH is in flight.
const busyFeature = ref<Feature | null>(null);
const clearingCriticalFailure = ref<boolean>(false);
const savingIssuePrefix = ref<boolean>(false);

async function onToggle(
  repo: string,
  feature: Feature,
  enabled: boolean | null,
): Promise<void> {
  busyFeature.value = feature;
  try {
    await toggle(repo, feature, enabled);
  } finally {
    busyFeature.value = null;
  }
}

async function onClearCriticalFailure(repo: string): Promise<void> {
  clearingCriticalFailure.value = true;
  try {
    await clearCriticalFailure(repo);
  } finally {
    clearingCriticalFailure.value = false;
  }
}

async function onSaveIssuePrefix(repo: string, prefix: string): Promise<void> {
  savingIssuePrefix.value = true;
  try {
    await saveIssuePrefix(repo, prefix);
  } finally {
    savingIssuePrefix.value = false;
  }
}

// agentDefaults.conflictCheckEnabled — fetched per-repo on mount + when
// the selection changes. Round-trips through PATCH /api/agents-settings.
const conflictCheckEnabled = ref<boolean>(true);
const conflictCheckLoading = ref<boolean>(false);
const conflictCheckSaving = ref<boolean>(false);
const conflictCheckError = ref<string | null>(null);

async function loadConflictCheck(): Promise<void> {
  if (!activeRepoName.value) return;
  conflictCheckLoading.value = true;
  conflictCheckError.value = null;
  try {
    const roster = await fetchAgentRoster(activeRepoName.value);
    conflictCheckEnabled.value = roster.settings.conflictCheckEnabled;
  } catch (err) {
    conflictCheckError.value = (err as Error).message;
  } finally {
    conflictCheckLoading.value = false;
  }
}

async function onConflictCheckChange(next: boolean): Promise<void> {
  if (!activeRepoName.value) return;
  const prev = conflictCheckEnabled.value;
  conflictCheckEnabled.value = next;
  conflictCheckSaving.value = true;
  conflictCheckError.value = null;
  try {
    const result = await patchAgentDefaults(activeRepoName.value, next);
    conflictCheckEnabled.value = result.settings.conflictCheckEnabled;
  } catch (err) {
    conflictCheckEnabled.value = prev;
    const te = err as ToggleError;
    conflictCheckError.value =
      te?.serverMessage ?? te?.message ?? "Save failed.";
  } finally {
    conflictCheckSaving.value = false;
  }
}

onMounted(() => void loadConflictCheck());
watch(activeRepoName, () => void loadConflictCheck());

// ── Danger Zone (global) ─────────────────────────────────────────────
const { isOpen, open, close } = useDialog();
const saving = ref(false);
const result = ref<ResetAllDataResult | null>(null);
const errorMessage = ref<string | null>(null);

async function onConfirmReset(): Promise<void> {
  saving.value = true;
  errorMessage.value = null;
  try {
    result.value = await resetAllData();
    close();
  } catch (err) {
    errorMessage.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

function dismissResult(): void {
  result.value = null;
}
</script>

<template>
  <div class="max-w-5xl">
    <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">
      Settings — {{ activeRepoName || "(no repo selected)" }}
    </h2>

    <section v-if="!activeRepoName" class="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-900 dark:text-amber-200 mb-6">
      No repo selected. Pick one from the repo switcher to configure its feature toggles.
    </section>

    <section v-else class="space-y-4 mb-6">
      <div
        v-if="agentsError"
        class="rounded-md border border-red-400 bg-red-50 dark:bg-red-900/20 dark:border-red-600 p-3 text-sm text-red-700 dark:text-red-300"
      >
        {{ agentsError }}
        <button type="button" class="ml-2 underline" @click="refreshAgents">retry</button>
      </div>

      <div
        v-if="!activeAgent && agentsLoading"
        class="text-gray-500 dark:text-gray-400 text-sm"
      >
        Loading {{ activeRepoName }}…
      </div>

      <div
        v-else-if="!activeAgent"
        class="rounded-md border border-gray-300 bg-gray-50 dark:bg-gray-800 dark:border-gray-700 p-3 text-sm text-gray-600 dark:text-gray-300"
      >
        Repo "{{ activeRepoName }}" is not currently visible to the dashboard. The worker may be down, or the REPOS env var may need updating.
      </div>

      <RepoCard
        v-else
        :agent="activeAgent"
        :busy-feature="busyFeature"
        :clearing-critical-failure="clearingCriticalFailure"
        :saving-issue-prefix="savingIssuePrefix"
        @toggle="onToggle"
        @clear-critical-failure="onClearCriticalFailure"
        @save-issue-prefix="onSaveIssuePrefix"
      />

      <article
        class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
        data-test="conflict-check-card"
      >
        <header class="mb-2 flex items-center justify-between">
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white">
              Multi-worker conflict check
            </h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Run a triage-precursor LLM call before each issue-worker dispatch when other agents are working, to flag overlapping file edits before code is generated. Disable to skip the extra call (cost-sensitive ops).
            </p>
          </div>
          <label
            class="relative inline-flex items-center cursor-pointer"
            :class="{ 'opacity-60 cursor-wait': conflictCheckLoading || conflictCheckSaving }"
          >
            <input
              type="checkbox"
              class="sr-only peer"
              :checked="conflictCheckEnabled"
              :disabled="conflictCheckLoading || conflictCheckSaving"
              data-test="conflict-check-toggle"
              @change="onConflictCheckChange(($event.target as HTMLInputElement).checked)"
            />
            <div class="w-11 h-6 bg-gray-300 peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
          </label>
        </header>
        <p
          v-if="conflictCheckError"
          class="mt-2 text-xs text-red-600 dark:text-red-400"
        >
          {{ conflictCheckError }}
        </p>
      </article>
    </section>

    <section
      class="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5"
      data-test="danger-zone"
    >
      <h3 class="text-base font-semibold text-red-800 dark:text-red-200">
        Danger zone
      </h3>
      <p class="mt-1 text-sm text-red-900 dark:text-red-200">
        Wipe operational data (dispatches, Slack threads, health checks).
        Users and API tokens are preserved — you stay logged in.
      </p>
      <div class="mt-4">
        <DanxButton
          type="danger"
          icon="trash"
          data-test="reset-data-open"
          @click="open"
        >
          Reset all data
        </DanxButton>
      </div>

      <div
        v-if="result"
        data-test="reset-data-success"
        class="mt-4 rounded border border-green-400 dark:border-green-700 bg-green-50 dark:bg-green-900/30 px-3 py-2 text-sm text-green-900 dark:text-green-100 flex items-start justify-between gap-3"
      >
        <div>
          <div class="font-medium">
            Reset complete — {{ result.rowsDeleted }} row(s) deleted.
          </div>
          <ul class="mt-1 text-xs list-disc list-inside">
            <li v-for="table in result.tablesCleared" :key="table">
              {{ table }}: {{ result.perTable[table] ?? 0 }}
            </li>
          </ul>
        </div>
        <button
          type="button"
          class="text-green-900 dark:text-green-100 hover:opacity-70"
          aria-label="Dismiss"
          @click="dismissResult"
        >
          ✕
        </button>
      </div>
    </section>

    <DanxDialog
      v-model="isOpen"
      title="Reset all data?"
      subtitle="This cannot be undone."
      :persistent="saving"
      close-button="Cancel"
      confirm-button="Reset everything"
      :is-saving="saving"
      @confirm="onConfirmReset"
      @close="close"
    >
      <div class="space-y-3 text-sm">
        <p>
          The following tables will be <strong>truncated</strong>:
        </p>
        <ul class="list-disc list-inside text-red-800 dark:text-red-300">
          <li><code>dispatches</code> — all job history</li>
          <li><code>threads</code> — Slack thread continuation state</li>
          <li><code>health_check</code></li>
        </ul>
        <p>
          These tables are preserved so login continues to work:
          <code>users</code>, <code>api_tokens</code>.
        </p>
        <p
          v-if="errorMessage"
          data-test="reset-data-error"
          class="rounded bg-red-100 dark:bg-red-900/40 px-3 py-2 text-red-900 dark:text-red-100"
        >
          {{ errorMessage }}
        </p>
      </div>
    </DanxDialog>
  </div>
</template>
