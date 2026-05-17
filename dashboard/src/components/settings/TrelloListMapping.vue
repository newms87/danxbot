<script setup lang="ts">
/**
 * DX-611 (Phase 8b.3 of DX-575) — Settings tab "Trello list mapping"
 * section. Renders the per-repo map between danxbot lists (the stable
 * `lists.yaml` ids the dashboard surface elsewhere) and the Trello
 * board's lists. Mounted by `SettingsPage.vue` only when the repo's
 * `trello.yml` carries a `board_id` (the panel hides itself entirely
 * via the `board_configured` flag from the GET response).
 *
 * Data flow:
 *   useTrelloListMapping(repo) → SSE-fed `mapping` snapshot
 *   ↓ per-row dropdown picks a Trello list id
 *   ↓ Save click PATCHes the merged map; server publishes SSE so other
 *     tabs reconcile without polling
 *   ↓ Re-fetch button calls fetchTrelloBoardLists with refresh=true to
 *     bypass the server's 30s cache when Trello state changed off-band
 *
 * Per `.claude/rules/dashboard.md`: DanxUI primitives only, no native
 * `title=` (DanxTooltip with #trigger slot is the only hover-popover
 * mechanism); no `setInterval` calling into `api.ts` — the panel is
 * SSE-driven end-to-end through `useTrelloListMapping`.
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DanxButton,
  DanxSelect,
  DanxTooltip,
  type SelectOption,
} from "@thehammer/danx-ui";
import { useListColors } from "../../composables/useListColors";
import { useTrelloListMapping } from "../../composables/useTrelloListMapping";
import type {
  ClassifiedTrelloMapping,
  TrelloListMap,
  TrelloListSummary,
} from "../../types";

const props = defineProps<{
  repo: string;
}>();

const { lists: danxbotLists, colorFor } = useListColors(props.repo);

const {
  mapping,
  boardLists,
  loading,
  saving,
  error,
  init,
  destroy,
  refresh,
  refetchBoardLists,
  save,
} = useTrelloListMapping(props.repo);

onMounted(() => init());
onBeforeUnmount(() => destroy());

// Re-key wire state when the operator switches repos. The parent's
// `:key="repo"` already remounts the panel, so this watch is
// defense-in-depth (matches the ListsManager pattern).
watch(
  () => props.repo,
  (next, prev) => {
    if (next === prev) return;
    destroy();
    init();
  },
);

/**
 * Local edit buffer: maps a danxbot list id to the operator's pending
 * Trello-list selection. Empty string represents "unmapped" (the
 * select's no-mapping option). Seeded from `mapping.value.map` and
 * reset whenever the server snapshot changes.
 */
const draft = ref<Record<string, string>>({});

/**
 * Tracks whether the operator has typed into ANY row since the last
 * server snapshot was applied. `isDirty` (the Save-button enable
 * predicate) compares draft vs server values; this flag is the
 * SEPARATE "has there been an operator edit" signal used to gate
 * the SSE-driven re-seed. Without separation, the empty initial
 * draft would compare unequal to the server's populated map and
 * the watcher would skip the very first seed (reviewer S2 fix).
 */
const operatorEdited = ref<boolean>(false);

function seedDraftFromMapping(): void {
  const fromServer: Record<string, string> = {};
  const inner = mapping.value?.map.list_id_to_trello_list_id ?? {};
  for (const [k, v] of Object.entries(inner)) fromServer[k] = v;
  draft.value = fromServer;
  operatorEdited.value = false;
}

const isDirty = computed<boolean>(() => {
  const server = mapping.value?.map.list_id_to_trello_list_id ?? {};
  const keys = new Set([
    ...Object.keys(server),
    ...Object.keys(draft.value).filter((k) => draft.value[k] !== ""),
  ]);
  for (const k of keys) {
    const s = server[k] ?? "";
    const d = draft.value[k] ?? "";
    if (s !== d) return true;
  }
  return false;
});

/**
 * Re-seed `draft` from the server snapshot WHEN no operator edits are
 * outstanding. Behavior table:
 *  - First mount: operatorEdited = false → seed.
 *  - Operator's own save: `save()` resets `operatorEdited` after the
 *    composable replaces `mapping.value.map`; the watcher then seeds
 *    against the round-tripped shape.
 *  - SSE arrives while operator is mid-edit (another tab edited):
 *    operatorEdited = true → SKIP re-seed; operator's pending
 *    selections survive. Badge / classification fields may briefly
 *    disagree with the dropdown until the operator saves; clicking
 *    Save then publishes ON TOP of the other tab's write
 *    (last-writer-wins, matches the agent-vs-poller contract).
 *
 * Without this guard, every concurrent edit silently wiped the
 * operator's in-progress selection (reviewer S2).
 */
watch(
  () => mapping.value?.map,
  () => {
    if (operatorEdited.value) return;
    seedDraftFromMapping();
  },
  { immediate: true, deep: true },
);

const orderedRows = computed<
  Array<{ id: string; name: string; color: string; cls: ClassifiedTrelloMapping }>
>(() => {
  const cls = mapping.value?.classification ?? {};
  // Order = danxbot lists.yaml order (the source of truth for column
  // ordering); fall back to whatever appears in `classification` if a
  // newly seeded list hasn't propagated to useListColors yet.
  const seen = new Set<string>();
  const out: Array<{
    id: string;
    name: string;
    color: string;
    cls: ClassifiedTrelloMapping;
  }> = [];
  for (const l of danxbotLists.value) {
    const c = cls[l.id];
    if (!c) continue;
    out.push({ id: l.id, name: l.name, color: l.color, cls: c });
    seen.add(l.id);
  }
  for (const [id, c] of Object.entries(cls)) {
    if (seen.has(id)) continue;
    out.push({ id, name: id, color: colorFor(id), cls: c });
  }
  return out;
});

const trelloOptions = computed<TrelloListSummary[]>(() => boardLists.value);

/**
 * Per-row DanxSelect option list. The leading "(unmapped)" sentinel
 * with `value: ""` matches the draft semantics (empty string = no
 * mapping); orphaned rows append a synthetic "(dead) <id>" so the
 * operator can see what the map currently points at even though the
 * Trello list is gone.
 */
function selectOptionsFor(rowId: string, orphanId?: string): SelectOption[] {
  const opts: SelectOption[] = [{ value: "", label: "(unmapped)" }];
  for (const o of trelloOptions.value) {
    opts.push({ value: o.id, label: o.name });
  }
  if (orphanId && !trelloOptions.value.find((o) => o.id === orphanId)) {
    opts.push({ value: orphanId, label: `(dead) ${orphanId}` });
  }
  return opts;
}

function onSelectChange(rowId: string, value: unknown): void {
  // DanxSelect emits SelectModelValue (string | number | array | null);
  // this panel is single-select with string values only.
  if (typeof value === "string") onChangeRow(rowId, value);
  else if (value === null) onChangeRow(rowId, "");
}

function rowDirty(id: string): boolean {
  const s = mapping.value?.map.list_id_to_trello_list_id[id] ?? "";
  const d = draft.value[id] ?? "";
  return s !== d;
}

function onChangeRow(id: string, value: string): void {
  draft.value = { ...draft.value, [id]: value };
  operatorEdited.value = true;
}

async function onSave(): Promise<void> {
  if (saving.value || !isDirty.value) return;
  const next: TrelloListMap = {
    list_id_to_trello_list_id: Object.fromEntries(
      Object.entries(draft.value).filter(([, v]) => v.length > 0),
    ),
  };
  try {
    await save(next);
    // Composable replaced mapping.value.map with the round-tripped shape;
    // re-seed `draft` so the dirty marker clears and Save re-disables.
    seedDraftFromMapping();
  } catch {
    /* error.value already populated by the composable */
  }
}

async function onRefetch(): Promise<void> {
  await refetchBoardLists();
}

function focusRowSelect(id: string): void {
  const el = document.querySelector<HTMLSelectElement>(
    `[data-test="trello-select-${id}"]`,
  );
  el?.focus();
}

const showPanel = computed<boolean>(() => {
  return mapping.value !== null && mapping.value.board_configured === true;
});
</script>

<template>
  <section
    v-if="showPanel"
    class="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
    data-test="trello-list-mapping"
  >
    <header class="mb-3 flex items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">
          Trello list mapping
        </h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Pair each danxbot list with a Trello list on the configured board.
          Cards on unmapped or orphaned lists are skipped at outbound push
          time with a one-line warning (not agent-blocking).
        </p>
      </div>
      <DanxButton
        size="sm"
        type="secondary"
        :disabled="loading || saving"
        data-test="trello-refetch"
        @click="onRefetch"
      >
        Re-fetch board lists
      </DanxButton>
    </header>

    <div
      v-if="error"
      class="mb-3 flex items-center gap-2 rounded-md border border-red-400 bg-red-50 dark:bg-red-900/20 dark:border-red-600 p-3 text-sm text-red-700 dark:text-red-300"
      data-test="trello-error"
    >
      <span>{{ error }}</span>
      <DanxButton size="sm" type="secondary" @click="refresh">retry</DanxButton>
    </div>

    <div
      v-if="mapping && !mapping.trello_available"
      class="mb-3 rounded-md border border-amber-400 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-600 p-3 text-sm text-amber-800 dark:text-amber-200"
      data-test="trello-unreachable"
    >
      Trello is unreachable. Showing the last-known board snapshot —
      orphaned rows may resolve when Trello comes back.
    </div>

    <div
      v-if="orderedRows.length === 0"
      class="text-sm text-gray-500 dark:text-gray-400"
      data-test="trello-empty"
    >
      Add a danxbot list first — there is nothing to map until at least
      one list exists in this repo.
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="row in orderedRows"
        :key="row.id"
        class="flex flex-wrap items-center gap-3 rounded-md border border-gray-100 dark:border-gray-700 p-2"
        :data-test="`trello-row-${row.id}`"
      >
        <span
          class="inline-block h-3 w-3 rounded-sm border border-gray-300 dark:border-gray-600"
          :style="{ backgroundColor: row.color }"
          aria-hidden="true"
        />
        <span class="min-w-[140px] flex-1 text-xs font-mono text-gray-900 dark:text-gray-100">
          {{ row.name }}
        </span>

        <div
          class="min-w-[180px]"
          :data-test="`trello-select-${row.id}`"
        >
          <DanxSelect
            :model-value="draft[row.id] ?? ''"
            :options="selectOptionsFor(row.id, row.cls.trello_list_id)"
            :disabled="saving"
            :clearable="false"
            filterable
            @update:model-value="(v) => onSelectChange(row.id, v)"
          />
        </div>

        <template v-if="row.cls.status === 'mapped'">
          <span
            class="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
            :data-test="`trello-badge-${row.id}`"
            data-status="mapped"
          >
            Mapped
          </span>
        </template>
        <template v-else-if="row.cls.status === 'unmapped'">
          <DanxTooltip
            tooltip="Outbound push skipped for cards on this list until a Trello list is paired."
          >
            <template #trigger>
              <span
                class="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                :data-test="`trello-badge-${row.id}`"
                data-status="unmapped"
              >
                Unmapped — outbound push skipped
              </span>
            </template>
          </DanxTooltip>
        </template>
        <template v-else>
          <DanxTooltip
            tooltip="The paired Trello list was deleted on the board. Re-pick to restore the outbound push."
          >
            <template #trigger>
              <span
                class="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                :data-test="`trello-badge-${row.id}`"
                data-status="orphaned"
              >
                Orphaned — Trello list deleted
              </span>
            </template>
          </DanxTooltip>
          <DanxButton
            size="sm"
            type="secondary"
            :disabled="saving"
            :data-test="`trello-repick-${row.id}`"
            @click="focusRowSelect(row.id)"
          >
            Re-pick
          </DanxButton>
        </template>

        <span
          v-if="rowDirty(row.id)"
          class="text-[11px] text-amber-700 dark:text-amber-300"
          :data-test="`trello-row-dirty-${row.id}`"
        >
          •
        </span>
      </li>
    </ul>

    <footer class="mt-4 flex items-center justify-end gap-2">
      <DanxButton
        :disabled="!isDirty || saving"
        :is-saving="saving"
        data-test="trello-save"
        @click="onSave"
      >
        Save mapping
      </DanxButton>
    </footer>
  </section>
</template>
