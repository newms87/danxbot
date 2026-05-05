<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { IssueDetail, IssueListItem } from "../../types";
import DrawerHeader from "./DrawerHeader.vue";
import OverviewTab from "./OverviewTab.vue";
import ACTab from "./ACTab.vue";
import CommentsTab from "./CommentsTab.vue";
import RetroTab from "./RetroTab.vue";
import RawTab from "./RawTab.vue";
import { acCounts } from "./acCounts";

type TabId = "overview" | "ac" | "comments" | "retro" | "raw";

const props = defineProps<{
  issue: IssueDetail | null;
  loading: boolean;
  allIssues: IssueListItem[];
  scopedEpicId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
  "toggle-scope": [];
}>();

const tab = ref<TabId>("overview");

const hasRetro = computed(() => {
  const r = props.issue?.retro;
  if (!r) return false;
  return (
    r.good.length > 0 ||
    r.bad.length > 0 ||
    r.action_item_ids.length > 0 ||
    r.commits.length > 0
  );
});

const ac = computed(() =>
  props.issue ? acCounts(props.issue.ac) : { done: 0, total: 0 },
);

const tabs = computed(() => [
  { id: "overview" as const, label: "Overview", disabled: false },
  {
    id: "ac" as const,
    label: "AC" + (ac.value.total > 0 ? ` · ${ac.value.done}/${ac.value.total}` : ""),
    disabled: ac.value.total === 0,
  },
  {
    id: "comments" as const,
    label:
      "Comments" +
      (props.issue && props.issue.comments.length > 0
        ? ` · ${props.issue.comments.length}`
        : ""),
    disabled: false,
  },
  { id: "retro" as const, label: "Retro", disabled: !hasRetro.value },
  { id: "raw" as const, label: "Raw YAML", disabled: false },
]);

watch(
  () => props.issue?.id,
  () => {
    tab.value = "overview";
  },
);

function selectTab(id: TabId, disabled: boolean): void {
  if (disabled) return;
  tab.value = id;
}
</script>

<template>
  <div class="scrim" @click="emit('close')" />
  <aside class="drawer" role="dialog" aria-modal="true">
    <template v-if="loading && !issue">
      <div class="loading">Loading…</div>
    </template>
    <template v-else-if="issue">
      <DrawerHeader
        :issue="issue"
        :scoped-epic-id="props.scopedEpicId"
        @close="emit('close')"
        @jump-issue="(id) => emit('jump-issue', id)"
        @toggle-scope="emit('toggle-scope')"
      />
      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          class="tab"
          :class="{ active: tab === t.id, disabled: t.disabled }"
          :disabled="t.disabled"
          @click="selectTab(t.id, t.disabled)"
        >{{ t.label }}</button>
      </div>
      <div class="body">
        <OverviewTab
          v-if="tab === 'overview'"
          :issue="issue"
          :all-issues="allIssues"
          @jump-issue="(id) => emit('jump-issue', id)"
        />
        <ACTab v-else-if="tab === 'ac'" :issue="issue" />
        <CommentsTab v-else-if="tab === 'comments'" :issue="issue" />
        <RetroTab v-else-if="tab === 'retro'" :issue="issue" />
        <RawTab v-else-if="tab === 'raw'" :issue="issue" />
      </div>
    </template>
  </aside>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgb(2 6 23 / 0.5);
  z-index: 40;
  animation: iss-fade 150ms ease-out;
}
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(560px, 100vw);
  background: #0b1220;
  border-left: 1px solid #1e293b;
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-shadow: -12px 0 32px rgb(0 0 0 / 0.4);
  animation: iss-slide 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.loading {
  padding: 40px;
  text-align: center;
  color: #64748b;
  font-size: 13px;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 0 20px;
  border-bottom: 1px solid #1e293b;
}
.tab {
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 500;
  background: none;
  border: 0;
  font-family: inherit;
  cursor: pointer;
  color: #94a3b8;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tab.active {
  color: #a5b4fc;
  border-bottom-color: #6366f1;
}
.tab.disabled {
  color: #475569;
  cursor: not-allowed;
  opacity: 0.5;
}
.body {
  flex: 1;
  overflow-y: auto;
}

@keyframes iss-slide {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
@keyframes iss-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
