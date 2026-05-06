<script setup lang="ts">
import { computed } from "vue";
import type { ChildStatusId, IssueDetail, IssueListItem } from "../../types";
import TypeBadge from "./TypeBadge.vue";
import { CHILD_STATUS_META } from "./issuePalette";
import { MarkdownEditor } from "danx-ui";

const props = defineProps<{
  issue: IssueDetail;
  allIssues: IssueListItem[];
}>();

const emit = defineEmits<{
  "jump-issue": [id: string];
}>();

// Read the parent's pre-projected `children_detail[]` so this drawer
// renders each child with the SAME `done|todo|blocked` glyph as
// `IssueCard.vue`'s `ChildrenChecklist.vue`. `allIssues` lookup remains
// the source for `type` (TypeBadge) and `title`.
const childRows = computed(() => {
  const parentListing = props.allIssues.find((i) => i.id === props.issue.id);
  const statusById = new Map<string, ChildStatusId>(
    (parentListing?.children_detail ?? []).map((c) => [c.id, c.status]),
  );
  return props.issue.children
    .map((id) => {
      const child = props.allIssues.find((i) => i.id === id);
      if (!child) return null;
      return {
        id: child.id,
        type: child.type,
        title: child.title,
        status: statusById.get(child.id) ?? "todo",
      };
    })
    .filter(<T,>(r: T | null): r is T => r !== null);
});

const childrenSectionLabel = computed(() =>
  props.issue.type === "Epic" ? "Phases" : "Children",
);
</script>

<template>
  <div class="overview">
    <section v-if="issue.description">
      <div class="section-label">Description</div>
      <MarkdownEditor
        :model-value="issue.description"
        readonly
        hide-footer
      />
    </section>

    <section v-if="issue.blocked" class="blocked-panel">
      <div class="blocked-title">⛔ Blocked</div>
      <div class="blocked-reason">{{ issue.blocked.reason }}</div>
      <div v-if="issue.blocked.by.length > 0" class="blocked-by">
        <span class="by-label">by:</span>
        <button
          v-for="bid in issue.blocked.by"
          :key="bid"
          type="button"
          class="blocker-chip"
          @click="emit('jump-issue', bid)"
        >{{ bid }}</button>
      </div>
    </section>

    <section v-if="childRows.length > 0">
      <div class="section-label">{{ childrenSectionLabel }} · {{ childRows.length }}</div>
      <div class="child-list">
        <button
          v-for="c in childRows"
          :key="c.id"
          type="button"
          class="child-row"
          :class="{ done: c.status === 'done' }"
          @click="emit('jump-issue', c.id)"
        >
          <span
            class="status-chip"
            :style="{
              background: CHILD_STATUS_META[c.status].bg,
              color: CHILD_STATUS_META[c.status].fg,
            }"
          >{{ CHILD_STATUS_META[c.status].glyph }}</span>
          <span class="child-id">{{ c.id }}</span>
          <TypeBadge :type="c.type" compact />
          <span class="child-title">{{ c.title }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 20px;
}
.section-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.blocked-panel {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgb(239 68 68 / 0.08);
  border: 1px solid rgb(239 68 68 / 0.25);
}
.blocked-title {
  font-size: 11px;
  font-weight: 600;
  color: #fca5a5;
  margin-bottom: 4px;
}
.blocked-reason {
  font-size: 13px;
  color: #fecaca;
  line-height: 1.5;
}
.blocked-by {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.by-label {
  font-size: 11px;
  color: #fca5a5;
}
.blocker-chip {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #fecaca;
  background: rgb(239 68 68 / 0.15);
  border: 1px solid rgb(239 68 68 / 0.3);
  cursor: pointer;
  font-family: inherit;
}
.child-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.child-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  cursor: pointer;
  font-family: inherit;
  width: 100%;
}
.child-id {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.child-title {
  flex: 1;
  font-size: 12px;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.child-row.done {
  color: #64748b;
  text-decoration: line-through;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
}
</style>
