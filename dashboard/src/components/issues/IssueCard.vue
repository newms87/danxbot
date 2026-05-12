<script setup lang="ts">
import { computed } from "vue";
import type { IssueListItem } from "../../types";
import type { CardDragHandlers } from "../../composables/useCardDrag";
import TypeBadge from "./TypeBadge.vue";
import ChildrenChecklist from "./ChildrenChecklist.vue";
import ACBar from "./ACBar.vue";
import AgentBadge from "../AgentBadge.vue";
import { COLUMN_ACCENTS } from "./issuePalette";
import IssueAgeBadge from "../IssueAgeBadge.vue";

const props = withDefaults(
  defineProps<{
    issue: IssueListItem;
    repo: string;
    dimmed?: boolean;
    scoped?: boolean;
    showStatus?: boolean;
    /** `true` when this card is the active drag source (board-side ghost). */
    dragging?: boolean;
    /**
     * HTML5 DnD handlers from `useCardDrag().bindCard(issue)`. Optional
     * so non-board consumers (drawer, dialog) skip the drag wiring.
     */
    dragHandlers?: CardDragHandlers;
  }>(),
  { dimmed: false, scoped: false, showStatus: false, dragging: false },
);

const emit = defineEmits<{
  select: [issue: IssueListItem];
  "parent-click": [parentId: string];
}>();

const isEpic = computed(() => props.issue.type === "Epic");
// DX-309 — three independent dispatch gates rendered as separate pills.
// Legacy single-`blocked` (mapping to waiting_on) replaced by the trio.
const selfBlocked = computed(() => props.issue.blocked);
const waitingOn = computed(() => props.issue.waiting_on);
const waitingOnIds = computed(() => props.issue.waiting_on_by ?? []);
const conflictEntries = computed(() => props.issue.conflict_on ?? []);
const conflictActiveCount = computed(
  () => props.issue.conflict_on_active_count ?? 0,
);
const hasAnyGate = computed(
  () =>
    selfBlocked.value !== null ||
    waitingOn.value ||
    conflictActiveCount.value > 0 ||
    conflictEntries.value.length > 0,
);
const waitingOnTooltip = computed(() => {
  if (!waitingOn.value) return undefined;
  const reason = props.issue.waiting_on_reason ?? "";
  return waitingOnIds.value.length > 0
    ? `Waiting on ${waitingOnIds.value.join(", ")}${reason ? ` — ${reason}` : ""}`
    : reason;
});
const conflictTooltip = computed(() => {
  const entries = conflictEntries.value;
  if (entries.length === 0 && conflictActiveCount.value === 0) return undefined;
  const ids = entries.map((e) => e.id).join(", ");
  const active = conflictActiveCount.value;
  const head = active > 0 ? `${active} active conflict${active === 1 ? "" : "s"}` : `${entries.length} declared`;
  return ids ? `${head} — ${ids}` : head;
});
const statusMeta = computed(() => COLUMN_ACCENTS[props.issue.status]);

// Unified `children[]` (ISS-81). Epic = phase cards (label "Phases"),
// non-epic = sub-cards (label "Children"). Same render shape either way.
const childrenDetail = computed(() => props.issue.children_detail);
const childrenLabel = computed(() => (isEpic.value ? "phases" : "children"));

// DX-239 / P8 of DX-231 — `requires_human` indicators on the card.
// Two surfaces: the 👤 chip on the card itself (when this card has the
// field set), and an Epic-level aggregated "👤 N" chip (DX-267) when
// any of the epic's phase children is flagged. Tooltip on the self-chip
// truncates the reason at 80 chars to fit Trello-card width without
// reflow. The rollup count is read from the backend payload
// (`requires_human_child_count`) instead of derived inline so the SSE
// `issue:updated` pipeline can refresh the badge from the same source
// the backend computes — single source of truth, no SPA-side divergence.
const requiresHuman = computed(() => props.issue.requires_human);
const requiresHumanTooltip = computed(() => {
  const r = requiresHuman.value;
  if (!r) return undefined;
  return r.reason.length > 80 ? `${r.reason.slice(0, 77)}…` : r.reason;
});
const requiresHumanChildCount = computed(
  () => props.issue.requires_human_child_count,
);
// AC #2: only Epic cards surface the rollup chip. Non-Epic parents
// (rare, but supported by the data model) get the count emitted on
// their payload too — they just don't render it.
const showRequiresHumanChildrenChip = computed(
  () => isEpic.value && requiresHumanChildCount.value > 0,
);

function onParentClick(e: MouseEvent): void {
  e.stopPropagation();
  if (props.issue.parent_id) emit("parent-click", props.issue.parent_id);
}
</script>

<template>
  <button
    class="issue-card"
    :class="{ epic: isEpic, 'self-blocked': selfBlocked, 'waiting-on': waitingOn && !selfBlocked, conflict: conflictActiveCount > 0 && !selfBlocked && !waitingOn, dimmed: props.dimmed, scoped: props.scoped, 'is-dragging': props.dragging }"
    type="button"
    :draggable="props.dragHandlers ? true : undefined"
    @click="emit('select', issue)"
    @dragstart="props.dragHandlers?.onDragstart($event)"
    @dragend="props.dragHandlers?.onDragend($event)"
  >
    <div class="card-header">
      <span class="id-chip">{{ issue.id }}</span>
      <TypeBadge :type="issue.type" compact />
      <span
        v-if="props.showStatus"
        class="status-pill"
        :style="{ color: statusMeta.accent, borderColor: statusMeta.accent }"
      >{{ statusMeta.label }}</span>
      <span v-if="childrenDetail.length > 0" class="children-count-chip">
        {{ childrenDetail.length }} {{ childrenLabel }}
      </span>
      <span
        v-if="showRequiresHumanChildrenChip"
        class="requires-human-children-chip"
        :title="`${requiresHumanChildCount} ${requiresHumanChildCount === 1 ? 'phase needs' : 'phases need'} human action`"
        data-test="requires-human-children-chip"
      >👤 {{ requiresHumanChildCount }}</span>
      <span
        v-if="requiresHuman"
        class="requires-human-badge"
        :title="requiresHumanTooltip"
        data-test="requires-human-badge"
      >👤</span>
      <span v-if="hasAnyGate" class="gates-wrap">
      <span
        v-if="selfBlocked"
        class="gate-pill gate-blocked"
        :title="selfBlocked.reason"
        data-test="blocked-pill"
      >
        <span class="gate-glyph">🔒</span>
        BLOCKED
      </span>
      <span
        v-if="waitingOn"
        class="gate-pill gate-waiting"
        :title="waitingOnTooltip"
        data-test="waiting-on-pill"
      >
        <span class="gate-glyph">⏳</span>
        WAITING ON {{ waitingOnIds.length }}
      </span>
      <span
        v-if="conflictActiveCount > 0 || conflictEntries.length > 0"
        class="gate-pill gate-conflict"
        :class="{ 'gate-conflict-audit': conflictActiveCount === 0 }"
        :title="conflictTooltip"
        data-test="conflict-pill"
      >
        <span class="gate-glyph">⚡</span>
        CONFLICT {{ conflictActiveCount > 0 ? conflictActiveCount : conflictEntries.length }}
      </span>
      </span>
      <AgentBadge
        v-if="issue.assigned_agent"
        :class="{ 'ml-auto': !hasAnyGate }"
        class="row-agent"
        :repo="props.repo"
        :agent-name="issue.assigned_agent"
        size="sm"
      />
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
      <span class="age-slot" @click.stop>
        <IssueAgeBadge
          :updated-at="issue.updated_at"
          :created-at="issue.created_at"
        />
      </span>
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
.issue-card.self-blocked {
  border-left: 3px solid #ef4444;
}
.issue-card.waiting-on {
  border-left: 3px solid #f59e0b;
}
.issue-card.conflict {
  border-left: 3px solid #a855f7;
}
.requires-human-badge {
  font-size: 12px;
  line-height: 1;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgb(249 115 22 / 0.15);
  border: 1px solid rgb(249 115 22 / 0.4);
  cursor: help;
}
.requires-human-children-chip {
  font-size: 10px;
  font-weight: 600;
  color: #fdba74;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(249 115 22 / 0.12);
  border: 1px solid rgb(249 115 22 / 0.25);
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
.issue-card.scoped.self-blocked {
  border-left: 3px solid #ef4444;
}
.issue-card.scoped.waiting-on {
  border-left: 3px solid #f59e0b;
}
.issue-card.scoped.conflict {
  border-left: 3px solid #a855f7;
}
.issue-card.dimmed {
  opacity: 0.32;
}
.issue-card.dimmed:hover {
  transform: none;
}
.issue-card.is-dragging {
  opacity: 0.4;
  pointer-events: none;
}
.issue-card.is-dragging:hover {
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
.status-pill {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border: 1px solid;
  border-radius: 4px;
  background: rgb(15 23 42 / 0.4);
}
.row-agent {
  margin-left: 4px;
}
.row-agent.ml-auto {
  margin-left: auto;
}
.gates-wrap {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.gate-pill {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: help;
}
.gate-blocked {
  background: rgb(239 68 68 / 0.15);
  border: 1px solid rgb(239 68 68 / 0.4);
  color: #fca5a5;
}
.gate-waiting {
  background: rgb(245 158 11 / 0.12);
  border: 1px solid rgb(245 158 11 / 0.35);
  color: #fcd34d;
}
.gate-conflict {
  background: rgb(168 85 247 / 0.14);
  border: 1px solid rgb(168 85 247 / 0.4);
  color: #d8b4fe;
}
.gate-conflict.gate-conflict-audit {
  background: rgb(168 85 247 / 0.06);
  border: 1px dashed rgb(168 85 247 / 0.3);
  color: #c4b5fd;
}
.gate-glyph {
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
.age-slot {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
}
</style>
