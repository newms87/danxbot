<script setup lang="ts">
import { ref, watch } from "vue";
import { ISSUE_TYPE_META } from "./issuePalette";
import type { IssueTypeFilter, ScopeMode } from "../../composables/useIssueFilters";

const props = defineProps<{
  q: string;
  types: IssueTypeFilter[];
  blockedOnly: boolean;
  showClosed: boolean;
  visibleCount: number;
  totalCount: number;
  scopedEpicId: string | null;
  scopedEpicTitle: string | null;
  scopeMode: ScopeMode;
  showEpicChildren: boolean;
}>();

const emit = defineEmits<{
  "update:q": [value: string];
  "toggle-type": [t: IssueTypeFilter];
  "update:blockedOnly": [value: boolean];
  "update:showClosed": [value: boolean];
  "update:scopeMode": [value: ScopeMode];
  "update:showEpicChildren": [value: boolean];
  "clear-scope": [];
  "open-board-chat": [];
}>();

const SCOPE_MODES: ReadonlyArray<{ id: ScopeMode; label: string }> = [
  { id: "filter", label: "Filter" },
  { id: "highlight", label: "Highlight" },
];

const TYPE_ORDER: ReadonlyArray<IssueTypeFilter> = ["epic", "bug", "feature"];

// Local mirror of `q` so typing stays buttery; debounce 200ms before
// pushing upstream (which mirrors to URL).
const localQ = ref<string>(props.q);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.q,
  (v) => {
    if (v !== localQ.value) localQ.value = v;
  },
);

function onInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  localQ.value = target.value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emit("update:q", localQ.value);
  }, 200);
}

function clearSearch(): void {
  localQ.value = "";
  if (debounceTimer) clearTimeout(debounceTimer);
  emit("update:q", "");
}
</script>

<template>
  <div class="toolbar">
    <div class="row">
      <div class="search" :class="{ active: localQ.length > 0 }">
        <span class="glyph">⌕</span>
        <input
          type="text"
          :value="localQ"
          placeholder="Search id, title, description, comments…"
          aria-label="Search issues"
          @input="onInput"
        />
        <button
          v-if="localQ.length > 0"
          type="button"
          class="clear"
          aria-label="Clear search"
          @click="clearSearch"
        >×</button>
      </div>

      <div class="types">
        <button
          v-for="t in TYPE_ORDER"
          :key="t"
          type="button"
          class="chip"
          :class="{ active: props.types.includes(t) }"
          :data-type="t"
          :style="props.types.includes(t)
            ? { color: ISSUE_TYPE_META[t].fg, background: ISSUE_TYPE_META[t].bg, borderColor: ISSUE_TYPE_META[t].border }
            : undefined"
          @click="emit('toggle-type', t)"
        >{{ ISSUE_TYPE_META[t].label }}</button>
      </div>

      <button
        type="button"
        class="blocked-pill"
        :class="{ active: props.blockedOnly }"
        @click="emit('update:blockedOnly', !props.blockedOnly)"
      >⛔ Blocked only</button>

      <label class="closed">
        <input
          type="checkbox"
          :checked="props.showClosed"
          @change="emit('update:showClosed', ($event.target as HTMLInputElement).checked)"
        />
        Show closed
      </label>

      <label class="closed" data-test="show-epic-children">
        <input
          type="checkbox"
          :checked="props.showEpicChildren"
          @change="emit('update:showEpicChildren', ($event.target as HTMLInputElement).checked)"
        />
        Show children
      </label>

      <button
        type="button"
        class="chat-btn"
        @click="emit('open-board-chat')"
      >💬 Chat with danxbot</button>

      <span class="count">{{ props.visibleCount }} of {{ props.totalCount }}</span>
    </div>

    <div v-if="props.scopedEpicId" class="scope" data-test="scope-row">
      <span class="scope-label">Scoped to epic</span>
      <span class="scope-id">{{ props.scopedEpicId }}</span>
      <span
        class="scope-title"
        :class="{ unknown: !props.scopedEpicTitle }"
      >{{ props.scopedEpicTitle ?? "<not in current view>" }}</span>
      <div class="mode-group" role="group" aria-label="Scope mode">
        <button
          v-for="m in SCOPE_MODES"
          :key="m.id"
          type="button"
          class="mode-seg"
          :class="{ active: props.scopeMode === m.id }"
          @click="emit('update:scopeMode', m.id)"
        >{{ m.label }}</button>
      </div>
      <button
        type="button"
        class="clear-scope"
        aria-label="Clear scoped epic"
        @click="emit('clear-scope')"
      >Clear ×</button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgb(15 23 42 / 0.5);
  border: 1px solid #1e293b;
  margin-bottom: 16px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background: rgb(15 23 42 / 0.4);
  border: 1px solid transparent;
  flex: 1 1 220px;
  min-width: 180px;
  max-width: 360px;
  transition: all 150ms;
}
.search.active {
  background: rgb(30 41 59 / 0.8);
  border-color: #334155;
}
.search .glyph {
  font-size: 11px;
  color: #475569;
}
.search input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  color: #e2e8f0;
  font-size: 12px;
  font-family: inherit;
}
.search .clear {
  background: none;
  border: 0;
  color: #64748b;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
}
.types {
  display: flex;
  gap: 4px;
}
.chip {
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  background: rgb(30 41 59 / 0.5);
  border: 1px solid #334155;
  cursor: pointer;
  font-family: inherit;
  text-transform: capitalize;
  letter-spacing: 0.02em;
}
.blocked-pill {
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  background: rgb(30 41 59 / 0.5);
  border: 1px solid #334155;
  cursor: pointer;
  font-family: inherit;
}
.blocked-pill.active {
  color: #fca5a5;
  background: rgb(239 68 68 / 0.15);
  border-color: rgb(239 68 68 / 0.35);
}
.closed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
}
.closed input {
  accent-color: #6366f1;
  cursor: pointer;
}
.chat-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  background: rgb(99 102 241 / 0.15);
  color: #c7d2fe;
  border: 1px solid rgb(99 102 241 / 0.3);
  cursor: pointer;
  font-family: inherit;
}
.count {
  font-size: 11px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.scope {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgb(99 102 241 / 0.1);
  border: 1px solid rgb(99 102 241 / 0.3);
}
.scope-label {
  font-size: 11px;
  font-weight: 600;
  color: #a5b4fc;
}
.scope-id {
  font-size: 11px;
  font-weight: 600;
  color: #c7d2fe;
  font-variant-numeric: tabular-nums;
}
.scope-title {
  flex: 1 1 160px;
  font-size: 12px;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.scope-title.unknown {
  color: #94a3b8;
  font-style: italic;
}
.mode-group {
  display: inline-flex;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgb(99 102 241 / 0.3);
}
.mode-seg {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
}
.mode-seg.active {
  background: rgb(99 102 241 / 0.25);
  color: #c7d2fe;
}
.clear-scope {
  margin-left: auto;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #94a3b8;
  background: transparent;
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}
.clear-scope:hover {
  color: #e2e8f0;
  border-color: #475569;
}
</style>
