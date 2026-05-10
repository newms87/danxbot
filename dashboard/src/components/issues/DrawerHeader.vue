<script setup lang="ts">
import type { IssueDetail } from "../../types";
import TypeBadge from "./TypeBadge.vue";
import AgentBadge from "../AgentBadge.vue";
import IssueAgeBadge from "../IssueAgeBadge.vue";

import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    issue: IssueDetail;
    repo: string;
    scopedEpicId: string | null;
    showClose?: boolean;
  }>(),
  { showClose: true },
);

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
  "toggle-scope": [];
  "open-agent": [];
}>();

const scopeTarget = computed<string | null>(() => {
  if (props.issue.type === "Epic") return props.issue.id;
  return props.issue.parent_id ?? null;
});

const isScoped = computed(
  () => !!props.scopedEpicId && props.scopedEpicId === scopeTarget.value,
);

const blockedByCard = computed(
  () => !!props.issue.waiting_on && props.issue.waiting_on.by.length > 0,
);
</script>

<template>
  <div class="header">
    <div class="meta-row">
      <span class="id">{{ issue.id }}</span>
      <TypeBadge :type="issue.type" />
      <span class="status-pill">{{ issue.status }}</span>
      <span
        v-if="issue.waiting_on"
        class="blocked-badge"
        :class="{ 'by-card': blockedByCard }"
      >{{ blockedByCard ? "⏸ Blocked by" : "⛔ Blocked" }}</span>
      <span class="age-slot">
        <IssueAgeBadge
          :updated-at="issue.updated_at"
          :created-at="issue.created_at"
        />
      </span>
      <button
        v-if="props.showClose"
        type="button"
        class="close"
        aria-label="Close"
        @click="emit('close')"
      >×</button>
    </div>
    <h2 class="title">{{ issue.title }}</h2>
    <div v-if="issue.assigned_agent" class="agent-row">
      <button
        type="button"
        class="agent-link"
        :data-test="`drawer-agent-${issue.assigned_agent}`"
        @click="emit('open-agent')"
      >
        <AgentBadge
          :repo="props.repo"
          :agent-name="issue.assigned_agent"
          size="md"
        />
      </button>
    </div>
    <div
      v-if="issue.parent_id || (issue.children && issue.children.length > 0) || scopeTarget"
      class="rel-row"
    >
      <button
        v-if="issue.parent_id"
        type="button"
        class="parent-chip"
        @click="emit('jump-issue', issue.parent_id!)"
      >↑ Parent: {{ issue.parent_id }}</button>
      <span v-if="issue.children.length > 0" class="children-count">
        {{ issue.children.length }} children
      </span>
      <button
        v-if="scopeTarget"
        type="button"
        class="scope-toggle"
        :class="{ active: isScoped }"
        @click="emit('toggle-scope')"
      >{{ isScoped ? "✓ Scoped to epic" : "Scope board to epic" }}</button>
    </div>
  </div>
</template>

<style scoped>
.header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.id {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.status-pill {
  font-size: 11px;
  font-weight: 500;
  color: #cbd5e1;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(51 65 85 / 0.5);
  text-transform: capitalize;
}
.blocked-badge {
  font-size: 11px;
  font-weight: 600;
  color: #fca5a5;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(239 68 68 / 0.15);
  border: 1px solid rgb(239 68 68 / 0.3);
}
.blocked-badge.by-card {
  color: #fcd34d;
  background: rgb(245 158 11 / 0.15);
  border-color: rgb(245 158 11 / 0.35);
}
.age-slot {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
}
.close {
  background: none;
  border: 0;
  color: #94a3b8;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
  font-family: inherit;
}
.title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #f1f5f9;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.agent-row {
  display: flex;
  align-items: center;
}
.agent-link {
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.agent-link:hover :deep(.agent-badge) {
  background: rgb(99 102 241 / 0.18);
  border-color: rgb(99 102 241 / 0.45);
}
.rel-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.parent-chip {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #a5b4fc;
  background: rgb(99 102 241 / 0.12);
  border: 1px solid rgb(99 102 241 / 0.3);
  cursor: pointer;
  font-family: inherit;
}
.children-count {
  font-size: 11px;
  color: #64748b;
}
.scope-toggle {
  margin-left: auto;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #94a3b8;
  background: rgb(30 41 59 / 0.5);
  border: 1px solid #334155;
  cursor: pointer;
  font-family: inherit;
}
.scope-toggle.active {
  color: #fcd34d;
  background: rgb(245 158 11 / 0.12);
  border-color: rgb(245 158 11 / 0.3);
}
</style>
