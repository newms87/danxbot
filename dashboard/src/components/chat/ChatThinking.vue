<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ text: string }>();
const open = ref(false);

const preview = computed(() => {
  const t = props.text;
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
});
</script>

<template>
  <div class="thinking">
    <button type="button" class="toggle" :aria-expanded="open" @click="open = !open">
      <span class="caret">{{ open ? "▾" : "▸" }}</span>
      <span class="label">Thinking</span>
      <span v-if="!open" class="preview">{{ preview }}</span>
    </button>
    <div v-if="open" class="body">{{ text }}</div>
  </div>
</template>

<style scoped>
.thinking {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgb(15 23 42 / 0.5);
  border: 1px solid #1e293b;
  font-size: 12px;
}
.toggle {
  background: none;
  border: 0;
  font-family: inherit;
  cursor: pointer;
  color: #94a3b8;
  padding: 0;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.caret {
  font-size: 10px;
}
.preview {
  color: #64748b;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  font-style: italic;
}
.body {
  margin-top: 6px;
  color: #94a3b8;
  font-style: italic;
  line-height: 1.5;
  text-wrap: pretty;
  white-space: pre-wrap;
}
</style>
