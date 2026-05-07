<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { useIssues } from "../../composables/useIssues";
import { isInScope, useIssueFilters } from "../../composables/useIssueFilters";
import FilterToolbar from "./FilterToolbar.vue";
import IssueBoard from "./IssueBoard.vue";
import IssueDrawer from "./IssueDrawer.vue";
import BoardChatOverlay from "../chat/BoardChatOverlay.vue";
import { typeToId } from "./issuePalette";
import type { IssueDetail, IssueListItem } from "../../types";

const selectedRepo = defineModel<string>("selectedRepo", { required: true });

const emit = defineEmits<{
  select: [issue: IssueListItem];
}>();

const { issues, loading, error, refresh, fetchDetail } = useIssues(
  toRef(selectedRepo),
);

const {
  q,
  types,
  blockedOnly,
  showClosed,
  scopedEpicId,
  scopeMode,
  toggleType,
} = useIssueFilters(selectedRepo);

const scopedEpicTitle = computed<string | null>(() => {
  if (!scopedEpicId.value) return null;
  const hit = issues.value.find((i) => i.id === scopedEpicId.value);
  return hit?.title ?? null;
});

/**
 * Client-side filter pipeline. Runs over `issues[]` already loaded by
 * `useIssues`; no re-fetch on filter change. Order: show-closed visibility
 * gate -> type chips -> blocked-only -> case-insensitive search across
 * id + title + description.
 *
 * Show-closed off: drop Cancelled entirely; let Done flow through so
 * `IssueBoard`'s "Done (Recent)" column can pick the last-24h slice.
 */
const filteredIssues = computed<IssueListItem[]>(() => {
  const needle = q.value.trim().toLowerCase();
  return issues.value.filter((i) => {
    if (!showClosed.value && i.status === "Cancelled") return false;
    if (types.value.length > 0 && !types.value.includes(typeToId(i.type))) {
      return false;
    }
    if (blockedOnly.value && !i.blocked) return false;
    if (needle) {
      const hay = `${i.id} ${i.title} ${i.description}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    // Filter mode: drop out-of-scope cards. Highlight mode keeps every
    // card visible — `IssueBoard` dims the out-of-scope ones via class.
    if (
      scopedEpicId.value &&
      scopeMode.value === "filter" &&
      !isInScope(i, scopedEpicId.value)
    ) return false;
    return true;
  });
});

const selectedIssueId = ref<string | null>(null);
const selectedDetail = ref<IssueDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const boardChatOpen = ref(false);

function readUrlIssue(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("issue");
}

function writeUrlIssue(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set("issue", id);
  } else {
    url.searchParams.delete("issue");
  }
  window.history.replaceState({}, "", url.toString());
}

async function openDrawer(id: string): Promise<void> {
  selectedIssueId.value = id;
  writeUrlIssue(id);
  detailLoading.value = true;
  detailError.value = null;
  try {
    const detail = await fetchDetail(id);
    if (selectedIssueId.value !== id) return;
    selectedDetail.value = detail;
  } catch (err) {
    if (selectedIssueId.value !== id) return;
    detailError.value = err instanceof Error ? err.message : String(err);
    selectedDetail.value = null;
  } finally {
    if (selectedIssueId.value === id) detailLoading.value = false;
  }
}

function closeDrawer(): void {
  selectedIssueId.value = null;
  selectedDetail.value = null;
  detailError.value = null;
  writeUrlIssue(null);
}

function onSelect(issue: IssueListItem): void {
  emit("select", issue);
  void openDrawer(issue.id);
}

function onJumpIssue(id: string): void {
  // Issue ids are scoped per-repo (ISS-N collides across repos), so any
  // chip in this drawer references a card in `selectedRepo` by data-model
  // invariant. If a future global-id model lands, branch here to switch
  // `selectedRepo` before opening.
  void openDrawer(id);
}

function onParentClick(parentId: string): void {
  scopedEpicId.value = parentId;
}

function onToggleScope(): void {
  const detail = selectedDetail.value;
  if (!detail) return;
  const target = detail.type === "Epic" ? detail.id : detail.parent_id;
  if (!target) return;
  scopedEpicId.value = scopedEpicId.value === target ? null : target;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && selectedIssueId.value) closeDrawer();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  const initial = readUrlIssue();
  if (initial) void openDrawer(initial);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

watch(
  selectedRepo,
  () => {
    if (selectedIssueId.value) closeDrawer();
  },
);
</script>

<template>
  <section class="issues-section">
    <div v-if="error" class="error-banner">
      {{ error }}
      <button type="button" class="retry" @click="refresh">retry</button>
    </div>

    <div v-if="!selectedRepo" class="placeholder">Select a repo to see issues</div>
    <template v-else>
      <FilterToolbar
        :q="q"
        :types="types"
        :blocked-only="blockedOnly"
        :show-closed="showClosed"
        :visible-count="filteredIssues.length"
        :total-count="issues.length"
        :scoped-epic-id="scopedEpicId"
        :scoped-epic-title="scopedEpicTitle"
        :scope-mode="scopeMode"
        @update:q="q = $event"
        @toggle-type="toggleType"
        @update:blocked-only="blockedOnly = $event"
        @update:show-closed="showClosed = $event"
        @update:scope-mode="scopeMode = $event"
        @clear-scope="scopedEpicId = null"
        @open-board-chat="boardChatOpen = true"
      />
      <div v-if="loading && issues.length === 0" class="placeholder">Loading issues…</div>
      <div v-else-if="issues.length === 0" class="placeholder">No issues yet</div>
      <div v-else class="board-wrap">
        <IssueBoard
          :issues="filteredIssues"
          :show-closed="showClosed"
          :scoped-epic-id="scopedEpicId"
          :scope-mode="scopeMode"
          @select="onSelect"
          @parent-click="onParentClick"
        />
      </div>
    </template>

    <IssueDrawer
      v-if="selectedIssueId"
      :issue="selectedDetail"
      :loading="detailLoading"
      :all-issues="issues"
      :scoped-epic-id="scopedEpicId"
      :selected-repo="selectedRepo"
      @close="closeDrawer"
      @jump-issue="onJumpIssue"
      @toggle-scope="onToggleScope"
    />
    <BoardChatOverlay
      v-if="boardChatOpen"
      :repo="selectedRepo"
      @close="boardChatOpen = false"
    />
    <div v-if="detailError" class="error-banner detail-err">
      {{ detailError }}
    </div>
  </section>
</template>

<style scoped>
.issues-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.board-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.board-wrap > :deep(.board) {
  flex: 1 1 auto;
  min-height: 0;
}
.error-banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid rgb(239 68 68 / 0.4);
  background: rgb(239 68 68 / 0.1);
  color: #fca5a5;
  font-size: 12px;
}
.detail-err {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 60;
  max-width: 360px;
}
.retry {
  margin-left: 8px;
  text-decoration: underline;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}
.placeholder {
  padding: 40px 16px;
  text-align: center;
  font-size: 12px;
  color: #64748b;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
</style>
