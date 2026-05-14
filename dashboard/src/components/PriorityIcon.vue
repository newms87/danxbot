<script setup lang="ts">
/**
 * Single-glyph priority indicator. The numeric `priority` field on
 * every issue maps to one of six tiers via `priorityTier()` (sourced
 * from the backend module so dashboard + dispatcher share one
 * classification). Each tier picks a distinct FontAwesome glyph from
 * `danx-icon` plus a heat-ramp color so an operator can rank the
 * board's cards at a glance.
 *
 * Color ramp: gray → green → yellow → orange → red.
 * SVGs use `fill="currentColor"`, so the wrapper's `color` style
 * paints them.
 */
import { computed } from "vue";
import { DanxIcon, DanxTooltip } from "@thehammer/danx-ui";
import { priorityTier, type PriorityTierKey } from "../lib/priorityTier";

import anglesDown from "danx-icon/src/fontawesome/solid/angles-down.svg?raw";
import angleDown from "danx-icon/src/fontawesome/solid/angle-down.svg?raw";
import equals from "danx-icon/src/fontawesome/solid/equals.svg?raw";
import angleUp from "danx-icon/src/fontawesome/solid/angle-up.svg?raw";
import anglesUp from "danx-icon/src/fontawesome/solid/angles-up.svg?raw";
import fire from "danx-icon/src/fontawesome/solid/fire.svg?raw";

const props = withDefaults(
  defineProps<{
    /** Numeric priority — clamped to (0, 6) server-side; un-clamped values still classify deterministically. */
    priority: number;
    /** Glyph size — `sm` for compact card tiles, `md` for header pills. */
    size?: "sm" | "md";
  }>(),
  { size: "md" },
);

interface TierMeta {
  icon: string;
  label: string;
  color: string;
}

const TIER_META: Record<PriorityTierKey, TierMeta> = {
  lowest: { icon: anglesDown, label: "Lowest", color: "#94a3b8" },
  low: { icon: angleDown, label: "Low", color: "#22c55e" },
  medium: { icon: equals, label: "Medium", color: "#eab308" },
  high: { icon: angleUp, label: "High", color: "#f97316" },
  very_high: { icon: anglesUp, label: "Very High", color: "#ef4444" },
  critical: { icon: fire, label: "Critical", color: "#b91c1c" },
};

const tier = computed(() => priorityTier(props.priority));
const meta = computed(() => TIER_META[tier.value]);
</script>

<template>
  <DanxTooltip :tooltip="meta.label">
    <template #trigger>
      <span
        class="priority-icon"
        :class="`priority-${tier} priority-size-${props.size}`"
        :style="{ color: meta.color }"
        :aria-label="`Priority: ${meta.label}`"
        data-test="priority-icon"
      >
        <DanxIcon :icon="meta.icon" />
      </span>
    </template>
  </DanxTooltip>
</template>

<style scoped>
.priority-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  cursor: help;
}
.priority-icon :deep(.danx-icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.priority-icon :deep(svg) {
  width: 1em;
  height: 1em;
  display: block;
}
.priority-size-sm {
  font-size: 12px;
  min-width: 12px;
}
.priority-size-md {
  font-size: 16px;
  min-width: 16px;
}
</style>
