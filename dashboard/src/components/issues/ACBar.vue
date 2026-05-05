<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  done: number;
  total: number;
}>();

const pct = computed(() =>
  props.total ? Math.round((props.done / props.total) * 100) : 0,
);

const fill = computed(() => (pct.value === 100 ? "#10b981" : "#6366f1"));
</script>

<template>
  <div class="ac-bar">
    <div class="track">
      <div class="fill" :style="{ width: `${pct}%`, background: fill }" />
    </div>
    <span class="readout">{{ done }}/{{ total }}</span>
  </div>
</template>

<style scoped>
.ac-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.track {
  flex: 1;
  height: 4px;
  border-radius: 9999px;
  background: rgb(51 65 85 / 0.6);
  overflow: hidden;
}
.fill {
  height: 100%;
  transition: width 200ms;
}
.readout {
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}
</style>
