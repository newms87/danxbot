<script setup lang="ts">
import type { IssueDetail } from "../../types";
import TypeBadge from "./TypeBadge.vue";
import { relativeTime } from "../../utils/relativeTime";

defineProps<{
  issue: IssueDetail;
}>();

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
}>();
</script>

<template>
  <div class="header">
    <div class="meta-row">
      <span class="id">{{ issue.id }}</span>
      <TypeBadge :type="issue.type" />
      <span class="status-pill">{{ issue.status }}</span>
      <span v-if="issue.blocked" class="blocked-badge">⛔ Blocked</span>
      <span class="updated">{{ relativeTime(issue.updated_at) }}</span>
      <button
        type="button"
        class="close"
        aria-label="Close"
        @click="emit('close')"
      >×</button>
    </div>
    <h2 class="title">{{ issue.title }}</h2>
    <div
      v-if="issue.parent_id || (issue.children && issue.children.length > 0)"
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
.updated {
  margin-left: auto;
  font-size: 11px;
  color: #64748b;
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
</style>
