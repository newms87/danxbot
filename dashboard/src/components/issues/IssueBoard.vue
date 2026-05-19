<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { IssueListItem, List } from "../../types";
import BoardColumn from "./BoardColumn.vue";
import { isInScope, type ScopeMode } from "../../composables/useIssueFilters";
import { useCardDrag } from "../../composables/useCardDrag";
import {
  useBoardSort,
  type BoardSortDirection,
  type BoardSortKey,
} from "../../composables/useBoardSort";
import {
  buildDefaultByType,
  groupIssuesByColumns,
  listForIssue,
  orderColumns,
} from "./boardColumns";

/**
 * DX-586 (Phase 6 of DX-575) — list-driven board.
 *
 * Columns are derived from the per-repo `lists.yaml` (parent provides
 * via `lists` prop). Each list is a column; columns are ordered
 * left → right by `LIST_TYPE_LADDER`. Cards are grouped by the type's
 * default list as projected from `deriveStatus(card)` — the raw
 * `IssueListItem.list_name` field is never read (DX-624 / DX-639).
 *
 * DX-693 split this shell out of an 800-line monolith: pure data
 * shaping lives in `./boardColumns.ts` (column ordering, grouping,
 * row building, test ids); the per-column rendering lives in
 * `./BoardColumn.vue`. This shell owns drag / sort state and emits
 * `move` / `reorder` upward to the parent.
 */

const props = defineProps<{
  issues: IssueListItem[];
  repo: string;
  lists: List[];
  showClosed?: boolean;
  scopedEpicId: string | null;
  scopeMode: ScopeMode;
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
  move: [issue: IssueListItem, toList: List];
  reorder: [
    issue: IssueListItem,
    before: IssueListItem | null,
    after: IssueListItem | null,
  ];
}>();

const columns = computed<List[]>(() => orderColumns(props.lists, !!props.showClosed));
const defaultByType = computed(() => buildDefaultByType(props.lists));

const boardSort = useBoardSort();

const cardDrag = useCardDrag<List>({
  onDrop: (issue, _from, to) => emit("move", issue, to),
  onReorder: (issue, before, after) => emit("reorder", issue, before, after),
  // DX-629 — reset column sorts BEFORE drag so drop-slot neighbors are
  // in canonical priority order (a column sorted by `updated_at` would
  // compute meaningless priority decimals for the dropped card).
  // Idempotent on default boards.
  onBeforeDragStart: () => boardSort.resetAllColumns(),
  keyOf: (l) => l.id,
});

const grouped = computed<Record<string, IssueListItem[]>>(() => {
  const result = groupIssuesByColumns(
    props.issues,
    columns.value,
    defaultByType.value,
    !!props.showClosed,
    Date.now(),
  );
  for (const col of columns.value) {
    result[col.name] = boardSort.sortedIssues(col.name, result[col.name] ?? []);
  }
  return result;
});

const collapsed = ref<Record<string, boolean>>({});

watch(
  columns,
  (next) => {
    const merged: Record<string, boolean> = {};
    for (const col of next) {
      merged[col.name] = collapsed.value[col.name] ?? false;
    }
    collapsed.value = merged;
  },
  { immediate: true },
);

const sortMenuOpen = ref<Record<string, boolean>>({});

function setSort(
  colName: string,
  key: BoardSortKey,
  direction: BoardSortDirection,
): void {
  boardSort.setSort(colName, { key, direction });
  sortMenuOpen.value = { ...sortMenuOpen.value, [colName]: false };
}

function setSortMenuOpen(colName: string, open: boolean): void {
  sortMenuOpen.value = { ...sortMenuOpen.value, [colName]: open };
}

const requiresHumanCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const [key, list] of Object.entries(grouped.value)) {
    out[key] = list.filter((i) => i.requires_human !== null).length;
  }
  return out;
});

function dimmedFor(i: IssueListItem): boolean {
  return (
    !!props.scopedEpicId &&
    props.scopeMode === "highlight" &&
    !isInScope(i, props.scopedEpicId)
  );
}

function scopedFor(i: IssueListItem): boolean {
  return !!props.scopedEpicId && isInScope(i, props.scopedEpicId);
}

function toggle(name: string): void {
  collapsed.value = { ...collapsed.value, [name]: !collapsed.value[name] };
}

function cardAccent(issue: IssueListItem): string {
  const dest = listForIssue(issue, defaultByType.value);
  return dest?.color ?? "#94a3b8";
}
</script>

<template>
  <div v-if="columns.length === 0" class="board-loading" data-test="board-loading">
    Loading list taxonomy…
  </div>
  <div v-else class="board">
    <BoardColumn
      v-for="col in columns"
      :key="col.id"
      :col="col"
      :issues="grouped[col.name] ?? []"
      :repo="repo"
      :collapsed="!!collapsed[col.name]"
      :requires-human-count="requiresHumanCounts[col.name] ?? 0"
      :sort-menu-open="!!sortMenuOpen[col.name]"
      :card-drag="cardDrag"
      :board-sort="boardSort"
      :card-accent="cardAccent"
      :dimmed-for="dimmedFor"
      :scoped-for="scopedFor"
      @toggle="toggle"
      @update:sort-menu-open="(v) => setSortMenuOpen(col.name, v)"
      @set-sort="setSort"
      @select="(i) => emit('select', i)"
      @parent-click="(pid) => emit('parent-click', pid)"
    />
  </div>
</template>

<style scoped>
.board {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(260px, 1fr);
  gap: 12px;
  align-items: stretch;
  overflow-x: auto;
  padding-bottom: 8px;
  height: 100%;
  min-height: 0;
}
.board-loading {
  padding: 24px;
  font-size: 12px;
  color: #64748b;
  text-align: center;
}
</style>
