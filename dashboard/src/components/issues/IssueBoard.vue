<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  DanxButton,
  DanxIcon,
  DanxPopover,
  DanxScroll,
  DanxTooltip,
} from "@thehammer/danx-ui";
import sortIcon from "danx-icon/src/fontawesome/solid/sort.svg?raw";
import arrowUp from "danx-icon/src/fontawesome/solid/arrow-up.svg?raw";
import arrowDown from "danx-icon/src/fontawesome/solid/arrow-down.svg?raw";
import type { IssueListItem, List, ListType } from "../../types";
import { LIST_TYPE_LADDER } from "../../types";
import IssueCard from "./IssueCard.vue";
import { isInScope, type ScopeMode } from "../../composables/useIssueFilters";
import { useCardDrag } from "../../composables/useCardDrag";
import { deriveListTypeFromStatus } from "../../composables/derive-status";
import {
  BOARD_SORT_OPTIONS,
  useBoardSort,
  type BoardSortDirection,
  type BoardSortKey,
} from "../../composables/useBoardSort";

/**
 * DX-586 (Phase 6 of DX-575) — list-driven board.
 *
 * Columns are now derived from the per-repo `lists.yaml` (parent
 * provides via `lists` prop, sourced from `useListColors`). Each list
 * is a column; columns are ordered left → right by `LIST_TYPE_LADDER`
 * (archived → review → ready → blocked → in_progress → completed →
 * cancelled), with multiple lists of the same type sorted by `order`.
 *
 * DX-639 (Phase 1 of DX-638) — Cards are grouped by the type's
 * default list as projected from `deriveStatus(card)`. The raw
 * `IssueListItem.list_name` field is a denormalized display cache /
 * tracker round-trip carrier; it is NEVER read here. DX-624 burned
 * the budget proving that a single missed `list_name` projection
 * event leaves a Done card rendered in In Progress forever; the
 * derived projection is immune because lifecycle triggers
 * (`cancelled_at`, `completed_at`, `blocked.at`, `dispatch`,
 * `ready_at`, `archived_at`) are the canonical source.
 *
 * The board emits `move` with the destination `List` (name + type) so
 * the parent can route through the INTO-blocked / OUT-of-blocked
 * dialogs before committing the optimistic mutation + PATCH. Pre-
 * DX-586's `IssueStatus` emit shape is retired.
 */

const props = defineProps<{
  issues: IssueListItem[];
  /**
   * Active repo name. Threaded through to `<IssueCard>` so the agent
   * badge can fetch the right per-repo avatar.
   */
  repo: string;
  /**
   * Per-repo list taxonomy from `useListColors(repo)`. Empty array on
   * first render before the initial fetch resolves — the board renders
   * a single "Loading taxonomy…" placeholder column to avoid a flash
   * of "no columns".
   */
  lists: List[];
  showClosed?: boolean;
  scopedEpicId: string | null;
  scopeMode: ScopeMode;
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
  /**
   * DX-586 — destination list (name + semantic type). Parent resolves
   * to the right dialog (INTO-blocked / OUT-of-blocked) and calls
   * `useIssues.moveIssueList`.
   */
  move: [issue: IssueListItem, toList: List];
}>();

/**
 * Ladder index for sort. Lower index = further left on the board.
 * Unknown types fall to the end (defensive — `lists.yaml` validation
 * already pins the enum, but a stale browser cache could see an
 * unknown type briefly during a deploy).
 */
function ladderIdx(type: ListType): number {
  const idx = LIST_TYPE_LADDER.indexOf(type);
  return idx < 0 ? LIST_TYPE_LADDER.length : idx;
}

/**
 * Columns ordered left → right by ladder position, then by `order`
 * within a type, then by name as a stable tie-breaker. Re-computed
 * whenever the parent's `lists` prop changes (SSE refresh on
 * lists-routes mutation).
 */
const columns = computed<List[]>(() => {
  const sorted = [...props.lists];
  sorted.sort((a, b) => {
    const la = ladderIdx(a.type);
    const lb = ladderIdx(b.type);
    if (la !== lb) return la - lb;
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
  // Show-closed gate: drop cancelled-type columns entirely when off
  // (mirrors the pre-DX-586 board's behavior — cancelled cards stay
  // hidden behind the toggle, not just dimmed). Completed-type
  // columns stay visible but their per-card filter trims to the
  // recent-24h slice — same UX as the legacy "Done (Recent)" synthetic.
  if (!props.showClosed) {
    return sorted.filter((l) => l.type !== "cancelled");
  }
  return sorted;
});

/** Default list per type — column-grouping target for every card. */
const defaultByType = computed<Map<ListType, List>>(() => {
  const m = new Map<ListType, List>();
  for (const l of props.lists) {
    if (l.is_default_for_type) m.set(l.type, l);
  }
  return m;
});

/**
 * DX-639 — resolve a card's column purely from its server-derived
 * semantic type. The wire-shape `IssueListItem` carries only the
 * already-derived `status` (projected by `parseIssue` → `deriveStatus`
 * server-side, NOT the raw lifecycle triggers), so the SPA short-cuts
 * the composition to `deriveListTypeFromStatus(issue.status)` and
 * lands the card in that type's default list.
 *
 * Callers with the full trigger shape (`DeriveStatusInput`) should
 * use `derivedListName(card, lists)` from the same module — it
 * composes `deriveStatus → deriveListTypeFromStatus → default-of-type`
 * for sites that need to re-derive without trusting the wire `status`.
 *
 * Either way, the raw `list_name` field is intentionally ignored —
 * drift in that denormalized cache (the DX-624 failure mode) cannot
 * leak into column grouping when grouping reads only the derivation.
 */
function listForIssue(issue: IssueListItem): List | null {
  const type = deriveListTypeFromStatus(issue.status);
  return defaultByType.value.get(type) ?? null;
}

const cardDrag = useCardDrag<List>({
  onDrop: (issue, _from, to) => {
    emit("move", issue, to);
  },
  // List `id` is the stable identity. The columns[] array is re-derived
  // every time the parent's `lists` prop updates (SSE on lists CRUD), so
  // object identity churns; the `id` survives.
  keyOf: (l) => l.id,
});

/**
 * Show-closed gate — when off, drop the `cancelled` columns entirely
 * AND filter `completed`-type columns to the recent-24h slice. Same
 * UX as pre-DX-586's "Done (Recent)" synthetic column, but lifted out
 * to a per-card filter so the column structure stays purely list-driven.
 */
const RECENT_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
function isCompletedRecent(issue: IssueListItem): boolean {
  return issue.updated_at * 1000 >= Date.now() - RECENT_DONE_WINDOW_MS;
}

/**
 * Grouped cards per column. Each card lands in exactly one column,
 * resolved via `listForIssue` — DX-639 derived projection.
 *
 * Multi-list-per-type note (Phase 1 trade-off): non-default lists of
 * a type ("Sprint 1 Backlog", "Sprint 2 Backlog" both type=archived)
 * render as empty columns under this scheme — every card funnels to
 * the type's default. DX-638 Phase 2 introduces multi-list-per-type
 * bucketing on top of this read-side projection.
 *
 * Uncategorized cards (no default for the projected type) are
 * silently dropped; the lists-routes guarantees ≥1 default list per
 * type so this is unreachable in practice.
 */
const grouped = computed<Record<string, IssueListItem[]>>(() => {
  const result: Record<string, IssueListItem[]> = {};
  for (const col of columns.value) result[col.name] = [];
  for (const issue of props.issues) {
    const dest = listForIssue(issue);
    if (!dest) continue;
    if (!props.showClosed) {
      if (dest.type === "cancelled") continue;
      if (dest.type === "completed" && !isCompletedRecent(issue)) continue;
    }
    if (!result[dest.name]) result[dest.name] = [];
    result[dest.name].push(issue);
  }
  // DX-625 — per-column client-side sort overlay on top of the backend
  // canonical order. `dispatch` sort is a no-op (preserves backend
  // order; ISS-210 / DX-522 invariant). Non-default sort applies a
  // stable comparator scoped to that column only.
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

const boardSort = useBoardSort();

const sortMenuOpen = ref<Record<string, boolean>>({});

function setSort(
  colName: string,
  key: BoardSortKey,
  direction: BoardSortDirection,
): void {
  boardSort.setSort(colName, { key, direction });
  sortMenuOpen.value = { ...sortMenuOpen.value, [colName]: false };
}

function isActive(
  colName: string,
  key: BoardSortKey,
  direction: BoardSortDirection,
): boolean {
  const s = boardSort.getSort(colName);
  return s.key === key && s.direction === direction;
}

function activeSortLabel(colName: string): string | null {
  if (boardSort.isDefault(colName)) return null;
  const s = boardSort.getSort(colName);
  const opt = BOARD_SORT_OPTIONS.find((o) => o.key === s.key);
  if (!opt) return null;
  return opt.label;
}

function activeSortArrow(colName: string): string {
  return boardSort.getSort(colName).direction === "desc" ? "↓" : "↑";
}

/**
 * Per-column `👤 N` subscript when any card in the column has
 * `requires_human != null`. Carried over from pre-DX-586.
 */
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

/** Lookup the column the card lives in (for the card accent prop). */
function cardAccent(issue: IssueListItem): string {
  const dest = listForIssue(issue);
  return dest?.color ?? "#94a3b8";
}

/** Stable per-column test id (kebab-case, alphanumeric only). */
function testIdFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
</script>

<template>
  <div v-if="columns.length === 0" class="board-loading" data-test="board-loading">
    Loading list taxonomy…
  </div>
  <div v-else class="board">
    <div
      v-for="col in columns"
      :key="col.id"
      class="column"
      :class="{
        collapsed: collapsed[col.name],
        'drop-hover': cardDrag.isHoveringColumn(col),
      }"
      :style="{ '--col-accent': col.color }"
      v-bind="cardDrag.bindColumn(col)"
      :data-test="`column-${testIdFor(col.name)}`"
    >
      <div
        class="header"
        :data-test="`column-header-${testIdFor(col.name)}`"
        :style="{ borderBottomColor: col.color }"
      >
        <button
          class="header-collapse"
          type="button"
          :data-test="`column-collapse-${testIdFor(col.name)}`"
          @click="toggle(col.name)"
        >
          <span class="dot" :style="{ background: col.color }" />
          <span class="label">{{ col.name }}</span>
          <span class="count">{{ grouped[col.name]?.length ?? 0 }}</span>
          <DanxTooltip
            v-if="requiresHumanCounts[col.name] > 0"
            :tooltip="`${requiresHumanCounts[col.name]} card(s) require human action`"
          >
            <template #trigger>
              <span class="rh-count" :data-test="`column-rh-${testIdFor(col.name)}`">👤 {{ requiresHumanCounts[col.name] }}</span>
            </template>
          </DanxTooltip>
        </button>
        <DanxPopover
          v-model="sortMenuOpen[col.name]"
          trigger="click"
          placement="bottom"
        >
          <template #trigger>
            <DanxButton
              variant=""
              size="sm"
              class="sort-btn"
              :class="{ 'sort-btn-active': !boardSort.isDefault(col.name) }"
              :tooltip="activeSortLabel(col.name)
                ? `Sorted by ${activeSortLabel(col.name)} ${boardSort.getSort(col.name).direction === 'desc' ? 'descending' : 'ascending'}`
                : `Sort ${col.name}`"
              :aria-label="activeSortLabel(col.name)
                ? `Sorted by ${activeSortLabel(col.name)} ${boardSort.getSort(col.name).direction === 'desc' ? 'descending' : 'ascending'}`
                : `Sort ${col.name}`"
              :data-test="`column-sort-${testIdFor(col.name)}`"
            >
              <template #icon>
                <DanxIcon :icon="sortIcon" />
              </template>
              <span
                v-if="activeSortLabel(col.name)"
                class="sort-active-label"
                :data-test="`column-sort-active-${testIdFor(col.name)}`"
              >{{ activeSortLabel(col.name) }} {{ activeSortArrow(col.name) }}</span>
            </DanxButton>
          </template>
          <div class="sort-menu" :data-test="`column-sort-menu-${testIdFor(col.name)}`">
            <div
              v-for="opt in BOARD_SORT_OPTIONS"
              :key="opt.key"
              class="sort-row"
            >
              <span class="sort-row-label">{{ opt.label }}</span>
              <div class="sort-row-dirs">
                <button
                  type="button"
                  class="sort-dir"
                  :class="{ active: isActive(col.name, opt.key, 'asc') }"
                  :data-test="`column-sort-${testIdFor(col.name)}-${opt.key}-asc`"
                  :aria-label="`${opt.label} ascending`"
                  @click="setSort(col.name, opt.key, 'asc')"
                >
                  <DanxIcon :icon="arrowUp" />
                </button>
                <button
                  type="button"
                  class="sort-dir"
                  :class="{ active: isActive(col.name, opt.key, 'desc') }"
                  :data-test="`column-sort-${testIdFor(col.name)}-${opt.key}-desc`"
                  :aria-label="`${opt.label} descending`"
                  @click="setSort(col.name, opt.key, 'desc')"
                >
                  <DanxIcon :icon="arrowDown" />
                </button>
              </div>
            </div>
          </div>
        </DanxPopover>
        <button
          class="header-glyph"
          type="button"
          :aria-label="collapsed[col.name] ? 'Expand column' : 'Collapse column'"
          @click="toggle(col.name)"
        >{{ collapsed[col.name] ? "▸" : "▾" }}</button>
      </div>

      <DanxScroll v-if="!collapsed[col.name]" class="cards-scroll">
        <div class="cards">
          <div v-if="(grouped[col.name]?.length ?? 0) === 0" class="empty">
            No items
          </div>
          <template v-else>
            <template
              v-for="issue in grouped[col.name] ?? []"
              :key="issue.id"
            >
              <IssueCard
                :issue="issue"
                :repo="props.repo"
                :accent="cardAccent(issue)"
                :dimmed="dimmedFor(issue)"
                :scoped="scopedFor(issue)"
                :dragging="cardDrag.isDragging(issue)"
                :drag-handlers="cardDrag.bindCard(issue, col)"
                @select="(i) => emit('select', i)"
                @parent-click="(pid) => emit('parent-click', pid)"
              />
            </template>
          </template>
        </div>
      </DanxScroll>

      <div v-else-if="(grouped[col.name]?.length ?? 0) > 0" class="collapsed-summary">
        {{ grouped[col.name]?.length ?? 0 }} hidden — click header to expand
      </div>
    </div>
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
.column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
  min-height: 0;
}
.column.collapsed {
  min-width: 180px;
  flex-grow: 0;
}
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 4px 10px 6px;
  width: 100%;
  border-bottom: 1px solid #1e293b;
  color: #94a3b8;
  flex-shrink: 0;
}
.header-collapse {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
  text-align: left;
}
.header-glyph {
  background: none;
  border: 0;
  padding: 0 4px;
  font-size: 10px;
  color: #64748b;
  cursor: pointer;
}
.sort-btn {
  padding: 2px 6px !important;
  opacity: 0.55;
}
.sort-btn:hover {
  opacity: 1;
}
.sort-btn.sort-btn-active {
  opacity: 1;
  color: var(--col-accent, #a5b4fc);
}
.sort-btn :deep(.danx-icon) {
  width: 12px;
  height: 12px;
}
.sort-active-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
  color: inherit;
}
.sort-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  min-width: 200px;
}
.sort-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 4px;
}
.sort-row:hover {
  background: rgb(51 65 85 / 0.4);
}
.sort-row-label {
  font-size: 12px;
  color: #cbd5e1;
}
.sort-row-dirs {
  display: flex;
  gap: 4px;
}
.sort-dir {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: none;
  border: 1px solid #334155;
  border-radius: 4px;
  cursor: pointer;
  color: #94a3b8;
}
.sort-dir:hover {
  border-color: #475569;
  color: #e2e8f0;
}
.sort-dir.active {
  border-color: var(--col-accent, #a5b4fc);
  color: var(--col-accent, #a5b4fc);
  background: rgb(99 102 241 / 0.15);
}
.sort-dir :deep(.danx-icon) {
  width: 10px;
  height: 10px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
}
.label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #cbd5e1;
}
.count {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  padding: 1px 6px;
  border-radius: 9999px;
  background: rgb(51 65 85 / 0.4);
  font-variant-numeric: tabular-nums;
}
.rh-count {
  font-size: 10px;
  font-weight: 600;
  color: #fdba74;
  padding: 1px 6px;
  border-radius: 9999px;
  background: rgb(249 115 22 / 0.15);
  border: 1px solid rgb(249 115 22 / 0.35);
  font-variant-numeric: tabular-nums;
  cursor: help;
}
.cards-scroll {
  flex: 1 1 auto;
  min-height: 0;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}
.empty {
  padding: 20px 12px;
  text-align: center;
  font-size: 11px;
  color: #475569;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
.collapsed-summary {
  padding: 8px 10px;
  font-size: 11px;
  color: #64748b;
  background: rgb(15 23 42 / 0.4);
  border-radius: 6px;
  border: 1px solid #1e293b;
}
.column.drop-hover {
  outline: 2px dashed var(--col-accent, #a5b4fc);
  outline-offset: -4px;
  background: rgb(99 102 241 / 0.05);
  border-radius: 8px;
}
</style>
