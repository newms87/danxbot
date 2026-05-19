<script setup lang="ts">
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
import xmarkIcon from "danx-icon/src/fontawesome/solid/xmark.svg?raw";
import type { IssueListItem, List } from "../../types";
import IssueCard from "./IssueCard.vue";
import type { useCardDrag } from "../../composables/useCardDrag";
import {
  BOARD_SORT_OPTIONS,
  type BoardSortDirection,
  type BoardSortKey,
  type useBoardSort,
} from "../../composables/useBoardSort";
import { buildColumnRows, testIdFor } from "./boardColumns";

/**
 * DX-693 — per-column render lifted out of `IssueBoard.vue`. The board
 * shell owns columns/grouped/cardDrag/boardSort state and renders one
 * of these per column. Pure presentational + drag-binding glue; all
 * data shaping lives in `boardColumns.ts`.
 */

const props = defineProps<{
  col: List;
  issues: IssueListItem[];
  repo: string;
  collapsed: boolean;
  requiresHumanCount: number;
  sortMenuOpen: boolean;
  cardDrag: ReturnType<typeof useCardDrag<List>>;
  boardSort: ReturnType<typeof useBoardSort>;
  cardAccent: (issue: IssueListItem) => string;
  dimmedFor: (issue: IssueListItem) => boolean;
  scopedFor: (issue: IssueListItem) => boolean;
}>();

const emit = defineEmits<{
  toggle: [name: string];
  "update:sort-menu-open": [open: boolean];
  "set-sort": [colName: string, key: BoardSortKey, direction: BoardSortDirection];
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
}>();

function activeSortLabel(colName: string): string | null {
  if (props.boardSort.isDefault(colName)) return null;
  const s = props.boardSort.getSort(colName);
  const opt = BOARD_SORT_OPTIONS.find((o) => o.key === s.key);
  return opt?.label ?? null;
}

function activeSortArrow(colName: string): string {
  return props.boardSort.getSort(colName).direction === "desc" ? "↓" : "↑";
}

function isActive(
  colName: string,
  key: BoardSortKey,
  direction: BoardSortDirection,
): boolean {
  const s = props.boardSort.getSort(colName);
  return s.key === key && s.direction === direction;
}
</script>

<template>
  <div
    class="column"
    :class="{
      collapsed,
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
        @click="emit('toggle', col.name)"
      >
        <span class="dot" :style="{ background: col.color }" />
        <span class="label">{{ col.name }}</span>
        <span class="count">{{ issues.length }}</span>
        <DanxTooltip
          v-if="requiresHumanCount > 0"
          :tooltip="`${requiresHumanCount} card(s) require human action`"
        >
          <template #trigger>
            <span class="rh-count" :data-test="`column-rh-${testIdFor(col.name)}`">👤 {{ requiresHumanCount }}</span>
          </template>
        </DanxTooltip>
      </button>
      <DanxPopover
        :model-value="sortMenuOpen"
        trigger="click"
        placement="bottom"
        @update:model-value="(v: boolean) => emit('update:sort-menu-open', v)"
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
          <div v-for="opt in BOARD_SORT_OPTIONS" :key="opt.key" class="sort-row">
            <span class="sort-row-label">{{ opt.label }}</span>
            <div class="sort-row-dirs">
              <button
                type="button"
                class="sort-dir"
                :class="{ active: isActive(col.name, opt.key, 'asc') }"
                :data-test="`column-sort-${testIdFor(col.name)}-${opt.key}-asc`"
                :aria-label="`${opt.label} ascending`"
                @click="emit('set-sort', col.name, opt.key, 'asc')"
              >
                <DanxIcon :icon="arrowUp" />
              </button>
              <button
                type="button"
                class="sort-dir"
                :class="{ active: isActive(col.name, opt.key, 'desc') }"
                :data-test="`column-sort-${testIdFor(col.name)}-${opt.key}-desc`"
                :aria-label="`${opt.label} descending`"
                @click="emit('set-sort', col.name, opt.key, 'desc')"
              >
                <DanxIcon :icon="arrowDown" />
              </button>
            </div>
          </div>
        </div>
      </DanxPopover>
      <DanxButton
        v-if="!boardSort.isDefault(col.name)"
        variant=""
        size="sm"
        class="sort-clear-btn"
        :tooltip="`Clear ${col.name} sort (reset to default Priority)`"
        :aria-label="`Clear ${col.name} sort`"
        :data-test="`column-sort-clear-${testIdFor(col.name)}`"
        @click="boardSort.resetSort(col.name)"
      >
        <template #icon>
          <DanxIcon :icon="xmarkIcon" />
        </template>
      </DanxButton>
      <button
        class="header-glyph"
        type="button"
        :aria-label="collapsed ? 'Expand column' : 'Collapse column'"
        @click="emit('toggle', col.name)"
      >{{ collapsed ? "▸" : "▾" }}</button>
    </div>

    <DanxScroll v-if="!collapsed" class="cards-scroll">
      <div v-if="issues.length === 0" class="empty-wrap">
        <div
          class="drop-slot drop-slot-empty"
          v-bind="cardDrag.bindSlot(`slot:${col.id}:head:tail`, null, null)"
          :class="{ 'slot-hover': cardDrag.isHoveringSlot(`slot:${col.id}:head:tail`) }"
          :data-test="`column-slot-empty-${testIdFor(col.name)}`"
        />
        <div class="empty">No items</div>
      </div>
      <TransitionGroup
        v-else
        tag="div"
        name="card-reorder"
        class="cards"
        :data-test="`column-cards-${testIdFor(col.name)}`"
      >
        <template
          v-for="row in buildColumnRows(col.id, issues)"
          :key="row.key"
        >
          <div
            v-if="row.kind === 'slot'"
            class="drop-slot"
            :class="{ 'slot-hover': cardDrag.isHoveringSlot(row.key) }"
            v-bind="cardDrag.bindSlot(row.key, row.before, row.after)"
            :data-test="`column-slot-${testIdFor(col.name)}-${row.before?.id ?? 'head'}-${row.after?.id ?? 'tail'}`"
          />
          <IssueCard
            v-else
            :issue="row.issue"
            :repo="repo"
            :accent="cardAccent(row.issue)"
            :dimmed="dimmedFor(row.issue)"
            :scoped="scopedFor(row.issue)"
            :dragging="cardDrag.isDragging(row.issue)"
            :drag-handlers="cardDrag.bindCard(row.issue, col)"
            @select="(i) => emit('select', i)"
            @parent-click="(pid) => emit('parent-click', pid)"
          />
        </template>
      </TransitionGroup>
    </DanxScroll>

    <div v-else-if="issues.length > 0" class="collapsed-summary">
      {{ issues.length }} hidden — click header to expand
    </div>
  </div>
</template>

<style scoped>
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
.sort-btn:hover { opacity: 1; }
.sort-btn.sort-btn-active {
  opacity: 1;
  color: var(--col-accent, #a5b4fc);
}
.sort-btn :deep(.danx-icon) { width: 12px; height: 12px; }
.sort-clear-btn { padding: 2px 6px !important; opacity: 0.55; color: #94a3b8; }
.sort-clear-btn:hover { opacity: 1; color: #f87171; }
.sort-clear-btn :deep(.danx-icon) { width: 10px; height: 10px; }
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
.sort-row:hover { background: rgb(51 65 85 / 0.4); }
.sort-row-label { font-size: 12px; color: #cbd5e1; }
.sort-row-dirs { display: flex; gap: 4px; }
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
.sort-dir:hover { border-color: #475569; color: #e2e8f0; }
.sort-dir.active {
  border-color: var(--col-accent, #a5b4fc);
  color: var(--col-accent, #a5b4fc);
  background: rgb(99 102 241 / 0.15);
}
.sort-dir :deep(.danx-icon) { width: 10px; height: 10px; }
.dot { width: 6px; height: 6px; border-radius: 9999px; }
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
.cards-scroll { flex: 1 1 auto; min-height: 0; }
.cards { display: flex; flex-direction: column; padding-right: 4px; }
.empty-wrap { display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.empty {
  padding: 20px 12px;
  text-align: center;
  font-size: 11px;
  color: #475569;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
.drop-slot {
  height: 6px;
  margin: 1px 0;
  border-radius: 4px;
  background: transparent;
  transition: background-color 120ms ease, height 120ms ease;
}
.drop-slot.slot-hover {
  height: 14px;
  background: rgb(99 102 241 / 0.35);
  outline: 2px dashed var(--col-accent, #a5b4fc);
  outline-offset: -2px;
}
.drop-slot-empty {
  height: 60px;
  margin: 0;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
.drop-slot-empty.slot-hover {
  height: 60px;
  background: rgb(99 102 241 / 0.1);
  border-color: var(--col-accent, #a5b4fc);
}
.card-reorder-move {
  transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.card-reorder-enter-active,
.card-reorder-leave-active {
  transition: opacity 160ms ease;
}
.card-reorder-enter-from,
.card-reorder-leave-to { opacity: 0; }
.card-reorder-leave-active { position: absolute; }
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
