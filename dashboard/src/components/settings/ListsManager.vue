<script setup lang="ts">
/**
 * DX-603 — Settings tab "Lists" section. CRUD over the per-repo list
 * taxonomy that DX-602's REST surface backs and that DX-575's epic
 * defines as the operator-visible column taxonomy for the board (Phase
 * 6 / DX-586 consumes this in the dashboard board rewrite — until that
 * lands, the Settings UI is the only consumer plus the future Trello-
 * mapping section).
 *
 * Data flow:
 *   useListColors(repo) → live SSE-fed lists[] + colorFor(name)
 *   ↓ render grouped by semantic type in ladder order
 *   ↓ per-row controls call patchList / createList / deleteList
 *   ↓ server publishes lists:updated on SSE → composable refreshes
 *
 * The composable owns the wire; this component is pure controls + view.
 * No setInterval, no manual refetch beyond the explicit `refresh()` on
 * error retry — matches the `.claude/rules/dashboard.md` SSE-mandate.
 *
 * Reorder semantics (DX-608): arrow buttons call the atomic
 * `POST /api/lists/swap-order` primitive — the server swaps the two
 * `order` integers under its per-repo lock, so there is no transactional
 * gap. SSE reconciles the new state in parallel.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DanxButton,
  DanxColorPicker,
  DanxDialog,
  DanxTooltip,
  useDialog,
} from "@thehammer/danx-ui";
import { createList, deleteList, patchList, swapListOrder } from "../../api";
import { useListColors } from "../../composables/useListColors";
import { LIST_TYPE_LABELS, LIST_TYPE_LADDER } from "../../types";
import type { CreateListInput, List, ListType } from "../../types";

const props = defineProps<{
  repo: string;
}>();

// ── Composable wiring ─────────────────────────────────────────────────

const { lists, loading, error, refresh, init, destroy } = useListColors(
  props.repo,
);

onMounted(() => init());
onBeforeUnmount(() => destroy());

// `useListColors` is per-call; re-mount the composable when the operator
// switches repos. The parent (SettingsPage) recreates this component via
// `:key="repo"` so this watch is defense-in-depth.
watch(
  () => props.repo,
  (next, prev) => {
    if (next === prev) return;
    destroy();
    init();
  },
);

// ── Derived view: grouped + ordered by ladder ─────────────────────────

interface GroupedSection {
  type: ListType;
  label: string;
  items: List[];
}

const grouped = computed<GroupedSection[]>(() => {
  const all = lists.value ?? [];
  const sections: GroupedSection[] = [];
  for (const type of LIST_TYPE_LADDER) {
    const items = all
      .filter((l) => l.type === type)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    sections.push({ type, label: LIST_TYPE_LABELS[type], items });
  }
  return sections;
});

// ── Per-row mutation state ────────────────────────────────────────────

const busyById = ref<Set<string>>(new Set());
const rowErrors = ref<Map<string, string>>(new Map());

function markBusy(id: string): void {
  busyById.value = new Set([...busyById.value, id]);
}
function clearBusy(id: string): void {
  const next = new Set(busyById.value);
  next.delete(id);
  busyById.value = next;
}
function setRowError(id: string, message: string | null): void {
  const next = new Map(rowErrors.value);
  if (message === null) next.delete(id);
  else next.set(id, message);
  rowErrors.value = next;
}

async function runPatch(
  id: string,
  patch: Parameters<typeof patchList>[2],
): Promise<void> {
  if (busyById.value.has(id)) return;
  markBusy(id);
  setRowError(id, null);
  try {
    await patchList(props.repo, id, patch);
  } catch (err) {
    setRowError(
      id,
      err instanceof Error ? err.message : "Update failed",
    );
  } finally {
    clearBusy(id);
  }
}

// ── Row actions ───────────────────────────────────────────────────────

function onRename(list: List, nextName: string): void {
  const trimmed = nextName.trim();
  if (!trimmed || trimmed === list.name) return;
  void runPatch(list.id, { name: trimmed });
}

function onRecolor(list: List, nextColor: string): void {
  if (nextColor === list.color) return;
  void runPatch(list.id, { color: nextColor });
}

/**
 * Reorder = single atomic call to `POST /api/lists/swap-order` (DX-608).
 * The server swaps the two `order` integers under its per-repo lock,
 * eliminating the client-side paired-PATCH transactional gap that
 * DX-603's earlier implementation had. SSE reconciles in parallel.
 *
 * Row-busy is set on BOTH partners so the operator can't kick a second
 * reorder while the first is in flight; the row error surfaces on the
 * originating row on failure.
 */
async function swapOrder(
  moved: List,
  partner: List,
): Promise<void> {
  if (busyById.value.has(moved.id) || busyById.value.has(partner.id)) return;
  markBusy(moved.id);
  markBusy(partner.id);
  setRowError(moved.id, null);
  try {
    await swapListOrder(props.repo, moved.id, partner.id);
  } catch (err) {
    setRowError(
      moved.id,
      err instanceof Error ? err.message : "Reorder failed",
    );
  } finally {
    clearBusy(moved.id);
    clearBusy(partner.id);
  }
}

async function onMoveUp(list: List, section: GroupedSection): Promise<void> {
  const idx = section.items.findIndex((l) => l.id === list.id);
  if (idx <= 0) return;
  await swapOrder(list, section.items[idx - 1]);
}

async function onMoveDown(list: List, section: GroupedSection): Promise<void> {
  const idx = section.items.findIndex((l) => l.id === list.id);
  if (idx < 0 || idx >= section.items.length - 1) return;
  await swapOrder(list, section.items[idx + 1]);
}

function onPromoteDefault(list: List): void {
  if (list.is_default_for_type) return;
  void runPatch(list.id, { is_default_for_type: true });
}

async function onDelete(list: List): Promise<void> {
  if (busyById.value.has(list.id)) return;
  markBusy(list.id);
  setRowError(list.id, null);
  try {
    await deleteList(props.repo, list.id);
  } catch (err) {
    setRowError(
      list.id,
      err instanceof Error ? err.message : "Delete failed",
    );
  } finally {
    clearBusy(list.id);
  }
}

// ── Add list modal ────────────────────────────────────────────────────

const addDialog = useDialog();
const addType = ref<ListType>("review");
const addName = ref<string>("");
const addColor = ref<string>("#94a3b8");
const addError = ref<string | null>(null);
const addBusy = ref<boolean>(false);

function openAddDialog(type: ListType): void {
  addType.value = type;
  addName.value = "";
  const seed = grouped.value
    .find((s) => s.type === type)
    ?.items.find((l) => l.is_default_for_type);
  addColor.value = seed?.color ?? "#94a3b8";
  addError.value = null;
  addDialog.open();
}

async function onConfirmAdd(): Promise<void> {
  if (addBusy.value) return;
  const name = addName.value.trim();
  if (!name) {
    addError.value = "Name is required.";
    return;
  }
  addBusy.value = true;
  addError.value = null;
  try {
    const input: CreateListInput = {
      type: addType.value,
      name,
      color: addColor.value,
    };
    await createList(props.repo, input);
    addDialog.close();
  } catch (err) {
    addError.value = err instanceof Error ? err.message : "Create failed";
  } finally {
    addBusy.value = false;
  }
}
</script>

<template>
  <section
    class="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
    data-test="lists-manager"
  >
    <header class="mb-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        Lists
      </h3>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Per-repo column taxonomy. Each list belongs to a semantic type;
        every type must have at least one list, with exactly one default.
        Renames, color changes, and reorders propagate to the board view
        (and the Trello mirror, when mapped) via SSE — no refresh needed.
      </p>
    </header>

    <div
      v-if="error"
      class="mb-3 flex items-center gap-2 rounded-md border border-red-400 bg-red-50 dark:bg-red-900/20 dark:border-red-600 p-3 text-sm text-red-700 dark:text-red-300"
      data-test="lists-manager-error"
    >
      <span>{{ error }}</span>
      <DanxButton size="sm" type="secondary" @click="refresh">retry</DanxButton>
    </div>

    <div
      v-if="loading && lists.length === 0"
      class="text-sm text-gray-500 dark:text-gray-400"
      data-test="lists-manager-loading"
    >
      Loading lists…
    </div>

    <div v-else class="space-y-5">
      <section
        v-for="section in grouped"
        :key="section.type"
        class="rounded-md border border-gray-100 dark:border-gray-700 p-3"
        :data-test="`lists-section-${section.type}`"
      >
        <header class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
              {{ section.label }}
            </span>
            <span class="text-[11px] text-gray-400">type: {{ section.type }}</span>
          </div>
          <DanxButton
            size="sm"
            icon="plus"
            :data-test="`lists-add-${section.type}`"
            @click="openAddDialog(section.type)"
          >
            Add list
          </DanxButton>
        </header>

        <ul class="space-y-2">
          <li
            v-for="(list, idx) in section.items"
            :key="list.id"
            class="flex flex-col gap-2 rounded-md border border-gray-100 dark:border-gray-700 p-2"
            :data-test="`lists-row-${list.id}`"
          >
            <div class="flex flex-wrap items-center gap-3">
              <input
                type="text"
                class="min-w-[160px] flex-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 disabled:opacity-50"
                :value="list.name"
                :disabled="busyById.has(list.id)"
                :data-test="`lists-name-${list.id}`"
                @change="(e) => onRename(list, (e.target as HTMLInputElement).value)"
              />

              <DanxColorPicker
                :model-value="list.color"
                :disabled="busyById.has(list.id)"
                :test-id="`lists-color-${list.id}`"
                @update:model-value="(v: string) => onRecolor(list, v)"
              />

              <div class="flex items-center gap-1">
                <DanxButton
                  size="sm"
                  type="secondary"
                  :disabled="idx === 0 || busyById.has(list.id)"
                  :data-test="`lists-up-${list.id}`"
                  @click="onMoveUp(list, section)"
                >
                  ↑
                </DanxButton>
                <DanxButton
                  size="sm"
                  type="secondary"
                  :disabled="idx === section.items.length - 1 || busyById.has(list.id)"
                  :data-test="`lists-down-${list.id}`"
                  @click="onMoveDown(list, section)"
                >
                  ↓
                </DanxButton>
              </div>

              <DanxButton
                size="sm"
                :type="list.is_default_for_type ? 'primary' : 'secondary'"
                :disabled="list.is_default_for_type || busyById.has(list.id)"
                :data-test="`lists-default-${list.id}`"
                @click="onPromoteDefault(list)"
              >
                {{ list.is_default_for_type ? "Default" : "Make default" }}
              </DanxButton>

              <DanxTooltip
                v-if="section.items.length === 1"
                tooltip="Each semantic type must have at least one list."
              >
                <template #trigger>
                  <span>
                    <DanxButton
                      size="sm"
                      type="danger"
                      :disabled="true"
                      :data-test="`lists-delete-${list.id}`"
                    >
                      Delete
                    </DanxButton>
                  </span>
                </template>
              </DanxTooltip>
              <DanxButton
                v-else
                size="sm"
                type="danger"
                :disabled="busyById.has(list.id)"
                :data-test="`lists-delete-${list.id}`"
                @click="onDelete(list)"
              >
                Delete
              </DanxButton>
            </div>

            <p
              v-if="rowErrors.get(list.id)"
              class="text-[11px] text-red-600 dark:text-red-300"
              :data-test="`lists-row-error-${list.id}`"
            >
              {{ rowErrors.get(list.id) }}
            </p>
          </li>
        </ul>
      </section>
    </div>

    <DanxDialog
      v-model="addDialog.isOpen.value"
      :title="`Add ${LIST_TYPE_LABELS[addType]} list`"
      subtitle="Renamable later — pick a name + color now."
      close-button="Cancel"
      confirm-button="Add list"
      :is-saving="addBusy"
      :persistent="addBusy"
      @confirm="onConfirmAdd"
      @close="addDialog.close()"
    >
      <div class="space-y-3">
        <label class="block">
          <span class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Name
          </span>
          <input
            v-model="addName"
            type="text"
            class="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
            placeholder="e.g. Triage"
            data-test="lists-add-name"
          />
        </label>

        <DanxColorPicker
          v-model="addColor"
          label="Color"
          test-id="lists-add-color"
        />

        <p
          v-if="addError"
          class="rounded bg-red-100 dark:bg-red-900/40 px-3 py-2 text-sm text-red-900 dark:text-red-100"
          data-test="lists-add-error"
        >
          {{ addError }}
        </p>
      </div>
    </DanxDialog>
  </section>
</template>
