<script setup lang="ts">
/**
 * 2-line drawer / dialog header.
 *
 * Line 1 (meta row) — left: [priority menu][id][parent link][type menu]
 *   [list menu]; right: [age badge][requires-human icon btn]
 *   [mark-blocked btn][copy btn][delete btn][close btn].
 *
 * Line 2 — inline editable title via `DanxEditableDiv`.
 *
 * Dispatch-state surfaces (blocked / waiting_on / conflict_on) live
 * EXCLUSIVELY in the `DispatchGatesSection` rendered below this header by
 * IssueDetailView — they are intentionally absent here. The requires-human
 * icon button in the meta row is a quick-edit affordance; the full
 * banner + clear/edit flow lives in the gates section.
 */
import { computed, ref, watch } from "vue";
import {
  DanxButton,
  DanxEditableDiv,
  DanxTooltip,
  closeIcon,
} from "@thehammer/danx-ui";
import userIcon from "danx-icon/src/fontawesome/regular/user.svg?raw";
import lockIcon from "danx-icon/src/fontawesome/solid/lock.svg?raw";
import type { Issue, IssueDetail, IssueListItem } from "../../types";
import { patchIssue } from "../../api";
import { ISSUE_TYPE_META, typeToId } from "./issuePalette";
import IssueAgeBadge from "../IssueAgeBadge.vue";
import IssueCopyButton from "./IssueCopyButton.vue";
import IssueDeleteButton from "./IssueDeleteButton.vue";
import IssueListMenu from "./IssueListMenu.vue";
import IssuePriorityMenu from "./IssuePriorityMenu.vue";
import IssueTypeMenu from "./IssueTypeMenu.vue";
import BlockedReasonDialog from "./BlockedReasonDialog.vue";

const props = withDefaults(
  defineProps<{
    issue: IssueDetail;
    repo: string;
    allIssues?: IssueListItem[];
    showClose?: boolean;
  }>(),
  { showClose: true, allIssues: () => [] },
);

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
  "open-agent": [];
  /** Operator clicked the flag-human icon — IssueDetailView opens the editor. */
  "open-rh-editor": [];
  "update:issue": [issue: Issue];
}>();

const parentMeta = computed(() => {
  if (!props.issue.parent_id) return null;
  const parent = props.allIssues.find((i) => i.id === props.issue.parent_id);
  if (!parent) return null;
  return ISSUE_TYPE_META[typeToId(parent.type)];
});

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

// ── DX-659 / Phase 3 — Mark-Blocked affordance ─────────────────────────
const blockedDialogOpen = ref(false);
const blockedDialogBusy = ref(false);
const blockedDialogError = ref<string | null>(null);

function openBlockedDialog(): void {
  blockedDialogError.value = null;
  blockedDialogOpen.value = true;
}

async function submitBlockedReason(reason: string): Promise<void> {
  blockedDialogBusy.value = true;
  blockedDialogError.value = null;
  try {
    // Server's `applyIssuePatch` stamps `at: <now ISO>`; client sends `{reason}` only.
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      blocked: { reason },
    });
    emit("update:issue", updated);
    blockedDialogOpen.value = false;
  } catch (err) {
    blockedDialogError.value = err instanceof Error ? err.message : String(err);
  } finally {
    blockedDialogBusy.value = false;
  }
}

// Epic-with-children: status is parent-derived. Show inert pill +
// tooltip explaining why; priority + type stay editable.
const statusInert = computed(
  () => props.issue.type === "Epic" && props.issue.children.length > 0,
);

watch(
  () => props.issue.id,
  () => {
    titleSaving.value = false;
    titleError.value = null;
    blockedDialogOpen.value = false;
    blockedDialogBusy.value = false;
    blockedDialogError.value = null;
  },
);

const rhTooltip = computed(() =>
  props.issue.requires_human
    ? "Requires-human flag is set — click to edit"
    : "Flag for human action",
);
const rhVariant = computed(() =>
  props.issue.requires_human ? "warning" : "muted",
);

function onChildUpdate(updated: Issue): void {
  emit("update:issue", updated);
}
</script>

<template>
  <div class="header" data-test="drawer-header">
    <!-- Line 1: meta row ──────────────────────────────────────────── -->
    <div class="meta-row">
      <IssuePriorityMenu
        :repo="repo"
        :issue-id="issue.id"
        :priority="issue.priority"
        @update:issue="onChildUpdate"
      />

      <span class="id" data-test="drawer-id">{{ issue.id }}</span>

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

      <IssueTypeMenu
        :repo="repo"
        :issue-id="issue.id"
        :type="issue.type"
        @update:issue="onChildUpdate"
      />

      <!-- List (DX-586) — inert pill for epic-with-children. -->
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
      <IssueListMenu
        v-else
        :repo="repo"
        :issue-id="issue.id"
        :current-list-name="issue.list_name"
        :status-fallback="issue.status"
        @update:issue="onChildUpdate"
      />

      <span class="spacer" />

      <IssueAgeBadge
        class="age-badge"
        :updated-at="issue.updated_at"
        :created-at="issue.created_at"
      />

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

      <DanxButton
        v-if="!issue.blocked"
        variant=""
        size="sm"
        :icon="lockIcon"
        class="meta-btn blocked-btn"
        tooltip="Mark blocked (capture a reason; status derives via the gate)"
        aria-label="Mark blocked"
        data-test="drawer-mark-blocked"
        @click="openBlockedDialog"
      />

      <IssueCopyButton :repo="repo" :issue-id="issue.id" />

      <IssueDeleteButton
        :repo="repo"
        :issue-id="issue.id"
        :child-count="issue.children.length"
        @deleted="emit('close')"
      />

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

    <BlockedReasonDialog
      v-model="blockedDialogOpen"
      :issue-id="issue.id"
      dest-list-name="Blocked"
      :busy="blockedDialogBusy"
      :error="blockedDialogError"
      @submit="submitBlockedReason"
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
</style>
