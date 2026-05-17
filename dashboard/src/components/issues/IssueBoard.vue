<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DanxScroll, DanxTooltip } from "@thehammer/danx-ui";
import type { IssueListItem, List, ListType } from "../../types";
import { LIST_TYPE_LADDER } from "../../types";
import IssueCard from "./IssueCard.vue";
import { isInScope, type ScopeMode } from "../../composables/useIssueFilters";
import { useCardDrag } from "../../composables/useCardDrag";

/**
 * DX-586 (Phase 6 of DX-575) — list-driven board.
 *
 * Columns are now derived from the per-repo `lists.yaml` (parent
 * provides via `lists` prop, sourced from `useListColors`). Each list
 * is a column; columns are ordered left → right by `LIST_TYPE_LADDER`
 * (archived → review → ready → blocked → in_progress → completed →
 * cancelled), with multiple lists of the same type sorted by `order`.
 *
 * Cards are grouped by `IssueListItem.list_name`. Pre-DX-586 cards (no
 * `list_name`) fall back to the type's default list so the operator
 * never sees an orphaned card.
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
  /**
   * DX-264 carry-over — intra-column reorder via drop slot. Reorder
   * only fires inside `position`-honoring columns; the position-tier
   * sort filter still uses derived status (Review / ToDo / Blocked).
   */
  reorder: [
    issue: IssueListItem,
    before: IssueListItem | null,
    after: IssueListItem | null,
  ];
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

/** Map list_name → List for quick lookup (drop targets + card accent). */
const listsByName = computed<Map<string, List>>(() => {
  const m = new Map<string, List>();
  for (const l of props.lists) m.set(l.name, l);
  return m;
});

/** Default list per type — used as the fallback for cards with no `list_name`. */
const defaultByType = computed<Map<ListType, List>>(() => {
  const m = new Map<ListType, List>();
  for (const l of props.lists) {
    if (l.is_default_for_type) m.set(l.type, l);
  }
  return m;
});

/**
 * Map issue status → ListType so a pre-DX-586 card with `list_name:
 * null` can be bucketed into its derived type's default list.
 * Mirrors `deriveListTypeFromSemanticStatus` server-side.
 */
function listTypeForStatus(status: IssueListItem["status"]): ListType {
  switch (status) {
    case "Backlog":
      return "archived";
    case "Review":
      return "review";
    case "ToDo":
      return "ready";
    case "In Progress":
      return "in_progress";
    case "Blocked":
      return "blocked";
    case "Done":
      return "completed";
    case "Cancelled":
      return "cancelled";
  }
}

/**
 * Resolve a card to the list it belongs in for column grouping.
 * Priority: explicit `list_name` (if it matches a current list) →
 * default list for the card's derived type → null (uncategorized;
 * dropped from the board, surfaces via the audit log).
 */
function listForIssue(issue: IssueListItem): List | null {
  if (issue.list_name) {
    const hit = listsByName.value.get(issue.list_name);
    if (hit) return hit;
  }
  const fallbackType = listTypeForStatus(issue.status);
  return defaultByType.value.get(fallbackType) ?? null;
}

const cardDrag = useCardDrag<List>({
  onDrop: (issue, _from, to) => {
    emit("move", issue, to);
  },
  onReorder: (issue, before, after) => {
    emit("reorder", issue, before, after);
  },
  // List `id` is the stable identity. The columns[] array is re-derived
  // every time the parent's `lists` prop updates (SSE on lists CRUD), so
  // object identity churns; the `id` survives.
  keyOf: (l) => l.id,
});

/** Stable key for a drop slot. */
function slotKey(
  colName: string,
  before: IssueListItem | null,
  after: IssueListItem | null,
): string {
  return `${colName}:${before?.id ?? "head"}:${after?.id ?? "tail"}`;
}

/**
 * Drop slots (intra-column reorder) only render in `position`-honoring
 * types — same set as pre-DX-586 (review / ready / blocked). The
 * dest-side `dispatch != null` columns (in_progress) and the terminal
 * columns (completed / cancelled) sort by `updated_at` and ignore the
 * position tier; drop slots there would look like targets but produce
 * no visible movement.
 */
const POSITIONABLE_TYPES: ReadonlySet<ListType> = new Set<ListType>([
  "review",
  "ready",
  "blocked",
]);
function columnSupportsPosition(col: List): boolean {
  return POSITIONABLE_TYPES.has(col.type);
}

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
 * Grouped cards per column. Each card lands in exactly one column —
 * the resolution priority is `list_name` → type-default → drop.
 * Uncategorized cards (no list matches AND no default for type) are
 * silently dropped; the lists-routes guarantees ≥1 list per type so
 * this is unreachable in practice.
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
      <button
        class="header"
        type="button"
        :data-test="`column-header-${testIdFor(col.name)}`"
        :style="{ borderBottomColor: col.color }"
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
        <span class="glyph">{{ collapsed[col.name] ? "▸" : "▾" }}</span>
      </button>

      <DanxScroll v-if="!collapsed[col.name]" class="cards-scroll">
        <div class="cards">
          <div v-if="(grouped[col.name]?.length ?? 0) === 0" class="empty">
            <span v-if="columnSupportsPosition(col)"
              class="drop-slot drop-slot-empty"
              :class="{ 'drop-slot-hover': cardDrag.isHoveringSlot(slotKey(col.name, null, null)) }"
              v-bind="cardDrag.bindSlot(slotKey(col.name, null, null), null, null)"
              :data-test="`drop-slot-${testIdFor(col.name)}-empty`"
            />
            No items
          </div>
          <template v-else>
            <span
              v-if="columnSupportsPosition(col)"
              class="drop-slot"
              :class="{ 'drop-slot-hover': cardDrag.isHoveringSlot(slotKey(col.name, null, (grouped[col.name] ?? [])[0] ?? null)) }"
              v-bind="cardDrag.bindSlot(slotKey(col.name, null, (grouped[col.name] ?? [])[0] ?? null), null, (grouped[col.name] ?? [])[0] ?? null)"
              :data-test="`drop-slot-${testIdFor(col.name)}-head`"
            />
            <template
              v-for="(issue, idx) in grouped[col.name] ?? []"
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
              <span
                v-if="columnSupportsPosition(col)"
                class="drop-slot"
                :class="{ 'drop-slot-hover': cardDrag.isHoveringSlot(slotKey(col.name, issue, (grouped[col.name] ?? [])[idx + 1] ?? null)) }"
                v-bind="cardDrag.bindSlot(slotKey(col.name, issue, (grouped[col.name] ?? [])[idx + 1] ?? null), issue, (grouped[col.name] ?? [])[idx + 1] ?? null)"
                :data-test="`drop-slot-${testIdFor(col.name)}-${issue.id}`"
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
.drop-slot {
  display: block;
  height: 6px;
  margin: -2px 0;
  border-radius: 4px;
  transition: background-color 120ms, height 120ms;
}
.drop-slot.drop-slot-empty {
  height: 24px;
  margin: 6px 0;
}
.drop-slot.drop-slot-hover {
  height: 14px;
  background: var(--col-accent, #a5b4fc);
  opacity: 0.6;
}
</style>
