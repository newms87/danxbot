<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DanxButton, DanxPopover } from "@thehammer/danx-ui";
import type { Issue } from "../../types";
import { patchIssue } from "../../api";
import PriorityIcon from "../PriorityIcon.vue";
import {
  priorityTier,
  PRIORITY_TIERS,
  type PriorityTier,
} from "../../lib/priorityTier";

const props = defineProps<{
  repo: string;
  issueId: string;
  priority: number;
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

const currentTier = computed(() => priorityTier(props.priority));
const currentTierMeta = computed<PriorityTier>(() => {
  const found = PRIORITY_TIERS.find((t) => t.key === currentTier.value);
  return found ?? PRIORITY_TIERS[2];
});

async function select(tier: PriorityTier): Promise<void> {
  if (saving.value) return;
  if (tier.key === currentTier.value) {
    menuOpen.value = false;
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issueId, {
      priority: tier.defaultValue,
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
        class="meta-btn priority-btn"
        :disabled="saving"
        :aria-label="`Priority: ${currentTierMeta.label} — click to change`"
        data-test="drawer-priority-pill"
      >
        <template #icon>
          <PriorityIcon :priority="priority" size="sm" />
        </template>
      </DanxButton>
    </template>
    <div class="menu" data-test="drawer-priority-menu">
      <button
        v-for="t in PRIORITY_TIERS"
        :key="t.key"
        type="button"
        class="menu-item priority-menu-item"
        :class="{ active: t.key === currentTier }"
        :disabled="saving"
        :data-test="`drawer-priority-option-${t.key}`"
        @click="select(t)"
      >
        <PriorityIcon :priority="t.defaultValue" size="sm" />
        <span class="menu-label">{{ t.label }}</span>
        <span class="menu-suffix">{{ t.defaultValue }}</span>
      </button>
      <div v-if="error" class="menu-error" data-test="drawer-priority-error">{{ error }}</div>
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
.priority-menu-item {
  justify-content: space-between;
}
.menu-label {
  flex: 1;
  text-align: left;
}
.menu-suffix {
  font-size: 10px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
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
