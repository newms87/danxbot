<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { useIssues } from "../../composables/useIssues";
import { useListColors } from "../../composables/useListColors";
import { isInScope, useIssueFilters } from "../../composables/useIssueFilters";
import { useCascadeMove } from "../../composables/useCascadeMove";
import { useIssueDrawer } from "../../composables/useIssueDrawer";
import { DanxDialog, DanxSplitPanel, DanxTooltip } from "@thehammer/danx-ui";
import CreateCardButton from "./CreateCardButton.vue";
import FilterToolbar from "./FilterToolbar.vue";
import IssueBoard from "./IssueBoard.vue";
import IssueDetailView from "./IssueDetailView.vue";
import PasteCardsDialog from "./PasteCardsDialog.vue";
import TriageButton from "./TriageButton.vue";
import BoardChatOverlay from "../chat/BoardChatOverlay.vue";
import EpicMoveCascadeDialog from "./EpicMoveCascadeDialog.vue";
import { typeToId } from "./issuePalette";
import { nextPriority } from "../../composables/cardPriority";
import type { IssueListItem } from "../../types";

const selectedRepo = defineModel<string>("selectedRepo", { required: true });

const emit = defineEmits<{
  select: [issue: IssueListItem];
  // App.vue handles by switching `activeTab` to `agents`.
  "open-agent": [];
}>();

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

// DX-523 — closed cards beyond the recent-50 cap are pull-on-demand;
// `showClosed` drives the `include_closed` query param rather than being
// a client-side filter that hides anything outside the recent slice.
const includeClosed = computed<"recent" | "all">(() =>
  showClosed.value ? "all" : "recent",
);

const {
  issues,
  loading,
  error,
  refresh,
  fetchDetail,
  moveIssueList,
  moveIssuePriority,
  applyIssueUpdate,
  cascadeIssueList,
} = useIssues(toRef(selectedRepo), includeClosed);

// DX-682 — `useListColors(repo)` is a refcounted shared per-repo registry,
// so a computed facade per current repo collapses the prior shallowRef
// swap dance; the registry handles cross-repo cache isolation.
const listsApi = computed(() => useListColors(selectedRepo.value));
onMounted(() => listsApi.value.init());
onBeforeUnmount(() => listsApi.value.destroy());
watch(listsApi, (next, prev) => {
  prev.destroy();
  next.init();
});

const boardLists = computed(() => listsApi.value.lists.value);

// DX-694 — drawer state + cascade-dialog state machines extracted.
const {
  selectedIssueId,
  selectedDetail,
  detailLoading,
  detailError,
  openDrawer,
  closeDrawer,
  mergeIssuePatch,
  mergeIssueUpdateAndInvalidate,
  readUrlIssue,
} = useIssueDrawer({ fetchDetail, applyIssueUpdate });

const {
  pendingMove,
  moveDialogBusy,
  moveDialogError,
  onMove,
  onCascadeConfirm,
  onCascadeCancel,
} = useCascadeMove({ issues, moveIssueList, cascadeIssueList });

// DX-629 — drag-reorder slot drop. Board emits the (before, after)
// neighbor pair; nextPriority computes a midpoint decimal.
function onReorder(
  issue: IssueListItem,
  before: IssueListItem | null,
  after: IssueListItem | null,
): void {
  const priority = nextPriority(before?.priority ?? null, after?.priority ?? null);
  void moveIssuePriority(issue.id, priority).catch(() => {});
}

const scopedEpicTitle = computed<string | null>(() => {
  if (!scopedEpicId.value) return null;
  return issues.value.find((i) => i.id === scopedEpicId.value)?.title ?? null;
});

const epicIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  for (const i of issues.value) if (i.type === "Epic") out.add(i.id);
  return out;
});

// Client-side filter pipeline over already-loaded `issues[]`.
// Show-closed off: drop Cancelled entirely; let Done flow through so
// IssueBoard's "Done (Recent)" column can pick the last-24h slice.
const filteredIssues = computed<IssueListItem[]>(() => {
  const needle = q.value.trim().toLowerCase();
  const epics = epicIds.value;
  return issues.value.filter((i) => {
    if (!showClosed.value && i.status === "Cancelled") return false;
    if (types.value.length > 0 && !types.value.includes(typeToId(i.type))) {
      return false;
    }
    if (blockedOnly.value && !(i.blocked !== null || (i.blocked_descendants?.length ?? 0) > 0 || i.waiting_on)) return false;
    if (needle) {
      const hay = `${i.id} ${i.title} ${i.description}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    // Filter mode drops out-of-scope; highlight mode dims via class.
    if (
      scopedEpicId.value &&
      scopeMode.value === "filter" &&
      !isInScope(i, scopedEpicId.value)
    ) return false;
    // Hide epic children by default; drawer's Children tab is canonical.
    if (
      !showEpicChildren.value &&
      i.parent_id !== null &&
      epics.has(i.parent_id)
    ) return false;
    return true;
  });
});

const boardChatOpen = ref(false);

type CardPresentation = "drawer" | "dialog";

function readPresentation(): CardPresentation {
  try {
    if (window.localStorage.getItem("issues.cardPresentation") === "dialog") return "dialog";
  } catch { /* localStorage disabled */ }
  return "drawer";
}

const cardPresentation = ref<CardPresentation>(readPresentation());

watch(cardPresentation, (v) => {
  try {
    window.localStorage.setItem("issues.cardPresentation", v);
  } catch { /* localStorage disabled */ }
});

const splitPanels = [
  { id: "board", label: "Board", defaultWidth: 60 },
  { id: "drawer", label: "Drawer", defaultWidth: 40 },
];

const activeSplitPanels = computed<string[]>(() =>
  selectedIssueId.value ? ["board", "drawer"] : ["board"],
);

function onSplitPanelsUpdate(value: string[]): void {
  if (selectedIssueId.value && !value.includes("drawer")) closeDrawer();
}

function onSelect(issue: IssueListItem): void {
  emit("select", issue);
  void openDrawer(issue.id);
}

// Issue ids are scoped per-repo, so any chip in this drawer references
// a card in `selectedRepo` by data-model invariant.
function onJumpIssue(id: string): void {
  void openDrawer(id);
}

const pasteDialogOpen = ref<boolean>(false);

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

watch(selectedRepo, () => {
  if (selectedIssueId.value) closeDrawer();
});
</script>

<template>
  <section class="issues-section">
    <div v-if="error" class="error-banner">
      {{ error }}
      <button type="button" class="retry" @click="refresh">retry</button>
    </div>

    <div v-if="!selectedRepo" class="placeholder">Select a repo to see issues</div>
    <template v-else>
      <div class="header-row">
        <TriageButton :repo="selectedRepo" />
        <DanxTooltip tooltip="Paste a Copy payload into this repo">
          <template #trigger>
            <button
              type="button"
              class="paste-btn"
              data-test="issues-paste-button"
              @click="pasteDialogOpen = true"
            >Paste cards…</button>
          </template>
        </DanxTooltip>
        <CreateCardButton
          :repo="selectedRepo"
          @created="(id: string) => openDrawer(id)"
        />
      </div>
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
              :lists="boardLists"
              :show-closed="showClosed"
              :scoped-epic-id="scopedEpicId"
              :scope-mode="scopeMode"
              @select="onSelect"
              @parent-click="(pid: string) => (scopedEpicId = pid)"
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
            @issue-patched="mergeIssuePatch"
            @update:issue="mergeIssueUpdateAndInvalidate"
          />
        </template>
      </DanxSplitPanel>
      <div v-else class="board-wrap">
        <IssueBoard
          :issues="filteredIssues"
          :repo="selectedRepo"
          :lists="boardLists"
          :show-closed="showClosed"
          :scoped-epic-id="scopedEpicId"
          :scope-mode="scopeMode"
          @select="onSelect"
          @parent-click="(pid: string) => (scopedEpicId = pid)"
          @move="onMove"
          @reorder="onReorder"
        />
      </div>
    </template>

    <EpicMoveCascadeDialog
      v-if="pendingMove?.kind === 'cascade'"
      :model-value="true"
      :parent="pendingMove.issue"
      :dest-list="pendingMove.destList"
      :descendants="pendingMove.descendants"
      :defaults="pendingMove.defaults"
      :all-lists="boardLists"
      :busy="moveDialogBusy"
      :error="moveDialogError"
      @confirm="onCascadeConfirm"
      @cancel="onCascadeCancel"
    />

    <!--
      Dialog-mode presentation. Identical bindings to the drawer-mode mount
      modulo `:show-close-button="false"` (DanxDialog owns its own close
      affordance via `close-x`). The two mounts sit in structurally
      different parents (DanxSplitPanel slot vs. DanxDialog default slot)
      so they cannot share a single render — the v-bind copy is the
      minimal divergence.
    -->
    <DanxDialog
      v-if="cardPresentation === 'dialog' && selectedIssueId"
      :model-value="!!selectedIssueId"
      width="90vw"
      height="90vh"
      close-x
      :close-button="false"
      :confirm-button="false"
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
        @issue-patched="mergeIssuePatch"
        @update:issue="mergeIssueUpdateAndInvalidate"
      />
    </DanxDialog>
    <BoardChatOverlay
      v-if="boardChatOpen"
      :repo="selectedRepo"
      @close="boardChatOpen = false"
    />
    <PasteCardsDialog
      v-if="selectedRepo"
      v-model="pasteDialogOpen"
      :repo="selectedRepo"
      @imported="(topId: string) => openDrawer(topId)"
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
.header-row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
}
.paste-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #cbd5e1;
  background: rgb(30 41 59 / 0.6);
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}
.paste-btn:hover {
  background: rgb(51 65 85 / 0.7);
  border-color: rgb(99 102 241 / 0.45);
  color: #e2e8f0;
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
