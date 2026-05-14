<script setup lang="ts">
/**
 * IceBadge — small monospace pill rendering the triage ICE total with
 * tier-driven color. Three tiers: green (≥60), amber (20-59), gray
 * (<20). Color tokens centralized in `issuePalette.ts#ICE_TIER_META`
 * so DX-514 Phase 3 (Triage tab) can reuse the same palette.
 *
 * Caller is responsible for gating render — the badge renders the
 * passed `total` unconditionally. `IssueCard.vue` hides the badge
 * when `triage.history.length === 0`.
 */
import { computed } from "vue";
import { ICE_TIER_META, iceTier } from "./issuePalette";

const props = defineProps<{
  /** `Issue.triage.ice.total` — the cached `i * c * e` product. */
  total: number;
}>();

const tier = computed(() => iceTier(props.total));
const meta = computed(() => ICE_TIER_META[tier.value]);
</script>

<template>
  <span
    class="ice-badge"
    :class="`ice-${tier}`"
    :style="{
      color: meta.fg,
      background: meta.bg,
      borderColor: meta.border,
    }"
    :title="`ICE ${total}`"
    data-test="ice-badge"
  >ICE {{ total }}</span>
</template>

<style scoped>
.ice-badge {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "Fira Mono", "Roboto Mono", monospace;
  cursor: help;
}
</style>
