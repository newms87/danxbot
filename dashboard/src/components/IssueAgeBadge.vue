<script setup lang="ts">
/**
 * IssueAgeBadge — paired "X ago | X old" indicator for any timestamp pair
 * where the consumer cares about both freshness (`updatedAt`) and
 * lifetime (`createdAt`).
 *
 * Visual hierarchy: the `ago` half is the foreground signal (more
 * saturated color, higher weight) because it's the actionable one —
 * "is this card progressing?". The `old` half is the secondary
 * lifetime hint (muted) — useful for triage but not what an operator
 * scans for first.
 *
 * Hover reveals a unified `DanxTooltip` with both absolute timestamps
 * in a two-row grid. One tooltip, two rows — avoids the "two separate
 * tooltips overlapping" UX pitfall.
 *
 * Live updates: uses `useNowTick` so labels refresh once a minute while
 * mounted. No server calls; pure presentation.
 *
 * Reusable across Issue cards / drawer / detail view. Two number props,
 * nothing else.
 */
import { computed } from "vue";
import { DanxTooltip } from "@thehammer/danx-ui";
import { relativeOld, relativeTime } from "../utils/relativeTime";
import { formatAbsoluteDateTime } from "../utils/format";
import { useNowTick } from "../composables/useNowTick";

const props = defineProps<{
  /** Last-modified timestamp (epoch ms). Drives the brighter "ago" label. */
  updatedAt: number;
  /** Creation timestamp (epoch ms). Drives the muted "old" label. */
  createdAt: number;
}>();

const now = useNowTick();

const agoLabel = computed(() => relativeTime(props.updatedAt, now.value));
const oldLabel = computed(() => relativeOld(props.createdAt, now.value));

const updatedAbsolute = computed(() =>
  formatAbsoluteDateTime(props.updatedAt),
);
const createdAbsolute = computed(() =>
  formatAbsoluteDateTime(props.createdAt),
);
</script>

<template>
  <DanxTooltip>
    <template #trigger>
      <span class="age-badge" data-test="issue-age-badge">
        <span class="ago" data-test="issue-age-ago">{{ agoLabel }}</span>
        <span class="sep" aria-hidden="true">|</span>
        <span class="old" data-test="issue-age-old">{{ oldLabel }}</span>
      </span>
    </template>
    <template #default>
      <div class="age-tooltip" data-test="issue-age-tooltip">
        <span class="row-label">Updated</span>
        <span class="row-value">{{ updatedAbsolute }}</span>
        <span class="row-label">Created</span>
        <span class="row-value">{{ createdAbsolute }}</span>
      </div>
    </template>
  </DanxTooltip>
</template>

<style scoped>
.age-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: help;
}
.ago {
  color: #93c5fd;
  font-weight: 600;
}
.sep {
  color: #475569;
  user-select: none;
}
.old {
  color: #64748b;
  font-weight: 400;
}
.age-tooltip {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 12px;
  row-gap: 4px;
  padding: 2px 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.row-label {
  color: #94a3b8;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
  align-self: center;
}
.row-value {
  color: #f1f5f9;
}
</style>
