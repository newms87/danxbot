<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DanxButton, DanxPopover } from "@thehammer/danx-ui";
import type { Issue, IssueType } from "../../types";
import { ISSUE_TYPES } from "../../types";
import { patchIssue } from "../../api";
import { ISSUE_TYPE_META, typeToId } from "./issuePalette";

const props = defineProps<{
  repo: string;
  issueId: string;
  type: IssueType;
}>();

const emit = defineEmits<{
  "update:issue": [issue: Issue];
}>();

const menuOpen = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.issueId,
  () => {
    menuOpen.value = false;
    saving.value = false;
    error.value = null;
  },
);

const currentMeta = computed(() => ISSUE_TYPE_META[typeToId(props.type)]);

async function select(t: IssueType): Promise<void> {
  if (saving.value) return;
  if (t === props.type) {
    menuOpen.value = false;
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issueId, {
      type: t,
    });
    emit("update:issue", updated);
    menuOpen.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <DanxPopover v-model="menuOpen" trigger="click" placement="bottom">
    <template #trigger>
      <DanxButton
        variant=""
        size="sm"
        class="meta-btn type-btn"
        :disabled="saving"
        :tooltip="`Type: ${currentMeta.label} — click to change`"
        :aria-label="`Type: ${currentMeta.label} — click to change`"
        data-test="drawer-type-pill"
        :style="{ color: currentMeta.fg, background: currentMeta.bg, borderColor: currentMeta.border }"
      >{{ currentMeta.label }}</DanxButton>
    </template>
    <div class="menu" data-test="drawer-type-menu">
      <button
        v-for="t in ISSUE_TYPES"
        :key="t"
        type="button"
        class="menu-item"
        :class="{ active: t === type }"
        :disabled="saving"
        :data-test="`drawer-type-option-${t.toLowerCase()}`"
        @click="select(t)"
      >
        <span
          class="type-swatch"
          :style="{ background: ISSUE_TYPE_META[typeToId(t)].bg, borderColor: ISSUE_TYPE_META[typeToId(t)].border }"
        />
        <span class="menu-label" :style="{ color: ISSUE_TYPE_META[typeToId(t)].fg }">{{ t }}</span>
      </button>
      <div class="menu-hint">
        Epic flip stops dispatch; non-Epic resumes it.
      </div>
      <div v-if="error" class="menu-error" data-test="drawer-type-error">{{ error }}</div>
    </div>
  </DanxPopover>
</template>

<style scoped>
.meta-btn:deep(button),
.meta-btn :deep(button) {
  background: transparent;
  border: 1px solid transparent;
  color: #cbd5e1;
}
.meta-btn:hover:deep(button),
.meta-btn:hover :deep(button) {
  background: rgb(51 65 85 / 0.5);
  border-color: rgb(99 102 241 / 0.3);
  color: #f1f5f9;
}
.type-btn :deep(button) {
  font-weight: 600;
}
.menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  min-width: 160px;
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.4);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: #cbd5e1;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.menu-item:hover:not(:disabled) {
  background: rgb(99 102 241 / 0.18);
  border-color: rgb(99 102 241 / 0.35);
  color: #f1f5f9;
}
.menu-item:disabled {
  opacity: 0.55;
  cursor: progress;
}
.menu-item.active {
  background: rgb(99 102 241 / 0.12);
  color: #a5b4fc;
}
.menu-label {
  flex: 1;
  text-align: left;
}
.type-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid;
  flex-shrink: 0;
}
.menu-hint {
  margin-top: 4px;
  padding: 4px 8px;
  font-size: 10px;
  color: #64748b;
  font-style: italic;
  border-top: 1px solid #1e293b;
}
.menu-error {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.12);
  border: 1px solid rgb(239 68 68 / 0.3);
}
</style>
