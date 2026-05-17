<script setup lang="ts">
/**
 * 2-line drawer / dialog header.
 *
 * Line 1 (meta row) — left: [priority menu][id][parent link][type menu]
 *   [status menu]; right: [age badge][requires-human icon btn]
 *   [copy btn][delete btn][close btn].
 *
 * Line 2 — inline editable title via `DanxEditableDiv`.
 *
 * Dispatch-state surfaces (blocked / waiting_on / conflict_on) live
 * EXCLUSIVELY in the `DispatchGatesSection` rendered below this header by
 * IssueDetailView — they are intentionally absent here. The requires-human
 * icon button in the meta row is a quick-edit affordance; the full
 * banner + clear/edit flow lives in the gates section.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DanxButton,
  DanxDialog,
  DanxEditableDiv,
  DanxPopover,
  DanxTooltip,
  closeIcon,
  copyIcon,
  trashIcon,
} from "@thehammer/danx-ui";
import userIcon from "danx-icon/src/fontawesome/regular/user.svg?raw";
import type {
  Issue,
  IssueDetail,
  IssueListItem,
  IssueType,
  List,
  ListType,
} from "../../types";
import { ISSUE_TYPES, LIST_TYPE_LADDER, LIST_TYPE_LABELS } from "../../types";
import { deleteIssue, getIssueSubtree, patchIssue } from "../../api";
import { ISSUE_TYPE_META, typeToId } from "./issuePalette";
import { useListColors } from "../../composables/useListColors";
import IssueAgeBadge from "../IssueAgeBadge.vue";
import PriorityIcon from "../PriorityIcon.vue";
import BlockedReasonDialog from "./BlockedReasonDialog.vue";
import UnblockConfirmDialog from "./UnblockConfirmDialog.vue";
import {
  priorityTier,
  PRIORITY_TIERS,
  type PriorityTier,
} from "../../lib/priorityTier";

const props = withDefaults(
  defineProps<{
    issue: IssueDetail;
    repo: string;
    allIssues?: IssueListItem[];
    showClose?: boolean;
  }>(),
  { showClose: true, allIssues: () => [] },
);

const parentMeta = computed(() => {
  if (!props.issue.parent_id) return null;
  const parent = props.allIssues.find((i) => i.id === props.issue.parent_id);
  if (!parent) return null;
  return ISSUE_TYPE_META[typeToId(parent.type)];
});

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
  "open-agent": [];
  /** Operator clicked the flag-human icon — IssueDetailView opens the editor. */
  "open-rh-editor": [];
  "update:issue": [issue: Issue];
}>();

// ── title editor ───────────────────────────────────────────────────────
const titleSaving = ref(false);
const titleError = ref<string | null>(null);

async function onTitleCommit(next: string): Promise<void> {
  const trimmed = next.trim();
  if (trimmed.length === 0) {
    titleError.value = "Title cannot be empty";
    return;
  }
  if (trimmed === props.issue.title) {
    titleError.value = null;
    return;
  }
  titleSaving.value = true;
  titleError.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      title: trimmed,
    });
    emit("update:issue", updated);
  } catch (err) {
    titleError.value = err instanceof Error ? err.message : String(err);
  } finally {
    titleSaving.value = false;
  }
}

// ── copy + delete ──────────────────────────────────────────────────────
const copyState = ref<"idle" | "copying" | "copied" | "error">("idle");
const copyMessage = ref<string | null>(null);
let copyResetTimer: number | null = null;

function clearCopyResetTimer(): void {
  if (copyResetTimer !== null) {
    window.clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
}

onBeforeUnmount(clearCopyResetTimer);

async function onCopy(): Promise<void> {
  if (copyState.value === "copying") return;
  clearCopyResetTimer();
  copyState.value = "copying";
  copyMessage.value = null;
  try {
    const payload = await getIssueSubtree(props.repo, props.issue.id);
    const text = JSON.stringify(payload);
    if (!navigator.clipboard?.writeText) {
      throw new Error(
        "Clipboard API not available — open the dashboard over HTTPS or localhost",
      );
    }
    await navigator.clipboard.writeText(text);
    const n = payload.issues.length;
    copyState.value = "copied";
    copyMessage.value = `Copied ${n} ${n === 1 ? "card" : "cards"}`;
  } catch (err) {
    copyState.value = "error";
    copyMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    copyResetTimer = window.setTimeout(() => {
      copyState.value = "idle";
      copyMessage.value = null;
      copyResetTimer = null;
    }, 2500);
  }
}

const copyTooltip = computed(
  () => copyMessage.value ?? "Copy this card and all descendants to clipboard",
);

const deleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);
const hasChildren = computed(() => props.issue.children.length > 0);
const deleteBodyText = computed(() => {
  if (hasChildren.value) {
    const n = props.issue.children.length;
    return `Move ${props.issue.id} and its ${n} ${n === 1 ? "child" : "descendants"} (recursive) to /tmp/danxbot/${props.repo}/issues/. The YAML survives on disk until the OS clears /tmp — no in-dashboard undo.`;
  }
  return `Move ${props.issue.id} to /tmp/danxbot/${props.repo}/issues/. The YAML survives on disk until the OS clears /tmp — no in-dashboard undo.`;
});

function openDelete(): void {
  deleteError.value = null;
  deleteOpen.value = true;
}

function closeDelete(): void {
  if (deleteBusy.value) return;
  deleteOpen.value = false;
  deleteError.value = null;
}

async function confirmDelete(): Promise<void> {
  if (deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = null;
  try {
    await deleteIssue(props.repo, props.issue.id);
    deleteOpen.value = false;
    emit("close");
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    deleteBusy.value = false;
  }
}

// ── list / priority / type menus ───────────────────────────────────────
// DX-586 — status menu retired in favor of a List dropdown driven by
// `lists.yaml`. The dropdown groups list options by `ListType` (ladder
// order: archived → review → ready → blocked → in_progress →
// completed → cancelled). Selecting a list PATCHes `list_name`; the
// server applies the ladder semantics + auto-stamps timestamps/dispatch.
// INTO-blocked and OUT-of-blocked moves route through the dedicated
// dialogs (BlockedReasonDialog + UnblockConfirmDialog) so the reason
// field gets captured / cleared explicitly.
const listMenuOpen = ref(false);
const priorityMenuOpen = ref(false);
const typeMenuOpen = ref(false);
const listSaving = ref(false);
const prioritySaving = ref(false);
const typeSaving = ref(false);
const listError = ref<string | null>(null);
const priorityError = ref<string | null>(null);
const typeError = ref<string | null>(null);

// Per-drawer useListColors instance for the dropdown's option list.
// init/destroy on mount / unmount; the SSE feed re-renders the menu
// transparently when the operator updates lists.yaml from the
// Settings page.
const listsApi = useListColors(props.repo);
onMounted(() => listsApi.init());
onBeforeUnmount(() => listsApi.destroy());

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
  // Re-emit in ladder order.
  const out: { type: ListType; lists: List[] }[] = [];
  for (const t of LIST_TYPE_LADDER) {
    const bucket = groups.get(t);
    if (bucket && bucket.length > 0) out.push({ type: t, lists: bucket });
  }
  return out;
});

const currentListName = computed<string | null>(() => props.issue.list_name);
const currentListColor = computed<string | null>(() =>
  currentListName.value ? listsApi.colorFor(currentListName.value) : null,
);
function typeLabel(type: ListType): string {
  return LIST_TYPE_LABELS[type];
}

// INTO-blocked / OUT-of-blocked dialog state. Same shape as
// IssuesPage's board flow — the drawer is just a second entry point.
const pendingDialog = ref<
  | { kind: "into-blocked"; destList: List }
  | { kind: "out-of-blocked"; destList: List }
  | null
>(null);
const dialogBusy = ref(false);
const dialogError = ref<string | null>(null);

// Epic-with-children: status is parent-derived. Show inert pill +
// tooltip explaining why; priority + type stay editable (knob is
// meaningful on epics; type-flip is the operator's call).
const statusInert = computed(
  () => props.issue.type === "Epic" && props.issue.children.length > 0,
);
const currentPriorityTier = computed(() => priorityTier(props.issue.priority));
const currentPriorityTierMeta = computed<PriorityTier>(() => {
  const found = PRIORITY_TIERS.find((t) => t.key === currentPriorityTier.value);
  return found ?? PRIORITY_TIERS[2];
});
const currentTypeMeta = computed(() => ISSUE_TYPE_META[typeToId(props.issue.type)]);

watch(
  () => props.issue.id,
  () => {
    clearCopyResetTimer();
    copyState.value = "idle";
    copyMessage.value = null;
    listMenuOpen.value = false;
    priorityMenuOpen.value = false;
    typeMenuOpen.value = false;
    listSaving.value = false;
    prioritySaving.value = false;
    typeSaving.value = false;
    listError.value = null;
    priorityError.value = null;
    typeError.value = null;
    titleSaving.value = false;
    titleError.value = null;
    pendingDialog.value = null;
    dialogBusy.value = false;
    dialogError.value = null;
  },
);

async function patchListNameDirect(
  list: List,
  blockedPatch: { reason: string } | null | undefined,
): Promise<void> {
  listSaving.value = true;
  listError.value = null;
  try {
    const patch: { list_name: string; blocked?: { reason: string } | null } = {
      list_name: list.name,
    };
    if (blockedPatch !== undefined) patch.blocked = blockedPatch;
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, patch);
    emit("update:issue", updated);
  } finally {
    listSaving.value = false;
  }
}

async function selectList(list: List): Promise<void> {
  if (listSaving.value) return;
  if (list.name === currentListName.value) {
    listMenuOpen.value = false;
    return;
  }
  // Route INTO-blocked / OUT-of-blocked through dialogs; everything
  // else is a direct PATCH.
  if (list.type === "blocked") {
    listMenuOpen.value = false;
    dialogError.value = null;
    pendingDialog.value = { kind: "into-blocked", destList: list };
    return;
  }
  if (props.issue.blocked !== null) {
    listMenuOpen.value = false;
    dialogError.value = null;
    pendingDialog.value = { kind: "out-of-blocked", destList: list };
    return;
  }
  try {
    await patchListNameDirect(list, undefined);
    listMenuOpen.value = false;
  } catch (err) {
    listError.value = err instanceof Error ? err.message : String(err);
  }
}

async function onBlockedDialogSubmit(reason: string): Promise<void> {
  const p = pendingDialog.value;
  if (!p || p.kind !== "into-blocked") return;
  dialogBusy.value = true;
  dialogError.value = null;
  try {
    await patchListNameDirect(p.destList, { reason });
    pendingDialog.value = null;
  } catch (err) {
    dialogError.value = err instanceof Error ? err.message : String(err);
  } finally {
    dialogBusy.value = false;
  }
}

async function onUnblockDialogConfirm(): Promise<void> {
  const p = pendingDialog.value;
  if (!p || p.kind !== "out-of-blocked") return;
  dialogBusy.value = true;
  dialogError.value = null;
  try {
    await patchListNameDirect(p.destList, null);
    pendingDialog.value = null;
  } catch (err) {
    dialogError.value = err instanceof Error ? err.message : String(err);
  } finally {
    dialogBusy.value = false;
  }
}

function onDialogCancel(): void {
  pendingDialog.value = null;
  dialogBusy.value = false;
  dialogError.value = null;
}

async function selectPriority(tier: PriorityTier): Promise<void> {
  if (prioritySaving.value) return;
  if (tier.key === currentPriorityTier.value) {
    priorityMenuOpen.value = false;
    return;
  }
  prioritySaving.value = true;
  priorityError.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      priority: tier.defaultValue,
    });
    emit("update:issue", updated);
    priorityMenuOpen.value = false;
  } catch (err) {
    priorityError.value = err instanceof Error ? err.message : String(err);
  } finally {
    prioritySaving.value = false;
  }
}

async function selectType(t: IssueType): Promise<void> {
  if (typeSaving.value) return;
  if (t === props.issue.type) {
    typeMenuOpen.value = false;
    return;
  }
  typeSaving.value = true;
  typeError.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      type: t,
    });
    emit("update:issue", updated);
    typeMenuOpen.value = false;
  } catch (err) {
    typeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    typeSaving.value = false;
  }
}

const rhTooltip = computed(() =>
  props.issue.requires_human
    ? "Requires-human flag is set — click to edit"
    : "Flag for human action",
);
const rhVariant = computed(() =>
  props.issue.requires_human ? "warning" : "muted",
);
</script>

<template>
  <div class="header" data-test="drawer-header">
    <!-- Line 1: meta row ──────────────────────────────────────────── -->
    <div class="meta-row">
      <!-- Priority -->
      <DanxPopover v-model="priorityMenuOpen" trigger="click" placement="bottom">
        <template #trigger>
          <DanxButton
            variant=""
            size="sm"
            class="meta-btn priority-btn"
            :disabled="prioritySaving"
            :aria-label="`Priority: ${currentPriorityTierMeta.label} — click to change`"
            data-test="drawer-priority-pill"
          >
            <template #icon>
              <PriorityIcon :priority="issue.priority" size="sm" />
            </template>
          </DanxButton>
        </template>
        <div class="menu" data-test="drawer-priority-menu">
          <button
            v-for="t in PRIORITY_TIERS"
            :key="t.key"
            type="button"
            class="menu-item priority-menu-item"
            :class="{ active: t.key === currentPriorityTier }"
            :disabled="prioritySaving"
            :data-test="`drawer-priority-option-${t.key}`"
            @click="selectPriority(t)"
          >
            <PriorityIcon :priority="t.defaultValue" size="sm" />
            <span class="menu-label">{{ t.label }}</span>
            <span class="menu-suffix">{{ t.defaultValue }}</span>
          </button>
          <div v-if="priorityError" class="menu-error" data-test="drawer-priority-error">{{ priorityError }}</div>
        </div>
      </DanxPopover>

      <!-- ID -->
      <span class="id" data-test="drawer-id">{{ issue.id }}</span>

      <!-- Parent link -->
      <DanxButton
        v-if="issue.parent_id"
        variant=""
        size="sm"
        class="meta-btn parent-btn"
        :tooltip="`Open parent ${issue.parent_id}`"
        :data-test="`drawer-parent-${issue.parent_id}`"
        :style="parentMeta ? { color: parentMeta.fg, background: parentMeta.bg, borderColor: parentMeta.border } : undefined"
        @click="emit('jump-issue', issue.parent_id!)"
      >↑ {{ issue.parent_id }}</DanxButton>

      <!-- Type -->
      <DanxPopover v-model="typeMenuOpen" trigger="click" placement="bottom">
        <template #trigger>
          <DanxButton
            variant=""
            size="sm"
            class="meta-btn type-btn"
            :disabled="typeSaving"
            :tooltip="`Type: ${currentTypeMeta.label} — click to change`"
            :aria-label="`Type: ${currentTypeMeta.label} — click to change`"
            data-test="drawer-type-pill"
            :style="{ color: currentTypeMeta.fg, background: currentTypeMeta.bg, borderColor: currentTypeMeta.border }"
          >{{ currentTypeMeta.label }}</DanxButton>
        </template>
        <div class="menu" data-test="drawer-type-menu">
          <button
            v-for="t in ISSUE_TYPES"
            :key="t"
            type="button"
            class="menu-item"
            :class="{ active: t === issue.type }"
            :disabled="typeSaving"
            :data-test="`drawer-type-option-${t.toLowerCase()}`"
            @click="selectType(t)"
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
          <div v-if="typeError" class="menu-error" data-test="drawer-type-error">{{ typeError }}</div>
        </div>
      </DanxPopover>

      <!-- List (DX-586) — replaces the legacy status menu. Inert pill
           for epic-with-children (status is parent-derived). -->
      <DanxTooltip
        v-if="statusInert"
        tooltip="Epic status is computed from phase statuses — edit a child phase to change this."
      >
        <template #trigger>
          <span
            class="status-pill status-pill-inert"
            data-test="drawer-status-pill-inert"
          >{{ issue.status }}</span>
        </template>
      </DanxTooltip>
      <DanxPopover v-else v-model="listMenuOpen" trigger="click" placement="bottom">
        <template #trigger>
          <DanxButton
            variant=""
            size="sm"
            class="meta-btn list-btn"
            :disabled="listSaving"
            :aria-label="`List: ${currentListName ?? issue.status} — click to change`"
            data-test="drawer-list-pill"
            :style="currentListColor ? { color: currentListColor, borderColor: currentListColor } : undefined"
          >
            <span v-if="currentListColor" class="list-dot" :style="{ background: currentListColor }" />
            {{ currentListName ?? issue.status }}
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
              :disabled="listSaving"
              :data-test="`drawer-list-option-${l.id}`"
              @click="selectList(l)"
            >
              <span class="list-dot" :style="{ background: l.color }" />
              <span class="menu-label">{{ l.name }}</span>
            </button>
          </template>
          <div v-if="listError" class="menu-error" data-test="drawer-list-error">{{ listError }}</div>
        </div>
      </DanxPopover>

      <span class="spacer" />

      <!-- Age -->
      <IssueAgeBadge
        class="age-badge"
        :updated-at="issue.updated_at"
        :created-at="issue.created_at"
      />

      <!-- Requires-human flag -->
      <DanxButton
        :variant="rhVariant"
        size="sm"
        :icon="userIcon"
        class="meta-btn rh-btn"
        :tooltip="rhTooltip"
        :aria-label="rhTooltip"
        data-test="drawer-rh-flag"
        @click="emit('open-rh-editor')"
      />

      <!-- Copy -->
      <DanxButton
        variant=""
        size="sm"
        :icon="copyIcon"
        class="meta-btn"
        :disabled="copyState === 'copying'"
        :loading="copyState === 'copying'"
        :tooltip="copyTooltip"
        :aria-label="copyTooltip"
        :data-test="copyState === 'copied' ? 'drawer-copy-success' : copyState === 'error' ? 'drawer-copy-error' : 'drawer-copy'"
        @click="onCopy"
      />

      <!-- Delete -->
      <DanxButton
        variant="danger"
        size="sm"
        :icon="trashIcon"
        class="meta-btn"
        tooltip="Delete this card (moves YAML to /tmp)"
        aria-label="Delete card"
        data-test="drawer-delete"
        @click="openDelete"
      />

      <!-- Close -->
      <DanxButton
        v-if="props.showClose"
        variant=""
        size="sm"
        :icon="closeIcon"
        class="meta-btn close-btn"
        tooltip="Close"
        aria-label="Close"
        data-test="drawer-close"
        @click="emit('close')"
      />
    </div>

    <!-- Line 2: title ─────────────────────────────────────────────── -->
    <div class="title-row">
      <DanxEditableDiv
        :model-value="issue.title"
        as="h2"
        mode="single"
        size="lg"
        :min-length="1"
        :saving="titleSaving"
        placeholder="(untitled)"
        data-test="drawer-title"
        @update:model-value="onTitleCommit"
      />
      <div v-if="titleError" class="title-error" data-test="drawer-title-error">{{ titleError }}</div>
    </div>

    <DanxDialog
      :model-value="deleteOpen"
      :title="`Delete ${issue.id}?`"
      :close-button="'Cancel'"
      :confirm-button="deleteBusy ? 'Deleting…' : 'Delete'"
      :is-saving="deleteBusy"
      :disabled="deleteBusy"
      variant="danger"
      persistent
      @close="closeDelete"
      @confirm="confirmDelete"
    >
      <div class="delete-dialog-body" data-test="drawer-delete-dialog-body">
        <p>{{ deleteBodyText }}</p>
        <p
          v-if="deleteError"
          class="delete-dialog-error"
          data-test="drawer-delete-error"
        >{{ deleteError }}</p>
      </div>
    </DanxDialog>

    <BlockedReasonDialog
      v-if="pendingDialog?.kind === 'into-blocked'"
      :model-value="true"
      :issue-id="issue.id"
      :dest-list-name="pendingDialog.destList.name"
      :busy="dialogBusy"
      :error="dialogError"
      @submit="onBlockedDialogSubmit"
      @cancel="onDialogCancel"
    />
    <UnblockConfirmDialog
      v-if="pendingDialog?.kind === 'out-of-blocked'"
      :model-value="true"
      :issue-id="issue.id"
      :dest-list-name="pendingDialog.destList.name"
      :current-reason="issue.blocked?.reason ?? null"
      :busy="dialogBusy"
      :error="dialogError"
      @confirm="onUnblockDialogConfirm"
      @cancel="onDialogCancel"
    />
  </div>
</template>

<style scoped>
.header {
  padding: 12px 16px 12px;
  border-bottom: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #0b1220;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  min-width: 0;
}
.spacer {
  flex: 1;
}
.id {
  font-size: 18px;
  font-weight: 700;
  color: #f1f5f9;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  padding: 0 6px;
}
.parent-btn :deep(button) {
  font-size: 11px;
  font-weight: 600;
}
.type-btn :deep(button) {
  font-weight: 600;
}
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
.status-pill {
  font-size: 11px;
  font-weight: 500;
  color: #cbd5e1;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(51 65 85 / 0.5);
}
.status-pill-inert {
  cursor: help;
}
.age-badge {
  margin-right: 4px;
}
.close-btn {
  margin-left: 2px;
}
.title-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.title-error {
  font-size: 11px;
  color: #fca5a5;
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
/* DX-586 — section labels inside the drawer's List dropdown, one per
   semantic ListType (Backlog / Review / Ready / etc.). Renders above
   the lists of that type — pure visual grouping, not interactive. */
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
.list-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  margin-right: 4px;
  vertical-align: middle;
}
.list-btn :deep(button) {
  font-weight: 600;
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
.delete-dialog-body {
  font-size: 14px;
  color: #cbd5e1;
  line-height: 1.5;
}
.delete-dialog-body p {
  margin: 0 0 10px 0;
}
.delete-dialog-body p:last-child {
  margin-bottom: 0;
}
.delete-dialog-error {
  color: #fca5a5;
  font-weight: 500;
}
</style>
