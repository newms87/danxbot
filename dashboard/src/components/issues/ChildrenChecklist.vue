<script setup lang="ts">
import { computed } from "vue";
import type { IssueListChild } from "../../types";
import {
  CHILD_STATUS_META,
  COLUMN_ACCENTS,
  projectChildStatus,
} from "./issuePalette";

const props = defineProps<{
  items: IssueListChild[];
}>();

const rows = computed(() =>
  props.items.map((c) => ({
    id: c.id,
    name: c.name,
    paletteStatus: projectChildStatus(c.status, c.blocked, c.blocked_by_card),
    rawStatus: c.status,
    accent: COLUMN_ACCENTS[c.status].accent,
    statusLabel: COLUMN_ACCENTS[c.status].label,
    missing: c.missing,
  })),
);
</script>

<template>
  <div class="checklist">
    <div
      v-for="(c, i) in rows"
      :key="c.id"
      class="row"
      :class="{ done: c.paletteStatus === 'done' }"
    >
      <span
        class="chip"
        :style="{
          background: CHILD_STATUS_META[c.paletteStatus].bg,
          color: CHILD_STATUS_META[c.paletteStatus].fg,
        }"
      >{{ CHILD_STATUS_META[c.paletteStatus].glyph }}</span>
      <span class="id-chip">{{ c.id }}</span>
      <span
        v-if="!c.missing"
        class="status-pill"
        :style="{
          color: c.accent,
          borderColor: c.accent,
        }"
      >{{ c.statusLabel }}</span>
      <span v-else class="status-pill missing">missing</span>
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
.status-pill {
  display: inline-flex;
  align-items: center;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border: 1px solid;
  border-radius: 4px;
  flex-shrink: 0;
  background: rgb(15 23 42 / 0.4);
}
.status-pill.missing {
  color: #94a3b8;
  border-color: #475569;
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
