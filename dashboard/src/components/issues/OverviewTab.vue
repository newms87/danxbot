<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail, IssueListItem, PhaseStatus } from "../../types";
import type { PhaseStatusId } from "@backend/dashboard/issues-reader.js";
import TypeBadge from "./TypeBadge.vue";
import MarkdownView from "./MarkdownView.vue";
import { PHASE_STATUS_META } from "./issuePalette";

const props = defineProps<{
  issue: IssueDetail;
  allIssues: IssueListItem[];
}>();

const emit = defineEmits<{
  "jump-issue": [id: string];
}>();

const PHASE_STATUS_TO_ID: Record<PhaseStatus, PhaseStatusId> = {
  Complete: "done",
  Pending: "todo",
  Blocked: "blocked",
};

const acDone = computed(() => props.issue.ac.filter((a) => a.checked).length);

const childIssues = computed(() =>
  props.issue.children
    .map((id) => props.allIssues.find((i) => i.id === id))
    .filter((i): i is IssueListItem => Boolean(i)),
);

function phaseMeta(status: PhaseStatus) {
  return PHASE_STATUS_META[PHASE_STATUS_TO_ID[status]];
}
</script>

<template>
  <div class="overview">
    <section v-if="issue.description">
      <div class="section-label">Description</div>
      <MarkdownView :text="issue.description" />
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

    <section v-if="issue.ac.length > 0">
      <div class="section-label">
        <span>Acceptance Criteria</span>
        <span class="ac-count">{{ acDone }}/{{ issue.ac.length }}</span>
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
    </section>

    <section v-if="issue.phases.length > 0">
      <div class="section-label">Phases</div>
      <div class="phase-list">
        <div
          v-for="(p, i) in issue.phases"
          :key="i"
          class="phase-row"
        >
          <span
            class="phase-chip"
            :style="{ background: phaseMeta(p.status).bg, color: phaseMeta(p.status).fg }"
          >{{ phaseMeta(p.status).glyph }}</span>
          <span class="phase-name">
            <span class="phase-num">{{ i + 1 }}.</span> {{ p.title }}
          </span>
          <span
            class="phase-pill"
            :style="{ background: phaseMeta(p.status).bg, color: phaseMeta(p.status).fg }"
          >{{ p.status }}</span>
        </div>
      </div>
    </section>

    <section v-if="childIssues.length > 0">
      <div class="section-label">Children · {{ childIssues.length }}</div>
      <div class="child-list">
        <button
          v-for="c in childIssues"
          :key="c.id"
          type="button"
          class="child-row"
          @click="emit('jump-issue', c.id)"
        >
          <span class="child-id">{{ c.id }}</span>
          <TypeBadge :type="c.type" compact />
          <span class="child-title">{{ c.title }}</span>
          <span class="child-status">{{ c.status }}</span>
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
.ac-count {
  color: #94a3b8;
  font-weight: 400;
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
.phase-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.phase-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
}
.phase-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}
.phase-name {
  flex: 1;
  font-size: 13px;
  color: #e2e8f0;
}
.phase-num {
  color: #64748b;
}
.phase-pill {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: capitalize;
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
.child-status {
  font-size: 10px;
  color: #94a3b8;
  text-transform: capitalize;
}
</style>
