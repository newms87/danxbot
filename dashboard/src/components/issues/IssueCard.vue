<script setup lang="ts">
import { computed } from "vue";
import type { IssueListItem } from "../../types";
import TypeBadge from "./TypeBadge.vue";
import ChildrenChecklist from "./ChildrenChecklist.vue";
import ACBar from "./ACBar.vue";
import { relativeTime } from "../../utils/relativeTime";

const props = withDefaults(
  defineProps<{
    issue: IssueListItem;
    dimmed?: boolean;
    scoped?: boolean;
  }>(),
  { dimmed: false, scoped: false },
);

const emit = defineEmits<{
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
}>();

const isEpic = computed(() => props.issue.type === "Epic");
const blocked = computed(() => props.issue.blocked);
const updatedLabel = computed(() => relativeTime(props.issue.updated_at));

// Unified `children[]` (ISS-81). Epic = phase cards (label "Phases"),
// non-epic = sub-cards (label "Children"). Same render shape either way.
const childrenDetail = computed(() => props.issue.children_detail);
const childrenLabel = computed(() => (isEpic.value ? "phases" : "children"));

function onParentClick(e: MouseEvent): void {
  e.stopPropagation();
  if (props.issue.parent_id) emit("parent-click", props.issue.parent_id);
}
</script>

<template>
  <button
    class="issue-card"
    :class="{ epic: isEpic, blocked, dimmed: props.dimmed, scoped: props.scoped }"
    type="button"
    @click="emit('select', issue)"
  >
    <div class="card-header">
      <span class="id-chip">{{ issue.id }}</span>
      <TypeBadge :type="issue.type" compact />
      <span v-if="childrenDetail.length > 0" class="children-count-chip">
        {{ childrenDetail.length }} {{ childrenLabel }}
      </span>
      <span
        v-if="blocked"
        class="blocked-badge"
        :title="issue.blocked_reason ?? undefined"
      >
        <span class="blocked-glyph">⛔</span> Blocked
      </span>
    </div>

    <div class="title">{{ issue.title }}</div>

    <ChildrenChecklist
      v-if="childrenDetail.length > 0"
      :items="childrenDetail"
    />

    <div v-if="issue.ac_total > 0" class="ac-wrap">
      <ACBar :done="issue.ac_done" :total="issue.ac_total" />
    </div>

    <div class="footer">
      <button
        v-if="issue.parent_id"
        type="button"
        class="parent-chip"
        :title="`Parent epic ${issue.parent_id}`"
        @click="onParentClick"
      >↑ {{ issue.parent_id }}</button>
      <span v-if="issue.comments_count > 0" class="comments">
        <span class="emoji">💬</span>{{ issue.comments_count }}
      </span>
      <span v-if="issue.has_retro" class="retro">retro</span>
      <span class="updated">{{ updatedLabel }}</span>
    </div>
  </button>
</template>

<style scoped>
.issue-card {
  text-align: left;
  width: 100%;
  display: block;
  background: rgb(15 23 42 / 0.7);
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  font-family: inherit;
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.2);
  transition: background-color 150ms, transform 100ms;
}
.issue-card.epic {
  background: rgb(30 27 75 / 0.45);
  border-color: rgb(99 102 241 / 0.35);
  border-left: 3px solid #6366f1;
}
.issue-card.blocked {
  border-left: 3px solid #ef4444;
}
.issue-card:hover {
  transform: translateY(-1px);
}
.issue-card.scoped {
  background: rgb(99 102 241 / 0.08);
  border-color: rgb(99 102 241 / 0.5);
  box-shadow:
    0 0 0 1px rgb(99 102 241 / 0.2),
    0 4px 12px rgb(99 102 241 / 0.08);
}
.issue-card.scoped.epic {
  border-left: 3px solid #6366f1;
}
.issue-card.scoped.blocked {
  border-left: 3px solid #ef4444;
}
.issue-card.dimmed {
  opacity: 0.32;
}
.issue-card.dimmed:hover {
  transform: none;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.id-chip {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.children-count-chip {
  font-size: 10px;
  font-weight: 500;
  color: #a5b4fc;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(99 102 241 / 0.12);
}
.blocked-badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  color: #fca5a5;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.blocked-glyph {
  font-size: 9px;
}
.title {
  font-size: 13px;
  font-weight: 500;
  color: #e2e8f0;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ac-wrap {
  margin-top: 8px;
}
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 11px;
  color: #64748b;
}
.parent-chip {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  color: #a5b4fc;
  background: rgb(99 102 241 / 0.12);
  border: 1px solid rgb(99 102 241 / 0.25);
  cursor: pointer;
  font-family: inherit;
}
.comments {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.comments .emoji {
  font-size: 10px;
}
.retro {
  color: #86efac;
  font-size: 10px;
}
.updated {
  margin-left: auto;
  font-size: 10px;
}
</style>
