<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Issue, IssueDetail } from "../../types";
import { getIssueSubtree, patchIssue } from "../../api";
import TypeBadge from "./TypeBadge.vue";
import AgentBadge from "../AgentBadge.vue";
import IssueAgeBadge from "../IssueAgeBadge.vue";

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

// Closing the drawer or jumping to another issue must exit edit mode so
// the next card opens in the read state.
watch(
  () => props.issue.id,
  () => {
    editing.value = false;
    saving.value = false;
    errorMsg.value = null;
  },
);

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

watch(
  () => props.issue.id,
  () => {
    clearCopyResetTimer();
    copyState.value = "idle";
    copyMessage.value = null;
  },
);

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
      <span class="status-pill">{{ issue.status }}</span>
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
