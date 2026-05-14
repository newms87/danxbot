<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { DanxPopover, DanxTooltip } from "@thehammer/danx-ui";
import type { Issue, IssueDetail, IssueStatus } from "../../types";
import { getIssueSubtree, patchIssue } from "../../api";
import TypeBadge from "./TypeBadge.vue";
import AgentBadge from "../AgentBadge.vue";
import IssueAgeBadge from "../IssueAgeBadge.vue";
import PriorityIcon from "../PriorityIcon.vue";
import {
  priorityTier,
  PRIORITY_TIERS,
  type PriorityTier,
} from "../../lib/priorityTier";

// Listed in the canonical lifecycle order — Review and Blocked are
// the two parking states, so a click-anywhere flow reads top-to-bottom
// without surprise. Mirrors `IssueStatus` enum so a new status value
// added to the backend lifecycle fails the type-check at this row
// (the enum is closed; adding a row to the menu requires bumping the
// list explicitly).
const ALL_STATUSES: readonly IssueStatus[] = [
  "Review",
  "ToDo",
  "In Progress",
  "Blocked",
  "Done",
  "Cancelled",
] as const;

const props = withDefaults(
  defineProps<{
    issue: IssueDetail;
    repo: string;
    scopedEpicId: string | null;
    showClose?: boolean;
  }>(),
  { showClose: true },
);

const emit = defineEmits<{
  close: [];
  "jump-issue": [id: string];
  "toggle-scope": [];
  "open-agent": [];
  "update:issue": [issue: Issue];
}>();

const scopeTarget = computed<string | null>(() => {
  if (props.issue.type === "Epic") return props.issue.id;
  return props.issue.parent_id ?? null;
});

const isScoped = computed(
  () => !!props.scopedEpicId && props.scopedEpicId === scopeTarget.value,
);

const blockedByCard = computed(
  () => !!props.issue.waiting_on && props.issue.waiting_on.by.length > 0,
);

// DX-239 — orange banner under the title when `requires_human != null`,
// click scrolls to the pinned `RequiresHumanPanel` mounted above the
// tabs in `IssueDetailView`. The anchor (`#requires-human-panel`) is
// owned by that panel; this banner is the cue + scroll trigger only.
const requiresHuman = computed(() => props.issue.requires_human);

// DX-267 — header rollup line on Epics. "<N> phase(s) need human
// action" surfaces beside the title when any of the epic's phase
// children is flagged. Reads the backend-computed
// `requires_human_child_count` so SSE `issue:updated` events that
// reproject the IssueDetail keep the count live without a SPA-side
// recompute. Hidden on non-Epic cards (per AC #3) and when count = 0.
const requiresHumanChildCount = computed(
  () => props.issue.requires_human_child_count,
);
const showRequiresHumanChildren = computed(
  () => props.issue.type === "Epic" && requiresHumanChildCount.value > 0,
);
const requiresHumanChildrenText = computed(() => {
  const n = requiresHumanChildCount.value;
  return `${n} ${n === 1 ? "phase needs" : "phases need"} human action`;
});

function scrollToPanel(): void {
  const el = document.getElementById("requires-human-panel");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

const editing = ref(false);
const draft = ref("");
const saving = ref(false);
const errorMsg = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

async function startEdit(): Promise<void> {
  if (editing.value) return;
  draft.value = props.issue.title;
  editing.value = true;
  errorMsg.value = null;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
}

async function commit(): Promise<void> {
  const trimmed = draft.value.trim();
  if (trimmed.length === 0) {
    errorMsg.value = "Title cannot be empty";
    return;
  }
  if (trimmed === props.issue.title) {
    editing.value = false;
    errorMsg.value = null;
    return;
  }
  saving.value = true;
  errorMsg.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
      title: trimmed,
    });
    emit("update:issue", updated);
    editing.value = false;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function cancel(): void {
  editing.value = false;
  errorMsg.value = null;
  draft.value = "";
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void commit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
}

function onTitleKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    void startEdit();
  }
}

// DX-519 — Copy button. Fetches the subtree (root + every descendant
// in `children[]` recursively), writes the resulting `IssueCopyPayload`
// JSON to the clipboard via `navigator.clipboard.writeText`, surfaces a
// transient inline status. The Paste affordance on the Issues page
// consumes the same JSON via `POST /api/issues/import`.
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

// DX-522 — inline status + priority editors. Both pills open a
// DanxPopover panel of choices; selecting an option fires patchIssue
// and emits update:issue so the parent reprojects without waiting
// for the SSE round-trip (SSE re-affirms on arrival; identical
// content keeps the update idempotent).
//
// Epic guard: when this card is an epic WITH phase children, the
// status pill renders inert (no menu, no popover) and a DanxTooltip
// surfaces why — operators trying to flip the epic status hit the
// tooltip before they hit a dead pill click. Epics with empty
// children stay editable as a recovery affordance for malformed
// cards. The priority pill remains editable on every card kind
// because the operator-tunable priority knob is meaningful on
// epics too.
const statusMenuOpen = ref(false);
const priorityMenuOpen = ref(false);
const statusSaving = ref(false);
const prioritySaving = ref(false);
const statusError = ref<string | null>(null);
const priorityError = ref<string | null>(null);

const statusInert = computed(
  () => props.issue.type === "Epic" && props.issue.children.length > 0,
);
const currentPriorityTier = computed(() => priorityTier(props.issue.priority));
// Safe lookup with a deterministic medium fallback. The lockstep guard
// in `priority-tier.ts` makes the missing-key case impossible in
// practice, but a typed find-or-fallback prevents a future drift from
// crashing the template with `undefined.label`.
const currentPriorityTierMeta = computed<PriorityTier>(() => {
  const found = PRIORITY_TIERS.find((t) => t.key === currentPriorityTier.value);
  return found ?? PRIORITY_TIERS[2];
});

// Single drawer-switch reset point — every "exit transient state on
// issue switch" concern lives in one watcher so a future feature
// addition only needs to touch one place. (Pre-DX-522 the title editor
// and the copy button each had their own watcher; consolidating them
// here closed a future-drift risk flagged by code-review.)
watch(
  () => props.issue.id,
  () => {
    // Title editor (DX-236)
    editing.value = false;
    saving.value = false;
    errorMsg.value = null;
    // Copy button (DX-519)
    clearCopyResetTimer();
    copyState.value = "idle";
    copyMessage.value = null;
    // Status + priority menus (DX-522)
    statusMenuOpen.value = false;
    priorityMenuOpen.value = false;
    statusSaving.value = false;
    prioritySaving.value = false;
    statusError.value = null;
    priorityError.value = null;
  },
);

async function selectStatus(s: IssueStatus): Promise<void> {
  if (statusSaving.value) return;
  // No-op when picking the value we already have — saves a PATCH
  // round-trip and keeps the tracker push log clean.
  if (s === props.issue.status) {
    statusMenuOpen.value = false;
    return;
  }
  statusSaving.value = true;
  statusError.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, { status: s });
    emit("update:issue", updated);
    statusMenuOpen.value = false;
  } catch (err) {
    statusError.value = err instanceof Error ? err.message : String(err);
  } finally {
    statusSaving.value = false;
  }
}

async function selectPriority(tier: PriorityTier): Promise<void> {
  if (prioritySaving.value) return;
  // Commit the tier midpoint via `defaultValue`. The numeric continuum
  // stays meaningful for sort tiebreaks within a tier, but the menu's
  // contract is "pick a tier, get the midpoint" — operators expect
  // their click to land at a stable, reproducible value.
  if (tier.key === currentPriorityTier.value) {
    priorityMenuOpen.value = false;
    return;
  }
  prioritySaving.value = true;
  priorityError.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
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
</script>

<template>
  <div class="header">
    <div class="meta-row">
      <span class="id">{{ issue.id }}</span>
      <TypeBadge :type="issue.type" />
      <!--
        DX-522 — status editor. Epic-with-children → inert pill +
        derivation tooltip; everything else → click-to-open menu.
      -->
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
      <DanxPopover
        v-else
        v-model="statusMenuOpen"
        trigger="click"
        placement="bottom"
      >
        <template #trigger>
          <button
            type="button"
            class="status-pill status-pill-clickable"
            :disabled="statusSaving"
            :aria-label="`Status: ${issue.status} — click to change`"
            data-test="drawer-status-pill"
          >{{ issue.status }}</button>
        </template>
        <!--
          Intentionally no `role="menu"` / `role="menuitem"` — the
          panel is a vertical list of native `<button>`s without
          arrow-key navigation. ARIA roles that advertise menu
          semantics would mislead screen readers; native button
          semantics (Tab to focus, Enter/Space to activate) are
          accurate for the actual interaction model.
        -->
        <div class="inline-menu" data-test="drawer-status-menu">
          <button
            v-for="s in ALL_STATUSES"
            :key="s"
            type="button"
            class="inline-menu-item"
            :class="{ active: s === issue.status }"
            :disabled="statusSaving"
            :data-test="`drawer-status-option-${s.toLowerCase().replace(/\s+/g, '-')}`"
            @click="selectStatus(s)"
          >{{ s }}</button>
          <div
            v-if="statusError"
            class="inline-menu-error"
            data-test="drawer-status-error"
          >{{ statusError }}</div>
        </div>
      </DanxPopover>
      <!--
        DX-522 — priority editor. Editable on every card kind, including
        epics, because the operator-tunable priority knob is meaningful
        on epics too. Pill body = icon + tier label; menu commits the
        tier midpoint (`defaultValue`) so a click lands at a stable
        reproducible value.
      -->
      <DanxPopover
        v-model="priorityMenuOpen"
        trigger="click"
        placement="bottom"
      >
        <template #trigger>
          <button
            type="button"
            class="priority-pill"
            :disabled="prioritySaving"
            :aria-label="`Priority: ${currentPriorityTierMeta.label} — click to change`"
            data-test="drawer-priority-pill"
          >
            <PriorityIcon :priority="issue.priority" size="sm" />
            <span class="priority-pill-label">{{ currentPriorityTierMeta.label }}</span>
          </button>
        </template>
        <!-- Same native-button rationale as the status panel above. -->
        <div class="inline-menu priority-menu" data-test="drawer-priority-menu">
          <button
            v-for="t in PRIORITY_TIERS"
            :key="t.key"
            type="button"
            class="inline-menu-item priority-menu-item"
            :class="{ active: t.key === currentPriorityTier }"
            :disabled="prioritySaving"
            :data-test="`drawer-priority-option-${t.key}`"
            @click="selectPriority(t)"
          >
            <PriorityIcon :priority="t.defaultValue" size="sm" />
            <span class="priority-menu-label">{{ t.label }}</span>
            <span class="priority-menu-default">{{ t.defaultValue }}</span>
          </button>
          <div
            v-if="priorityError"
            class="inline-menu-error"
            data-test="drawer-priority-error"
          >{{ priorityError }}</div>
        </div>
      </DanxPopover>
      <span
        v-if="issue.waiting_on"
        class="blocked-badge"
        :class="{ 'by-card': blockedByCard }"
      >{{ blockedByCard ? "⏸ Blocked by" : "⛔ Blocked" }}</span>
      <span class="age-slot">
        <IssueAgeBadge
          :updated-at="issue.updated_at"
          :created-at="issue.created_at"
        />
      </span>
      <button
        type="button"
        class="copy-btn"
        data-test="drawer-copy"
        :disabled="copyState === 'copying'"
        :title="copyMessage ?? 'Copy this card and all descendants to clipboard'"
        :aria-label="copyMessage ?? 'Copy this card and all descendants'"
        @click="onCopy"
      >
        <span v-if="copyState === 'copying'">…</span>
        <span v-else-if="copyState === 'copied'" data-test="drawer-copy-success">✓</span>
        <span v-else-if="copyState === 'error'" data-test="drawer-copy-error">!</span>
        <span v-else>⧉</span>
      </button>
      <button
        v-if="props.showClose"
        type="button"
        class="close"
        aria-label="Close"
        @click="emit('close')"
      >×</button>
    </div>
    <div
      v-if="copyMessage && copyState !== 'copying'"
      class="copy-toast"
      :class="{ 'copy-toast-error': copyState === 'error' }"
      data-test="drawer-copy-toast"
      role="status"
    >{{ copyMessage }}</div>
    <template v-if="editing">
      <input
        ref="inputEl"
        v-model="draft"
        type="text"
        class="title-input"
        :disabled="saving"
        data-test="drawer-title-input"
        aria-label="Edit title"
        @keydown="onKeydown"
      />
      <div v-if="errorMsg" class="title-error" data-test="drawer-title-error">{{ errorMsg }}</div>
    </template>
    <h2
      v-else
      class="title"
      role="button"
      tabindex="0"
      data-test="drawer-title"
      :title="`${issue.title} — click to edit`"
      @click="startEdit"
      @keydown="onTitleKeydown"
    >{{ issue.title }}</h2>
    <button
      v-if="requiresHuman"
      type="button"
      class="requires-human-banner"
      data-test="drawer-rh-banner"
      @click="scrollToPanel"
    >
      <span aria-hidden="true">👤</span>
      Requires human action — see panel below
    </button>
    <div
      v-if="showRequiresHumanChildren"
      class="requires-human-children-line"
      data-test="drawer-rh-children-line"
    >
      <span aria-hidden="true">👤</span>
      {{ requiresHumanChildrenText }}
    </div>
    <div v-if="issue.assigned_agent" class="agent-row">
      <button
        type="button"
        class="agent-link"
        :data-test="`drawer-agent-${issue.assigned_agent}`"
        @click="emit('open-agent')"
      >
        <AgentBadge
          :repo="props.repo"
          :agent-name="issue.assigned_agent"
          size="md"
        />
      </button>
    </div>
    <div
      v-if="issue.parent_id || (issue.children && issue.children.length > 0) || scopeTarget"
      class="rel-row"
    >
      <button
        v-if="issue.parent_id"
        type="button"
        class="parent-chip"
        @click="emit('jump-issue', issue.parent_id!)"
      >↑ Parent: {{ issue.parent_id }}</button>
      <span v-if="issue.children.length > 0" class="children-count">
        {{ issue.children.length }} children
      </span>
      <button
        v-if="scopeTarget"
        type="button"
        class="scope-toggle"
        :class="{ active: isScoped }"
        @click="emit('toggle-scope')"
      >{{ isScoped ? "✓ Scoped to epic" : "Scope board to epic" }}</button>
    </div>
  </div>
</template>

<style scoped>
.header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.id {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.status-pill {
  font-size: 11px;
  font-weight: 500;
  color: #cbd5e1;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(51 65 85 / 0.5);
  text-transform: capitalize;
}
.status-pill-clickable {
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
}
.status-pill-clickable:hover:not(:disabled) {
  background: rgb(51 65 85 / 0.8);
  border-color: rgb(99 102 241 / 0.4);
  color: #f1f5f9;
}
.status-pill-clickable:disabled {
  opacity: 0.6;
  cursor: progress;
}
.status-pill-inert {
  cursor: help;
}
.priority-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #cbd5e1;
  padding: 2px 8px 2px 6px;
  border-radius: 4px;
  background: rgb(51 65 85 / 0.5);
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
}
.priority-pill:hover:not(:disabled) {
  background: rgb(51 65 85 / 0.8);
  border-color: rgb(99 102 241 / 0.4);
  color: #f1f5f9;
}
.priority-pill:disabled {
  opacity: 0.6;
  cursor: progress;
}
.priority-pill-label {
  line-height: 1;
}
.inline-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  min-width: 140px;
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.4);
}
.inline-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
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
.inline-menu-item:hover:not(:disabled) {
  background: rgb(99 102 241 / 0.18);
  border-color: rgb(99 102 241 / 0.35);
  color: #f1f5f9;
}
.inline-menu-item:disabled {
  opacity: 0.55;
  cursor: progress;
}
.inline-menu-item.active {
  background: rgb(99 102 241 / 0.12);
  color: #a5b4fc;
}
.priority-menu-item {
  justify-content: space-between;
}
.priority-menu-label {
  flex: 1;
  text-align: left;
}
.priority-menu-default {
  font-size: 10px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.inline-menu-error {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.12);
  border: 1px solid rgb(239 68 68 / 0.3);
}
.blocked-badge {
  font-size: 11px;
  font-weight: 600;
  color: #fca5a5;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(239 68 68 / 0.15);
  border: 1px solid rgb(239 68 68 / 0.3);
}
.blocked-badge.by-card {
  color: #fcd34d;
  background: rgb(245 158 11 / 0.15);
  border-color: rgb(245 158 11 / 0.35);
}
.age-slot {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
}
.close {
  background: none;
  border: 0;
  color: #94a3b8;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
  font-family: inherit;
}
.copy-btn {
  background: none;
  border: 1px solid transparent;
  color: #94a3b8;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: inherit;
  min-width: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.copy-btn:hover:not(:disabled) {
  color: #cbd5e1;
  background: rgb(51 65 85 / 0.4);
  border-color: rgb(99 102 241 / 0.3);
}
.copy-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}
.copy-toast {
  font-size: 11px;
  font-weight: 500;
  color: #86efac;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgb(34 197 94 / 0.12);
  border: 1px solid rgb(34 197 94 / 0.3);
  align-self: flex-start;
}
.copy-toast.copy-toast-error {
  color: #fca5a5;
  background: rgb(239 68 68 / 0.12);
  border-color: rgb(239 68 68 / 0.35);
}
.title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #f1f5f9;
  line-height: 1.3;
  letter-spacing: -0.01em;
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 4px;
  margin: 0 -4px;
}
.title:hover {
  background: rgb(51 65 85 / 0.35);
}
.title:focus-visible {
  outline: 2px solid #6366f1;
  outline-offset: -2px;
}
.title-input {
  font-family: inherit;
  font-size: 18px;
  font-weight: 600;
  color: #f1f5f9;
  background: rgb(15 23 42 / 0.8);
  border: 1px solid #6366f1;
  border-radius: 4px;
  padding: 4px 6px;
  margin: 0 -4px;
  line-height: 1.3;
  letter-spacing: -0.01em;
  width: calc(100% + 8px);
}
.title-input:focus {
  outline: none;
}
.title-input:disabled {
  opacity: 0.6;
}
.title-error {
  font-size: 11px;
  color: #fca5a5;
  margin: 4px 0 -2px;
}
.agent-row {
  display: flex;
  align-items: center;
}
.agent-link {
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.agent-link:hover :deep(.agent-badge) {
  background: rgb(99 102 241 / 0.18);
  border-color: rgb(99 102 241 / 0.45);
}
.rel-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.parent-chip {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #a5b4fc;
  background: rgb(99 102 241 / 0.12);
  border: 1px solid rgb(99 102 241 / 0.3);
  cursor: pointer;
  font-family: inherit;
}
.children-count {
  font-size: 11px;
  color: #64748b;
}
.scope-toggle {
  margin-left: auto;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #94a3b8;
  background: rgb(30 41 59 / 0.5);
  border: 1px solid #334155;
  cursor: pointer;
  font-family: inherit;
}
.scope-toggle.active {
  color: #fcd34d;
  background: rgb(245 158 11 / 0.12);
  border-color: rgb(245 158 11 / 0.3);
}
.requires-human-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: #fdba74;
  background: rgb(249 115 22 / 0.12);
  border: 1px solid rgb(249 115 22 / 0.35);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.requires-human-banner:hover {
  background: rgb(249 115 22 / 0.2);
}
.requires-human-children-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: #fdba74;
  background: rgb(249 115 22 / 0.08);
  border: 1px solid rgb(249 115 22 / 0.25);
}
</style>
