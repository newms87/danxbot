<script setup lang="ts">
import { computed } from "vue";
import type { IssueType } from "../../types";

const props = defineProps<{
  type: IssueType;
  compact?: boolean;
}>();

const META: Record<IssueType, { label: string; fg: string; bg: string; border: string }> = {
  Epic:    { label: "Epic",    fg: "#a5b4fc", bg: "rgb(99 102 241 / 0.15)", border: "rgb(99 102 241 / 0.35)" },
  Bug:     { label: "Bug",     fg: "#fca5a5", bg: "rgb(239 68 68 / 0.15)",  border: "rgb(239 68 68 / 0.35)" },
  Feature: { label: "Feature", fg: "#86efac", bg: "rgb(16 185 129 / 0.15)", border: "rgb(16 185 129 / 0.35)" },
};

const meta = computed(() => META[props.type]);
</script>

<template>
  <span
    class="type-badge"
    :class="{ compact }"
    :style="{ background: meta.bg, color: meta.fg, border: `1px solid ${meta.border}` }"
  >{{ meta.label }}</span>
</template>

<style scoped>
.type-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.type-badge.compact {
  padding: 1px 6px;
}
</style>
