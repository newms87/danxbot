<script setup lang="ts">
import { computed } from "vue";
import type { IssueType } from "../../types";
import { ISSUE_TYPE_META, typeToId } from "./issuePalette";

const props = defineProps<{
  type: IssueType;
  compact?: boolean;
}>();

const meta = computed(() => ISSUE_TYPE_META[typeToId(props.type)]);
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
