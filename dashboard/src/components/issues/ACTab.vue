<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail } from "../../types";
import ACBar from "./ACBar.vue";
import { acCounts } from "./acCounts";

const props = defineProps<{
  issue: IssueDetail;
}>();

const counts = computed(() => acCounts(props.issue.ac));
</script>

<template>
  <div v-if="issue.ac.length === 0" class="empty">
    No acceptance criteria.
  </div>
  <div v-else class="ac-tab">
    <div class="bar-row">
      <ACBar :done="counts.done" :total="counts.total" />
    </div>
    <div class="ac-list">
      <div
        v-for="(a, i) in issue.ac"
        :key="i"
        class="ac-row"
        :class="{ done: a.checked }"
      >
        <span class="ac-chip" :class="{ done: a.checked }">{{ a.checked ? "✓" : "" }}</span>
        <span class="ac-text">{{ a.title }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty {
  padding: 40px;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
.ac-tab {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bar-row {
  display: flex;
  align-items: center;
}
.ac-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ac-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: #e2e8f0;
  line-height: 1.4;
}
.ac-row.done {
  color: #64748b;
}
.ac-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  flex-shrink: 0;
  margin-top: 1px;
  background: rgb(51 65 85 / 0.5);
  color: #475569;
  font-size: 11px;
  font-weight: 700;
}
.ac-chip.done {
  background: rgb(16 185 129 / 0.18);
  color: #6ee7b7;
}
.ac-text {
  text-wrap: pretty;
}
.ac-row.done .ac-text {
  text-decoration: line-through;
}
</style>
