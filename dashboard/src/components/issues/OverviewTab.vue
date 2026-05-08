<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail, IssueListItem } from "../../types";
import { MarkdownEditor } from "@thehammer/danx-ui";

const props = defineProps<{
  issue: IssueDetail;
  allIssues: IssueListItem[];
}>();

defineEmits<{
  "jump-issue": [id: string];
}>();

const blockedByCard = computed(
  () => !!props.issue.waiting_on && props.issue.waiting_on.by.length > 0,
);
</script>

<template>
  <div class="overview">
    <section
      v-if="issue.waiting_on"
      class="blocked-panel"
      :class="{ 'by-card': blockedByCard }"
    >
      <div class="blocked-title">
        <span class="glyph">{{ blockedByCard ? "⏸" : "⛔" }}</span>
        {{ blockedByCard ? "Blocked by" : "Blocked" }}
      </div>
      <div class="blocked-reason">{{ issue.waiting_on.reason }}</div>
      <div v-if="issue.waiting_on.by.length > 0" class="blocked-by">
        <button
          v-for="bid in issue.waiting_on.by"
          :key="bid"
          type="button"
          class="blocker-chip"
          @click="$emit('jump-issue', bid)"
        >{{ bid }}</button>
      </div>
    </section>

    <section v-if="issue.description">
      <div class="section-label">Description</div>
      <MarkdownEditor
        :model-value="issue.description"
        readonly
        hide-footer
      />
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
.blocked-panel.by-card {
  background: rgb(245 158 11 / 0.1);
  border-color: rgb(245 158 11 / 0.35);
}
.blocked-title {
  font-size: 11px;
  font-weight: 600;
  color: #fca5a5;
  margin-bottom: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.blocked-panel.by-card .blocked-title {
  color: #fcd34d;
}
.glyph {
  font-size: 12px;
}
.blocked-reason {
  font-size: 13px;
  color: #fecaca;
  line-height: 1.5;
}
.blocked-panel.by-card .blocked-reason {
  color: #fde68a;
}
.blocked-by {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.blocker-chip {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #fecaca;
  background: rgb(239 68 68 / 0.15);
  border: 1px solid rgb(239 68 68 / 0.3);
  cursor: pointer;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}
.blocked-panel.by-card .blocker-chip {
  color: #fde68a;
  background: rgb(245 158 11 / 0.18);
  border-color: rgb(245 158 11 / 0.4);
}
</style>
