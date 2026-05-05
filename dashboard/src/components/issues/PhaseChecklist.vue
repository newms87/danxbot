<script setup lang="ts">
import type { IssueListPhase } from "@backend/dashboard/issues-reader.js";
import { PHASE_STATUS_META } from "./issuePalette";

defineProps<{
  phases: IssueListPhase[];
}>();
</script>

<template>
  <div class="checklist">
    <div
      v-for="(p, i) in phases"
      :key="i"
      class="row"
      :class="{ done: p.status === 'done' }"
    >
      <span
        class="chip"
        :style="{
          background: PHASE_STATUS_META[p.status].bg,
          color: PHASE_STATUS_META[p.status].fg,
        }"
      >{{ PHASE_STATUS_META[p.status].glyph }}</span>
      <span class="label">{{ i + 1 }}: {{ p.name }}</span>
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
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
