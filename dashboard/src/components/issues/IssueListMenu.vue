<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DanxButton, DanxPopover } from "@thehammer/danx-ui";
import type { Issue, List, ListType } from "../../types";
import { LIST_TYPE_LADDER, LIST_TYPE_LABELS } from "../../types";
import { patchIssue } from "../../api";
import { useListColors } from "../../composables/useListColors";

const props = defineProps<{
  repo: string;
  issueId: string;
  currentListName: string | null;
  statusFallback: string;
}>();

const emit = defineEmits<{
  "update:issue": [issue: Issue];
}>();

const menuOpen = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const listsApi = useListColors(props.repo);
onMounted(() => listsApi.init());
onBeforeUnmount(() => listsApi.destroy());

watch(
  () => props.issueId,
  () => {
    menuOpen.value = false;
    saving.value = false;
    error.value = null;
  },
);

function ladderIdx(type: ListType): number {
  const idx = LIST_TYPE_LADDER.indexOf(type);
  return idx < 0 ? LIST_TYPE_LADDER.length : idx;
}

const sortedLists = computed<List[]>(() => {
  const all = [...listsApi.lists.value];
  all.sort((a, b) => {
    const la = ladderIdx(a.type);
    const lb = ladderIdx(b.type);
    if (la !== lb) return la - lb;
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
  return all;
});

const listsByType = computed<{ type: ListType; lists: List[] }[]>(() => {
  const groups = new Map<ListType, List[]>();
  for (const l of sortedLists.value) {
    let bucket = groups.get(l.type);
    if (!bucket) {
      bucket = [];
      groups.set(l.type, bucket);
    }
    bucket.push(l);
  }
  const out: { type: ListType; lists: List[] }[] = [];
  for (const t of LIST_TYPE_LADDER) {
    const bucket = groups.get(t);
    if (bucket && bucket.length > 0) out.push({ type: t, lists: bucket });
  }
  return out;
});

const currentListColor = computed<string | null>(() =>
  props.currentListName ? listsApi.colorFor(props.currentListName) : null,
);
function typeLabel(type: ListType): string {
  return LIST_TYPE_LABELS[type];
}

async function selectList(list: List): Promise<void> {
  if (saving.value) return;
  if (list.name === props.currentListName) {
    menuOpen.value = false;
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issueId, {
      list_name: list.name,
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
        class="meta-btn list-btn"
        :disabled="saving"
        :aria-label="`List: ${currentListName ?? statusFallback} — click to change`"
        data-test="drawer-list-pill"
        :style="currentListColor ? { color: currentListColor, borderColor: currentListColor } : undefined"
      >
        <span v-if="currentListColor" class="list-dot" :style="{ background: currentListColor }" />
        {{ currentListName ?? statusFallback }}
      </DanxButton>
    </template>
    <div class="menu" data-test="drawer-list-menu">
      <template v-for="group in listsByType" :key="group.type">
        <div class="menu-group-label">{{ typeLabel(group.type) }}</div>
        <button
          v-for="l in group.lists"
          :key="l.id"
          type="button"
          class="menu-item"
          :class="{ active: l.name === currentListName }"
          :disabled="saving"
          :data-test="`drawer-list-option-${l.id}`"
          @click="selectList(l)"
        >
          <span class="list-dot" :style="{ background: l.color }" />
          <span class="menu-label">{{ l.name }}</span>
        </button>
      </template>
      <div v-if="error" class="menu-error" data-test="drawer-list-error">{{ error }}</div>
    </div>
  </DanxPopover>
</template>

<style scoped>
.meta-btn {
  --dx-bg: transparent;
  --dx-bg-hover: rgb(51 65 85 / 0.5);
  --dx-border: transparent;
  --dx-border-hover: rgb(99 102 241 / 0.4);
}
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
.list-btn :deep(button) {
  font-weight: 600;
}
.list-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  margin-right: 4px;
  vertical-align: middle;
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
.menu-group-label {
  padding: 6px 10px 2px;
  font-size: 9px;
  font-weight: 700;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.menu-group-label:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid #1e293b;
  padding-top: 8px;
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
