<script setup lang="ts">
import type { IssueListChild } from "../../types";
import { PHASE_STATUS_META } from "./issuePalette";

defineProps<{
  items: IssueListChild[];
}>();
</script>

<template>
  <div class="checklist">
    <div
      v-for="(c, i) in items"
      :key="c.id"
      class="row"
      :class="{ done: c.status === 'done' }"
    >
      <span
        class="chip"
        :style="{
          background: PHASE_STATUS_META[c.status].bg,
          color: PHASE_STATUS_META[c.status].fg,
        }"
      >{{ PHASE_STATUS_META[c.status].glyph }}</span>
      <span class="id-chip">{{ c.id }}</span>
      <span class="label">{{ i + 1 }}: {{ c.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.checklist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.3;
  color: #cbd5e1;
}
.row.done {
  color: #64748b;
  text-decoration: line-through;
}
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
}
.id-chip {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
