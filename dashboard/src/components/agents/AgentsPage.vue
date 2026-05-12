<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  clearAgentBroken,
  createAgent,
  deleteAgent,
  fetchAgentRoster,
  updateAgent,
  uploadAgentAvatar,
  type AgentCreateInput,
  type AgentUpdateInput,
  type ToggleError,
} from "../../api";
import type {
  AgentRosterEntry,
  AgentRosterResponse,
  AgentSchedule,
  RepoInfo,
} from "../../types";
import { useStream } from "../../composables/useStream";
import AgentCard from "./AgentCard.vue";
import AgentEditDrawer from "./AgentEditDrawer.vue";
import AgentDeleteModal from "./AgentDeleteModal.vue";
import AgentResolveModal from "./AgentResolveModal.vue";

/**
 * DX-160 Phase 2 — Agents tab CRUD UI.
 *
 * Hosts the per-repo agent roster grid + Edit drawer + Delete modal.
 * The component owns the local roster state, the API plumbing, and
 * the optimistic concurrency surface. Server is the source of truth —
 * every mutation re-loads the roster on success so the cap counter
 * stays honest after a 5th create.
 *
 * Phase 1 shipped the empty-state stub via the same `fetchAgentRoster`
 * API; this phase replaces the empty body but keeps the wire shape.
 */

const props = defineProps<{
  selectedRepo: string;
  repos: RepoInfo[];
}>();

const activeRepoName = computed<string>(() => {
  if (props.selectedRepo) return props.selectedRepo;
  return props.repos[0]?.name ?? "";
});

const AGENT_LIMIT = 5;

const roster = ref<AgentRosterEntry[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);

// Edit drawer state. `null` when closed; `{agent: null}` for create
// mode; `{agent: <record>}` for edit mode. Wrapping the agent in an
// object distinguishes "drawer closed" from "drawer open in create
// mode" without tri-state booleans.
interface DrawerState {
  agent: AgentRosterEntry | null;
}
const drawer = ref<DrawerState | null>(null);
const drawerBusy = ref(false);
const drawerError = ref<string | null>(null);

// Delete modal state.
const deleteTarget = ref<AgentRosterEntry | null>(null);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);

// DX-298 — Mark Resolved modal state. The dashboard cannot SET broken;
// the only legal write is the null clear via `clearAgentBroken`. SSE
// `agent:updated` will also push the cleared snapshot to every other
// connected client.
const resolveTarget = ref<AgentRosterEntry | null>(null);
const resolveBusy = ref(false);
const resolveError = ref<string | null>(null);

const atCap = computed(() => roster.value.length >= AGENT_LIMIT);
const newButtonDisabled = computed(() => atCap.value || !activeRepoName.value);
const newButtonTitle = computed(() =>
  atCap.value ? "5-agent limit reached" : "",
);

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

/**
 * DX-164 Phase 6 — busy state via SSE only.
 *
 * The SSE subscription on `dispatch:created` / `dispatch:updated`
 * triggers a roster refresh on every dispatch lifecycle event for THIS
 * repo — the worker stamps `agent_name` at dispatch start, so the very
 * first `dispatch:created` event after a poller pick lands the green
 * dot within milliseconds. Per-card elapsed-time animation is driven by
 * `AgentCard.vue`'s 60s local tick — no roster re-fetch needed for
 * cosmetic time updates. See `.claude/rules/dashboard.md` "Real-time
 * Updates Are Mandatory".
 */
let stream: ReturnType<typeof useStream> | null = null;
let unsubscribers: Array<() => void> = [];

function attachLiveBusy(): void {
  detachLiveBusy();
  stream = useStream();
  // Both topics fire on dispatch-state transitions for any repo. Both
  // payloads carry `repoName` so per-repo subscribers can filter
  // symmetrically (`dispatch:updated` was extended in DX-164 Phase 6
  // to include the field — the worker already had it on the dispatch
  // row at finalize time). Unrelated repos' dispatches are ignored.
  const matchesActiveRepo = (event: { data: unknown }): boolean => {
    const data = event.data as { repoName?: string } | null | undefined;
    return !!data?.repoName && data.repoName === activeRepoName.value;
  };
  const onEvent = (event: { data: unknown }): void => {
    if (matchesActiveRepo(event)) void loadRoster();
  };
  unsubscribers.push(stream.subscribe("dispatch:created", onEvent));
  unsubscribers.push(stream.subscribe("dispatch:updated", onEvent));
  // DX-298 — Agents tab live-updates when an agent's `broken` field
  // flips. The worker publishes `agent:updated` on every agents-side
  // mutation (toggle, broken stamp/clear, CRUD); the payload is the
  // full snapshot so `loadRoster` is the cheapest reconciliation. The
  // snapshot carries `repoName` (explicit alias of `name`) so this
  // filter reads symmetrically with the dispatch subscription above —
  // both check `data.repoName`. See `agents-list.ts` AgentSnapshot.
  unsubscribers.push(
    stream.subscribe("agent:updated", (event) => {
      if (matchesActiveRepo(event)) void loadRoster();
    }),
  );
}
function detachLiveBusy(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  stream?.disconnect();
  stream = null;
}

onMounted(() => {
  void loadRoster();
  attachLiveBusy();
});
onBeforeUnmount(detachLiveBusy);
watch(activeRepoName, () => {
  drawer.value = null;
  deleteTarget.value = null;
  void loadRoster();
});

function openCreate(): void {
  if (newButtonDisabled.value) return;
  drawerError.value = null;
  drawer.value = { agent: null };
}

function openEdit(agent: AgentRosterEntry): void {
  drawerError.value = null;
  drawer.value = { agent };
}

function closeDrawer(): void {
  drawer.value = null;
  drawerError.value = null;
  drawerBusy.value = false;
}

async function onSubmit(input: {
  name: string;
  bio: string;
  capabilities: string[];
  schedule: AgentSchedule;
  enabled: boolean;
  avatarFile: File | null;
}): Promise<void> {
  if (!drawer.value) return;
  const isCreate = drawer.value.agent === null;
  drawerBusy.value = true;
  drawerError.value = null;
  try {
    let saved: AgentRosterEntry;
    if (isCreate) {
      const create: AgentCreateInput = {
        name: input.name,
        bio: input.bio,
        capabilities: input.capabilities,
        schedule: input.schedule,
        enabled: input.enabled,
      };
      saved = await createAgent(activeRepoName.value, create);
    } else {
      const update: AgentUpdateInput = {
        bio: input.bio,
        capabilities: input.capabilities,
        schedule: input.schedule,
        enabled: input.enabled,
      };
      saved = await updateAgent(
        activeRepoName.value,
        drawer.value.agent!.name,
        update,
      );
    }
    if (input.avatarFile) {
      saved = await uploadAgentAvatar(
        activeRepoName.value,
        saved.name,
        input.avatarFile,
      );
    }
    // Replace or append in-place so the grid updates without a full
    // refetch (and a full refetch follows below to reconcile any
    // server-side normalization).
    const idx = roster.value.findIndex((a) => a.name === saved.name);
    if (idx === -1) roster.value = [...roster.value, saved];
    else
      roster.value = [
        ...roster.value.slice(0, idx),
        saved,
        ...roster.value.slice(idx + 1),
      ];
    closeDrawer();
    await loadRoster();
  } catch (err) {
    const te = err as ToggleError;
    drawerError.value = te?.serverMessage ?? te?.message ?? "Save failed.";
  } finally {
    drawerBusy.value = false;
  }
}

function askDelete(agent: AgentRosterEntry): void {
  deleteError.value = null;
  deleteTarget.value = agent;
}

function cancelDelete(): void {
  deleteTarget.value = null;
  deleteError.value = null;
  deleteBusy.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleteBusy.value = true;
  deleteError.value = null;
  try {
    await deleteAgent(activeRepoName.value, deleteTarget.value.name);
    roster.value = roster.value.filter(
      (a) => a.name !== deleteTarget.value!.name,
    );
    cancelDelete();
    await loadRoster();
  } catch (err) {
    const te = err as ToggleError;
    deleteError.value = te?.serverMessage ?? te?.message ?? "Delete failed.";
  } finally {
    deleteBusy.value = false;
  }
}

// DX-298 — Mark Resolved flow. The card emits `resolve`; we open the
// confirmation modal so the operator confirms env-was-fixed (the clear
// is irreversible). On confirm we PATCH `{broken: null}`; the server
// publishes `agent:updated` which triggers `loadRoster` everywhere.
function askResolve(agent: AgentRosterEntry): void {
  resolveError.value = null;
  resolveTarget.value = agent;
}

function cancelResolve(): void {
  resolveTarget.value = null;
  resolveError.value = null;
  resolveBusy.value = false;
}

async function confirmResolve(): Promise<void> {
  if (!resolveTarget.value) return;
  resolveBusy.value = true;
  resolveError.value = null;
  try {
    const cleared = await clearAgentBroken(
      activeRepoName.value,
      resolveTarget.value.name,
    );
    const idx = roster.value.findIndex((a) => a.name === cleared.name);
    if (idx !== -1) {
      const next = [...roster.value];
      // `clearAgentBroken` returns the bare `AgentRecordWithName`; the
      // roster carries the enriched `AgentRosterEntry` with `busyOn`,
      // so preserve the existing `busyOn` field while swapping in the
      // cleared `broken: null`. SSE will reconcile via `loadRoster()`
      // a moment later regardless.
      next[idx] = { ...next[idx], ...cleared };
      roster.value = next;
    }
    cancelResolve();
    await loadRoster();
  } catch (err) {
    const te = err as ToggleError;
    resolveError.value =
      te?.serverMessage ?? te?.message ?? "Mark Resolved failed.";
  } finally {
    resolveBusy.value = false;
  }
}
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
        <p
          class="mt-1 text-xs text-gray-400 dark:text-gray-500"
          data-test="agent-count"
        >
          {{ roster.length }} / {{ AGENT_LIMIT }} agents
        </p>
      </div>
      <span
        class="inline-flex"
        :title="newButtonTitle"
        data-test="new-agent-tooltip"
      >
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium"
          :class="
            newButtonDisabled
              ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
          "
          :disabled="newButtonDisabled"
          data-test="new-agent-button"
          @click="openCreate"
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
        Click <strong>+ New Agent</strong> above to create one. Names become git branches and worktree directories — keep them URL/branch/path-safe.
      </p>
    </div>

    <div
      v-else
      class="grid grid-cols-1 md:grid-cols-2 gap-4"
      data-test="agents-grid"
    >
      <AgentCard
        v-for="agent in roster"
        :key="agent.name"
        :agent="agent"
        :repo="activeRepoName"
        @edit="openEdit"
        @delete="askDelete"
        @resolve="askResolve"
      />
    </div>

    <AgentEditDrawer
      v-if="drawer"
      :agent="drawer.agent"
      :repo="activeRepoName"
      :busy="drawerBusy"
      :error="drawerError"
      @cancel="closeDrawer"
      @submit="onSubmit"
    />

    <AgentDeleteModal
      v-if="deleteTarget"
      :agent="deleteTarget"
      :busy="deleteBusy"
      :error="deleteError"
      @cancel="cancelDelete"
      @confirm="confirmDelete"
    />

    <AgentResolveModal
      v-if="resolveTarget"
      :agent="resolveTarget"
      :busy="resolveBusy"
      :error="resolveError"
      @cancel="cancelResolve"
      @confirm="confirmResolve"
    />
  </section>
</template>
