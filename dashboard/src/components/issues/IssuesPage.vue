<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { useIssues } from "../../composables/useIssues";
import { isInScope, useIssueFilters } from "../../composables/useIssueFilters";
import { nextPosition } from "../../composables/cardPosition";
import { DanxDialog, DanxSplitPanel } from "@thehammer/danx-ui";
import FilterToolbar from "./FilterToolbar.vue";
import IssueBoard from "./IssueBoard.vue";
import IssueDetailView from "./IssueDetailView.vue";
import BoardChatOverlay from "../chat/BoardChatOverlay.vue";
import { typeToId } from "./issuePalette";
import type { Issue, IssueDetail, IssueListItem, IssueStatus } from "../../types";

const selectedRepo = defineModel<string>("selectedRepo", { required: true });

const emit = defineEmits<{
  select: [issue: IssueListItem];
  /**
   * Fired when the user clicks the agent badge in the drawer header.
   * App.vue handles by switching `activeTab` to `agents` (the
   * AgentsPage already scopes to `selectedRepo`, so the agent's roster
   * card is in view).
   */
  "open-agent": [];
}>();

const {
  issues,
  loading,
  error,
  refresh,
  fetchDetail,
  moveIssueStatus,
  moveIssuePosition,
  applyIssueUpdate,
} = useIssues(toRef(selectedRepo));

function onUpdateIssue(updated: Issue): void {
  // Update the board projection + invalidate the detail cache.
  applyIssueUpdate(updated);
  // Reflect the change immediately in the drawer's current detail view
  // by merging the new Issue fields onto the IssueDetail (detail-only
  // fields — created_at, raw_yaml — stay; the 30s poll refreshes them).
  if (selectedDetail.value && selectedDetail.value.id === updated.id) {
    selectedDetail.value = {
      ...selectedDetail.value,
      ...updated,
      updated_at: Date.now(),
    };
  }
}

function onMove(issue: IssueListItem, toStatus: IssueStatus): void {
  // useIssues handles the optimistic mutation + revert + populates the
  // `error` ref that drives the global banner. Swallow the rejection so
  // an unhandled-promise warning does not leak — the banner is the
  // operator-facing surface.
  void moveIssueStatus(issue.id, toStatus).catch(() => {});
}

function onReorder(
  issue: IssueListItem,
  before: IssueListItem | null,
  after: IssueListItem | null,
): void {
  // Compute the fractional-indexing midpoint from the neighbors'
  // current positions (null neighbor → ±1 from the single neighbor).
  // The backend's `position` ASC sort tier ranks the new value into
  // the dropped slot; the SPA does NOT locally re-sort.
  const position = nextPosition(before?.position ?? null, after?.position ?? null);
  void moveIssuePosition(issue.id, position).catch(() => {});
}

const {
  q,
  types,
  blockedOnly,
  showClosed,
  scopedEpicId,
  scopeMode,
  showEpicChildren,
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
const epicIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  for (const i of issues.value) if (i.type === "Epic") out.add(i.id);
  return out;
});

const filteredIssues = computed<IssueListItem[]>(() => {
  const needle = q.value.trim().toLowerCase();
  const epics = epicIds.value;
  return issues.value.filter((i) => {
    if (!showClosed.value && i.status === "Cancelled") return false;
    if (types.value.length > 0 && !types.value.includes(typeToId(i.type))) {
      return false;
    }
    if (blockedOnly.value && !(i.status === "Blocked" || i.waiting_on)) return false;
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
    // Hide every epic-child from the board by default. Drawer's
    // Children tab is the canonical surface; the toolbar toggle (saved
    // in localStorage) re-exposes them globally.
    if (
      !showEpicChildren.value &&
      i.parent_id !== null &&
      epics.has(i.parent_id)
    ) return false;
    return true;
  });
});

const selectedIssueId = ref<string | null>(null);
const selectedDetail = ref<IssueDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const boardChatOpen = ref(false);

type CardPresentation = "drawer" | "dialog";

function readPresentation(): CardPresentation {
  try {
    const v = window.localStorage.getItem("issues.cardPresentation");
    if (v === "dialog") return "dialog";
  } catch {
    /* localStorage disabled */
  }
  return "drawer";
}

const cardPresentation = ref<CardPresentation>(readPresentation());

watch(cardPresentation, (v) => {
  try {
    window.localStorage.setItem("issues.cardPresentation", v);
  } catch {
    /* localStorage disabled */
  }
});

const splitPanels = [
  { id: "board", label: "Board", defaultWidth: 60 },
  { id: "drawer", label: "Drawer", defaultWidth: 40 },
];

const activeSplitPanels = computed<string[]>(() =>
  selectedIssueId.value ? ["board", "drawer"] : ["board"],
);

function onSplitPanelsUpdate(value: string[]): void {
  // Closing the drawer panel via the SplitPanel's own toggle UI is
  // equivalent to closing the issue detail.
  if (selectedIssueId.value && !value.includes("drawer")) closeDrawer();
}

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
  // Issue ids are scoped per-repo (<PREFIX>-N collides across repos), so any
  // chip in this drawer references a card in `selectedRepo` by data-model
  // invariant. If a future global-id model lands, branch here to switch
  // `selectedRepo` before opening.
  void openDrawer(id);
}

function onParentClick(parentId: string): void {
  scopedEpicId.value = parentId;
}

// DX-239 — `RequiresHumanPanel`'s PATCH returns the post-patch Issue.
// Merge it into the open detail so the panel + indicators reflect the
// new state immediately, without waiting for the chokidar mirror
// debounce (~5s) and a separate re-fetch. The watcher's SSE event will
// re-affirm later; the local merge is the optimistic path.
function onIssuePatched(updated: import("../../types").Issue): void {
  const current = selectedDetail.value;
  if (!current || current.id !== updated.id) return;
  selectedDetail.value = { ...current, ...updated };
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
        :show-epic-children="showEpicChildren"
        :card-presentation="cardPresentation"
        @update:q="q = $event"
        @toggle-type="toggleType"
        @update:blocked-only="blockedOnly = $event"
        @update:show-closed="showClosed = $event"
        @update:scope-mode="scopeMode = $event"
        @update:show-epic-children="showEpicChildren = $event"
        @update:card-presentation="cardPresentation = $event"
        @clear-scope="scopedEpicId = null"
        @open-board-chat="boardChatOpen = true"
      />
      <div v-if="loading && issues.length === 0" class="placeholder">Loading issues…</div>
      <div v-else-if="issues.length === 0" class="placeholder">No issues yet</div>
      <DanxSplitPanel
        v-else-if="cardPresentation === 'drawer'"
        class="split-wrap"
        :panels="splitPanels"
        :model-value="activeSplitPanels"
        storage-key="issues.split"
        require-active
        @update:model-value="onSplitPanelsUpdate"
      >
        <template #board>
          <div class="board-wrap">
            <IssueBoard
              :issues="filteredIssues"
              :repo="selectedRepo"
              :show-closed="showClosed"
              :scoped-epic-id="scopedEpicId"
              :scope-mode="scopeMode"
              @select="onSelect"
              @parent-click="onParentClick"
              @move="onMove"
              @reorder="onReorder"
            />
          </div>
        </template>
        <template #drawer>
          <IssueDetailView
            v-if="selectedIssueId"
            :issue="selectedDetail"
            :loading="detailLoading"
            :all-issues="issues"
            :scoped-epic-id="scopedEpicId"
            :selected-repo="selectedRepo"
            @close="closeDrawer"
            @jump-issue="onJumpIssue"
            @toggle-scope="onToggleScope"
            @open-agent="emit('open-agent')"
            @issue-patched="onIssuePatched"
            @update:issue="onUpdateIssue"
          />
        </template>
      </DanxSplitPanel>
      <div v-else class="board-wrap">
        <IssueBoard
          :issues="filteredIssues"
          :repo="selectedRepo"
          :show-closed="showClosed"
          :scoped-epic-id="scopedEpicId"
          :scope-mode="scopeMode"
          @select="onSelect"
          @parent-click="onParentClick"
        />
      </div>
    </template>

    <DanxDialog
      v-if="cardPresentation === 'dialog' && selectedIssueId"
      :model-value="!!selectedIssueId"
      width="90vw"
      height="90vh"
      close-x
      @update:model-value="(v: boolean) => { if (!v) closeDrawer(); }"
      @close="closeDrawer"
    >
      <IssueDetailView
        :issue="selectedDetail"
        :loading="detailLoading"
        :all-issues="issues"
        :scoped-epic-id="scopedEpicId"
        :selected-repo="selectedRepo"
        :show-close-button="false"
        @close="closeDrawer"
        @jump-issue="onJumpIssue"
        @toggle-scope="onToggleScope"
        @open-agent="emit('open-agent')"
        @issue-patched="onIssuePatched"
        @update:issue="onUpdateIssue"
      />
    </DanxDialog>
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
  height: 100%;
}
.board-wrap > :deep(.board) {
  flex: 1 1 auto;
  min-height: 0;
}
.split-wrap {
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
