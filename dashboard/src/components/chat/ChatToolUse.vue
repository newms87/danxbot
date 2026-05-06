<script setup lang="ts">
import { computed, ref } from "vue";

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResult {
  toolUseId: string;
  result: string;
}

const props = defineProps<{
  block: ToolUse;
  result: ToolResult | null;
}>();

const open = ref(false);

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const summary = computed<string>(() => {
  const inp = props.block.input ?? {};
  const candidate = asString(inp.path) ?? asString(inp.command) ?? asString(inp.pattern);
  if (candidate) return candidate;
  const json = JSON.stringify(inp);
  return json.length > 60 ? `${json.slice(0, 60)}…` : json;
});

const inputJson = computed(() => JSON.stringify(props.block.input, null, 2));
</script>

<template>
  <div class="tool-use">
    <button type="button" class="header" :aria-expanded="open" @click="open = !open">
      <span class="caret">{{ open ? "▾" : "▸" }}</span>
      <span class="name">{{ block.name }}</span>
      <span class="summary">{{ summary }}</span>
      <span v-if="result" class="check">✓</span>
    </button>
    <div v-if="open" class="body">
      <pre class="input">{{ inputJson }}</pre>
      <div v-if="result" class="result">{{ result.result }}</div>
    </div>
  </div>
</template>

<style scoped>
.tool-use {
  margin-bottom: 8px;
  border-radius: 6px;
  overflow: hidden;
  background: rgb(99 102 241 / 0.05);
  border: 1px solid rgb(99 102 241 / 0.2);
}
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.caret {
  font-size: 10px;
  color: #a5b4fc;
}
.name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #c7d2fe;
  font-weight: 600;
}
.summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #64748b;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check {
  font-size: 10px;
  color: #6ee7b7;
}
.body {
  padding: 0 10px 8px;
}
.input {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #a5b4fc;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgb(2 6 23 / 0.5);
  padding: 6px 8px;
  border-radius: 4px;
}
.result {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgb(2 6 23 / 0.5);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}
</style>
