<script setup lang="ts">
/**
 * AgentAvatarStack — DX-524.
 *
 * Compact "who is working on this card's subtree" indicator surfaced on
 * parent rows in the issue list. Distinct-by-`agent` avatars are stacked
 * with a small horizontal overlap and capped at `max` (default 3); the
 * overflow renders as a `+N` chip after the visible group. The whole
 * stack wraps in ONE `DanxTooltip` whose body lists every (agent,
 * issue_id, issue_title) entry the backend emitted — capped only by the
 * caller's data, never by the visible-avatar cap.
 *
 * Avatar lookup is delegated to `AgentAvatar` (which falls back to the
 * initials renderer when no `avatar_path` is passed) so missing agents
 * (deleted from `settings.agents` mid-flight) render gracefully without
 * crashing — they just show the raw name + initial-fallback avatar.
 *
 * Pure presentation: consumes props only, never imports from `api.ts`.
 * The parent's `child_assignments[]` is computed server-side
 * (issues-reader#collectChildAssignments) and threaded through the
 * existing SSE `issue:updated` pipeline.
 */
import { computed } from "vue";
import { DanxTooltip } from "@thehammer/danx-ui";
import AgentAvatar from "./AgentAvatar.vue";
import type { IssueListChildAssignment } from "../../types";

const props = withDefaults(
  defineProps<{
    /** Repo name — required so AgentAvatar can resolve avatar URLs. */
    repo: string;
    /**
     * Full per-(agent, child) assignment list from the backend. NOT
     * pre-deduped; this component derives the distinct-agent count for
     * the cap and renders every entry in the tooltip.
     */
    assignments: IssueListChildAssignment[];
    /** Maximum number of distinct-agent avatars to render before the +N chip. */
    max?: number;
  }>(),
  { max: 3 },
);

/**
 * Distinct-by-`agent` list preserving the first-seen order. The
 * backend's walk is deterministic (child order = parent's `children[]`
 * order); deduplication here lets a single agent who owns multiple
 * children still appear ONCE in the avatar row while every (agent,
 * child) pair stays available for the tooltip.
 */
const distinctAgents = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of props.assignments) {
    if (seen.has(a.agent)) continue;
    seen.add(a.agent);
    out.push(a.agent);
  }
  return out;
});

const visibleAgents = computed(() =>
  distinctAgents.value.slice(0, props.max),
);

const overflowCount = computed(() =>
  Math.max(0, distinctAgents.value.length - props.max),
);
</script>

<template>
  <DanxTooltip>
    <template #trigger>
      <span
        class="agent-avatar-stack"
        data-test="agent-avatar-stack"
      >
        <span
          v-for="(name, idx) in visibleAgents"
          :key="name"
          class="stack-slot"
          :style="{ zIndex: visibleAgents.length - idx }"
          :data-test="`stack-avatar-${name}`"
        >
          <AgentAvatar
            :repo="props.repo"
            :name="name"
            :size="20"
          />
        </span>
        <span
          v-if="overflowCount > 0"
          class="overflow-chip"
          data-test="stack-overflow-chip"
        >+{{ overflowCount }}</span>
      </span>
    </template>
    <template #default>
      <div class="stack-tooltip" data-test="agent-avatar-stack-tooltip">
        <div
          v-for="entry in props.assignments"
          :key="`${entry.agent}|${entry.issue_id}`"
          class="tooltip-row"
          :data-test="`stack-tooltip-row-${entry.agent}-${entry.issue_id}`"
        >
          <AgentAvatar
            :repo="props.repo"
            :name="entry.agent"
            :size="18"
          />
          <span class="tooltip-text">
            <span class="row-name">{{ entry.agent }}</span>
            <span
              v-if="entry.issue_title"
              class="row-issue"
            >{{ entry.issue_id }}: {{ entry.issue_title }}</span>
          </span>
        </div>
      </div>
    </template>
  </DanxTooltip>
</template>

<style scoped>
.agent-avatar-stack {
  display: inline-flex;
  align-items: center;
  cursor: help;
}
.stack-slot {
  display: inline-flex;
  align-items: center;
  margin-left: -6px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgb(15 23 42 / 0.95);
}
.stack-slot:first-child {
  margin-left: 0;
}
.overflow-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 4px;
  height: 20px;
  min-width: 20px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 600;
  color: #c7d2fe;
  background: rgb(99 102 241 / 0.18);
  border: 1px solid rgb(99 102 241 / 0.4);
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}
.stack-tooltip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 200px;
  max-width: 320px;
  padding: 2px 0;
}
.tooltip-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tooltip-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.25;
  min-width: 0;
}
.row-name {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}
.row-issue {
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
