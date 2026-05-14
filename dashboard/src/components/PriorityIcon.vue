<script setup lang="ts">
/**
 * Single-glyph priority indicator. The numeric `priority` field on
 * every issue maps to one of six tiers via `priorityTier()` (sourced
 * from the backend module so dashboard + dispatcher share one
 * classification). Each tier picks a distinct glyph + color so an
 * operator can rank the board's cards at a glance without reading
 * numeric values.
 *
 * Two size variants: `sm` for board-tile placement (10px glyph) and
 * `md` for drawer-header placement (14px glyph). The `title` +
 * `aria-label` carry the human tier label so a hover or screen-reader
 * pass surfaces the same information as the visual rank.
 *
 * The dashboard does not depend on `lucide-vue-next`; we use Unicode
 * triangles + flame glyph instead. Visual order — paired-down → down
 * → dash → up → paired-up → flame — preserves the low→high reading
 * lucide's ChevronsDown/ChevronDown/Minus/ChevronUp/ChevronsUp/Flame
 * series would have produced.
 */
import { computed } from "vue";
import { priorityTier, type PriorityTierKey } from "../lib/priorityTier";

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
  glyph: string;
  label: string;
  color: string;
}

const TIER_META: Record<PriorityTierKey, TierMeta> = {
  lowest: { glyph: "⏬", label: "Lowest", color: "#94a3b8" },
  low: { glyph: "▼", label: "Low", color: "#60a5fa" },
  medium: { glyph: "─", label: "Medium", color: "#34d399" },
  high: { glyph: "▲", label: "High", color: "#fbbf24" },
  very_high: { glyph: "⏫", label: "Very High", color: "#f97316" },
  critical: { glyph: "🔥", label: "Critical", color: "#ef4444" },
};

const tier = computed(() => priorityTier(props.priority));
const meta = computed(() => TIER_META[tier.value]);
</script>

<template>
  <span
    class="priority-icon"
    :class="`priority-${tier} priority-size-${props.size}`"
    :style="{ color: meta.color }"
    :title="meta.label"
    :aria-label="`Priority: ${meta.label}`"
    data-test="priority-icon"
  >{{ meta.glyph }}</span>
</template>

<style scoped>
.priority-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  cursor: help;
  font-variant-numeric: tabular-nums;
}
.priority-size-sm {
  font-size: 10px;
  min-width: 12px;
}
.priority-size-md {
  font-size: 14px;
  min-width: 16px;
}
</style>
