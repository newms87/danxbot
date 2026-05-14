<script lang="ts">
/**
 * Filter toggles for the per-card Chat tab (DX-352 Phase 4).
 *
 * Two binary toggles: hide `Bash` tool calls + hide assistant thinking
 * blocks. Default for both is `true` — the AC says the operator sees
 * "text + tool-use summaries, nothing else" on first open.
 *
 * Persistence: per-user `localStorage`. Toggle state restores across
 * tab opens, issue switches, and reloads. The key constants are
 * module-scope so the toggle handlers AND the `readInitialFilters`
 * helper share one definition — no chance of drift between writer
 * and reader.
 */
const HIDE_BASH_KEY = "issues.chatFilter.hideBash";
const HIDE_THINKING_KEY = "issues.chatFilter.hideThinking";

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) === true;
  } catch {
    return defaultValue;
  }
}

/**
 * Hydrate the initial filter state from `localStorage`. Defaults to
 * `true` for both toggles when no prior preference is stored.
 *
 * Exported so the host tab can seed the props on mount — this keeps
 * persistence symmetric (toggle handlers write; `readInitialFilters` reads).
 */
export function readInitialFilters(): {
  hideBash: boolean;
  hideThinking: boolean;
} {
  return {
    hideBash: readBool(HIDE_BASH_KEY, true),
    hideThinking: readBool(HIDE_THINKING_KEY, true),
  };
}
</script>

<script setup lang="ts">
const props = defineProps<{
  hideBash: boolean;
  hideThinking: boolean;
}>();

const emit = defineEmits<{
  "update:hideBash": [value: boolean];
  "update:hideThinking": [value: boolean];
}>();

function toggleBash(): void {
  const next = !props.hideBash;
  emit("update:hideBash", next);
  try {
    window.localStorage.setItem(HIDE_BASH_KEY, JSON.stringify(next));
  } catch {
    /* localStorage disabled */
  }
}

function toggleThinking(): void {
  const next = !props.hideThinking;
  emit("update:hideThinking", next);
  try {
    window.localStorage.setItem(HIDE_THINKING_KEY, JSON.stringify(next));
  } catch {
    /* localStorage disabled */
  }
}
</script>

<template>
  <div class="chat-filters" data-test="chat-filters">
    <span class="label">Hide</span>
    <button
      type="button"
      class="toggle"
      :class="{ active: hideBash }"
      :aria-pressed="hideBash"
      data-test="filter-bash"
      @click="toggleBash"
    >
      <span class="dot" />
      Bash
    </button>
    <button
      type="button"
      class="toggle"
      :class="{ active: hideThinking }"
      :aria-pressed="hideThinking"
      data-test="filter-thinking"
      @click="toggleThinking"
    >
      <span class="dot" />
      Thinking
    </button>
  </div>
</template>

<style scoped>
.chat-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid #1e293b;
  background: rgb(2 6 23 / 0.4);
  flex-shrink: 0;
  font-size: 11px;
}
.label {
  color: #64748b;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 500;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #334155;
  background: transparent;
  color: #94a3b8;
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}
.toggle:hover {
  background: rgb(15 23 42 / 0.6);
  color: #e2e8f0;
}
.toggle.active {
  background: rgb(99 102 241 / 0.15);
  border-color: #6366f1;
  color: #a5b4fc;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #475569;
}
.toggle.active .dot {
  background: #a5b4fc;
}
</style>
