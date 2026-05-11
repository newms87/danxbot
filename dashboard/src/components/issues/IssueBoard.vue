<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DanxScroll } from "@thehammer/danx-ui";
import type { IssueListItem, IssueStatus } from "../../types";
import IssueCard from "./IssueCard.vue";
import { COLUMN_ACCENTS } from "./issuePalette";
import { isInScope, type ScopeMode } from "../../composables/useIssueFilters";
import { useCardDrag } from "../../composables/useCardDrag";

const props = defineProps<{
  issues: IssueListItem[];
  /**
   * Active repo name. Threaded through to `<IssueCard>` so the agent
   * badge (`<AgentBadge>`) can fetch the right per-repo avatar without
   * a board-level singleton lookup. Required even when there is no
   * `assigned_agent` on the cards — the prop shape stays stable.
   */
  repo: string;
  showClosed?: boolean;
  scopedEpicId: string | null;
  scopeMode: ScopeMode;
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
  /**
   * Fired when the user releases a card over a column whose status
   * differs from `issue.status`. Parent owns the optimistic state
   * mutation + REST patch via `useIssues.moveIssueStatus`.
   */
  move: [issue: IssueListItem, toStatus: IssueStatus];
}>();

const cardDrag = useCardDrag({
  onDrop: (issue, _from, to) => {
    emit("move", issue, to);
  },
});

interface BoardColumn {
  key: string;
  label: string;
  accent: string;
  testId: string;
  collapsedByDefault: boolean;
  match: (i: IssueListItem) => boolean;
  /**
   * Drop target status. `undefined` for synthetic columns (e.g.
   * `done_recent`) that aggregate by predicate rather than a single
   * status — drops on those columns are inert (no patch fires).
   */
  status?: IssueStatus;
}

const RECENT_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

function statusColumn(status: IssueStatus): BoardColumn {
  const meta = COLUMN_ACCENTS[status];
  return {
    key: meta.id,
    label: meta.label,
    accent: meta.accent,
    testId: meta.id,
    collapsedByDefault: meta.collapsedByDefault,
    match: (i) => i.status === status,
    status,
  };
}

const columns = computed<BoardColumn[]>(() => {
  const review = statusColumn("Review");
  const todo = statusColumn("ToDo");
  const blocked = statusColumn("Blocked");
  const inProgress = statusColumn("In Progress");

  // DX-231 retired the `Needs Approval` parking column. The orthogonal
  // `requires_human` field replaces it; Phase 8 of the epic adds a
  // dedicated indicator on every card. Until then no separate column
  // exists for the field — flagged cards stay in their status column
  // with the indicator surfacing the human-action handoff.

  if (props.showClosed) {
    const done = { ...statusColumn("Done"), collapsedByDefault: false };
    const cancelled = { ...statusColumn("Cancelled"), collapsedByDefault: false };
    return [review, todo, blocked, inProgress, done, cancelled];
  }

  const cutoff = Date.now() - RECENT_DONE_WINDOW_MS;
  const doneRecent: BoardColumn = {
    key: "done_recent",
    label: "Done (Recent)",
    accent: COLUMN_ACCENTS["Done"].accent,
    testId: "done_recent",
    collapsedByDefault: false,
    match: (i) => i.status === "Done" && i.updated_at * 1000 >= cutoff,
  };
  return [review, todo, blocked, inProgress, doneRecent];
});

const collapsed = ref<Record<string, boolean>>({});

watch(
  columns,
  (next) => {
    const merged: Record<string, boolean> = {};
    for (const col of next) {
      merged[col.key] = collapsed.value[col.key] ?? col.collapsedByDefault;
    }
    collapsed.value = merged;
  },
  { immediate: true },
);

const grouped = computed<Record<string, IssueListItem[]>>(() => {
  const result: Record<string, IssueListItem[]> = {};
  const cols = columns.value;
  for (const col of cols) result[col.key] = [];
  for (const issue of props.issues) {
    const col = cols.find((c) => c.match(issue));
    if (!col) continue;
    result[col.key].push(issue);
  }
  // No per-column re-sort. The backend's `sortIssuesForStatus` (in
  // `src/issue-tracker/sort.ts`) emits the canonical order per status
  // and the API list ships in that order; the SPA preserves it
  // verbatim. ISS-210 retired the column-level updated_at re-sort.
  return result;
});

// DX-239 — per-column `👤 N` subscript when any card in the column has
// `requires_human != null`. Visual cue without filtering; clicking the
// card surfaces the panel.
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

function toggle(key: string): void {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
}
</script>

<template>
  <div class="board">
    <div
      v-for="col in columns"
      :key="col.key"
      class="column"
      :class="{ collapsed: collapsed[col.key], 'drop-hover': col.status && cardDrag.isHoveringColumn(col.status) }"
      :style="{ '--col-accent': col.accent }"
      v-bind="col.status ? cardDrag.bindColumn(col.status) : {}"
      :data-test="`column-${col.testId}`"
    >
      <button
        class="header"
        type="button"
        :data-test="`column-header-${col.testId}`"
        :style="{ borderBottomColor: col.accent }"
        @click="toggle(col.key)"
      >
        <span class="dot" :style="{ background: col.accent }" />
        <span class="label">{{ col.label }}</span>
        <span class="count">{{ grouped[col.key]?.length ?? 0 }}</span>
        <span
          v-if="requiresHumanCounts[col.key] > 0"
          class="rh-count"
          :title="`${requiresHumanCounts[col.key]} card(s) require human action`"
          :data-test="`column-rh-${col.testId}`"
        >👤 {{ requiresHumanCounts[col.key] }}</span>
        <span class="glyph">{{ collapsed[col.key] ? "▸" : "▾" }}</span>
      </button>

      <DanxScroll v-if="!collapsed[col.key]" class="cards-scroll">
        <div class="cards">
          <div v-if="(grouped[col.key]?.length ?? 0) === 0" class="empty">No items</div>
          <IssueCard
            v-for="issue in grouped[col.key] ?? []"
            :key="issue.id"
            :issue="issue"
            :repo="props.repo"
            :dimmed="dimmedFor(issue)"
            :scoped="scopedFor(issue)"
            :dragging="cardDrag.isDragging(issue)"
            :drag-handlers="cardDrag.bindCard(issue)"
            @select="(i) => emit('select', i)"
            @parent-click="(pid) => emit('parent-click', pid)"
          />
        </div>
      </DanxScroll>

      <div v-else-if="(grouped[col.key]?.length ?? 0) > 0" class="collapsed-summary">
        {{ grouped[col.key]?.length ?? 0 }} hidden — click header to expand
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
  background: none;
  border: 0;
  border-bottom: 1px solid #1e293b;
  cursor: pointer;
  font-family: inherit;
  color: #94a3b8;
  flex-shrink: 0;
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
.glyph {
  margin-left: auto;
  font-size: 10px;
  color: #64748b;
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
