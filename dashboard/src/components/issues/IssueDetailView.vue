<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { IssueDetail, IssueListItem } from "../../types";
import DrawerHeader from "./DrawerHeader.vue";
import OverviewTab from "./OverviewTab.vue";
import ACTab from "./ACTab.vue";
import ChildrenTab from "./ChildrenTab.vue";
import CommentsTab from "./CommentsTab.vue";
import RetroTab from "./RetroTab.vue";
import RawTab from "./RawTab.vue";
import HistoryTab from "./HistoryTab.vue";
import RequiresHumanPanel from "./RequiresHumanPanel.vue";
import AgentChat from "../chat/AgentChat.vue";
import type { Issue } from "../../types";
import { acCounts } from "./acCounts";

type TabId = "overview" | "ac" | "children" | "chat" | "comments" | "history" | "retro" | "raw";

const VALID_TABS: ReadonlyArray<TabId> = [
  "overview", "ac", "children", "chat", "comments", "history", "retro", "raw",
];

// Two persisted defaults: epic vs non-epic. Different card kinds have
// different "interesting" tabs (epic → Phases; bug/feature → AC).
function tabStorageKey(epic: boolean): string {
  return epic ? "issues.lastTab.epic" : "issues.lastTab.other";
}

function readTabPref(epic: boolean): TabId {
  try {
    const v = window.localStorage.getItem(tabStorageKey(epic));
    if (v && VALID_TABS.includes(v as TabId)) return v as TabId;
  } catch {
    /* localStorage disabled */
  }
  return "overview";
}

function writeTabPref(epic: boolean, value: TabId): void {
  try {
    window.localStorage.setItem(tabStorageKey(epic), value);
  } catch {
    /* localStorage disabled */
  }
}

const props = withDefaults(
  defineProps<{
    issue: IssueDetail | null;
    loading: boolean;
    allIssues: IssueListItem[];
    scopedEpicId: string | null;
    selectedRepo: string;
    showCloseButton?: boolean;
  }>(),
  { showCloseButton: true },
);

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
  "toggle-scope": [];
  "open-agent": [];
  "issue-patched": [issue: Issue];
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

const childCount = computed(() => props.issue?.children.length ?? 0);
const isEpic = computed(() => props.issue?.type === "Epic");
const childrenLabel = computed(() => {
  const base = isEpic.value ? "Phases" : "Children";
  return childCount.value > 0 ? `${base} · ${childCount.value}` : base;
});

const tabs = computed(() => {
  // Epics use children (phase cards) as their acceptance criteria —
  // AC tab is suppressed entirely so the operator never sees an empty
  // tab on an epic and the children panel remains the canonical
  // completion view.
  const out: { id: TabId; label: string; disabled: boolean }[] = [
    { id: "overview", label: "Overview", disabled: false },
  ];
  if (!isEpic.value) {
    out.push({
      id: "ac",
      label: "AC" + (ac.value.total > 0 ? ` · ${ac.value.done}/${ac.value.total}` : ""),
      disabled: ac.value.total === 0,
    });
  }
  out.push(
    { id: "children", label: childrenLabel.value, disabled: childCount.value === 0 },
    { id: "chat", label: "Chat", disabled: false },
    {
      id: "comments",
      label:
        "Comments" +
        (props.issue && props.issue.comments.length > 0
          ? ` · ${props.issue.comments.length}`
          : ""),
      disabled: false,
    },
    {
      id: "history",
      label: (() => {
        const n = props.issue?.history?.length ?? 0;
        return n > 0 ? `History · ${n}` : "History";
      })(),
      disabled: false,
    },
    { id: "retro", label: "Retro", disabled: !hasRetro.value },
    { id: "raw", label: "Raw YAML", disabled: false },
  );
  return out;
});

watch(
  () => props.issue?.id,
  () => {
    if (!props.issue) return;
    const epic = props.issue.type === "Epic";
    const saved = readTabPref(epic);
    const t = tabs.value.find((x) => x.id === saved);
    tab.value = t && !t.disabled ? saved : "overview";
  },
);

function selectTab(id: TabId, disabled: boolean): void {
  if (disabled) return;
  tab.value = id;
  if (props.issue) writeTabPref(props.issue.type === "Epic", id);
}
</script>

<template>
  <div class="issue-detail-view">
    <template v-if="loading && !issue">
      <div class="loading">Loading…</div>
    </template>
    <template v-else-if="issue">
      <DrawerHeader
        :issue="issue"
        :repo="props.selectedRepo"
        :scoped-epic-id="props.scopedEpicId"
        :show-close="showCloseButton"
        @close="emit('close')"
        @jump-issue="(id) => emit('jump-issue', id)"
        @toggle-scope="emit('toggle-scope')"
        @open-agent="emit('open-agent')"
      />
      <RequiresHumanPanel
        :issue="issue"
        :repo="props.selectedRepo"
        @patched="(updated) => emit('issue-patched', updated)"
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
      <div v-if="tab === 'chat'" class="chat-body">
        <AgentChat mode="issue" :issue="issue" :repo="props.selectedRepo" />
      </div>
      <div v-else class="body">
        <OverviewTab
          v-if="tab === 'overview'"
          :issue="issue"
          :all-issues="allIssues"
          @jump-issue="(id) => emit('jump-issue', id)"
        />
        <ACTab v-else-if="tab === 'ac'" :issue="issue" />
        <ChildrenTab
          v-else-if="tab === 'children'"
          :issue="issue"
          :all-issues="allIssues"
          :repo="props.selectedRepo"
          @jump-issue="(id) => emit('jump-issue', id)"
        />
        <CommentsTab v-else-if="tab === 'comments'" :issue="issue" />
        <HistoryTab v-else-if="tab === 'history'" :issue="issue" />
        <RetroTab v-else-if="tab === 'retro'" :issue="issue" />
        <RawTab v-else-if="tab === 'raw'" :issue="issue" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.issue-detail-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #0b1220;
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
  flex-shrink: 0;
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
  min-height: 0;
}
.chat-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
</style>
