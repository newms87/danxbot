<script setup lang="ts">
import { computed, ref } from "vue";
import type { IssueListItem, IssueStatus } from "../../types";
import IssueCard from "./IssueCard.vue";
import { COLUMN_ACCENTS } from "./issuePalette";

const props = defineProps<{
  issues: IssueListItem[];
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
}>();

const COLUMN_ORDER: readonly IssueStatus[] = [
  "Review",
  "ToDo",
  "In Progress",
  "Needs Help",
  "Done",
  "Cancelled",
];

const collapsed = ref<Record<IssueStatus, boolean>>(
  COLUMN_ORDER.reduce(
    (acc, s) => { acc[s] = COLUMN_ACCENTS[s].collapsedByDefault; return acc; },
    {} as Record<IssueStatus, boolean>,
  ),
);

const grouped = computed<Record<IssueStatus, IssueListItem[]>>(() => {
  const g = COLUMN_ORDER.reduce(
    (acc, s) => { acc[s] = []; return acc; },
    {} as Record<IssueStatus, IssueListItem[]>,
  );
  for (const issue of props.issues) {
    const bucket = g[issue.status];
    if (!bucket) {
      // eslint-disable-next-line no-console
      console.warn(`IssueBoard: unknown issue status "${issue.status}" on ${issue.id}`);
      continue;
    }
    bucket.push(issue);
  }
  for (const status of Object.keys(g) as IssueStatus[]) {
    g[status].sort((a, b) => {
      if ((a.type === "Epic") !== (b.type === "Epic")) return a.type === "Epic" ? -1 : 1;
      return b.updated_at - a.updated_at;
    });
  }
  return g;
});

function toggle(status: IssueStatus): void {
  collapsed.value = { ...collapsed.value, [status]: !collapsed.value[status] };
}
</script>

<template>
  <div class="board">
    <div
      v-for="status in COLUMN_ORDER"
      :key="status"
      class="column"
      :class="{ collapsed: collapsed[status] }"
    >
      <button
        class="header"
        type="button"
        :data-test="`column-header-${COLUMN_ACCENTS[status].id}`"
        :style="{ borderBottomColor: COLUMN_ACCENTS[status].accent }"
        @click="toggle(status)"
      >
        <span class="dot" :style="{ background: COLUMN_ACCENTS[status].accent }" />
        <span class="label">{{ COLUMN_ACCENTS[status].label }}</span>
        <span class="count">{{ grouped[status].length }}</span>
        <span class="glyph">{{ collapsed[status] ? "▸" : "▾" }}</span>
      </button>

      <div v-if="!collapsed[status]" class="cards">
        <div v-if="grouped[status].length === 0" class="empty">No items</div>
        <IssueCard
          v-for="issue in grouped[status]"
          :key="issue.id"
          :issue="issue"
          @select="(i) => emit('select', i)"
          @parent-click="(pid) => emit('parent-click', pid)"
        />
      </div>

      <div v-else-if="grouped[status].length > 0" class="collapsed-summary">
        {{ grouped[status].length }} hidden — click header to expand
      </div>
    </div>
  </div>
</template>

<style scoped>
.board {
  display: grid;
  grid-template-columns: repeat(6, minmax(260px, 1fr));
  gap: 12px;
  align-items: start;
  overflow-x: auto;
  padding-bottom: 8px;
}
.column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
}
.column.collapsed {
  min-width: 180px;
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
.glyph {
  margin-left: auto;
  font-size: 10px;
  color: #64748b;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
</style>
