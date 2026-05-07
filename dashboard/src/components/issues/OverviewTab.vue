<script setup lang="ts">
import type { IssueDetail, IssueListItem } from "../../types";
import { MarkdownEditor } from "@thehammer/danx-ui";

defineProps<{
  issue: IssueDetail;
  allIssues: IssueListItem[];
}>();

defineEmits<{
  "jump-issue": [id: string];
}>();
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
          @click="$emit('jump-issue', bid)"
        >{{ bid }}</button>
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
</style>
