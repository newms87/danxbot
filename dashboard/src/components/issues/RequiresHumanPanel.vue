<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Issue, IssueDetail, RequiresHuman } from "../../types";
import { patchIssue } from "../../api";
import { relativeTime } from "../../utils/relativeTime";

// Phase 8 of DX-231 — orthogonal `requires_human` field surfaced as a
// pinned drawer panel. Two states:
//   A) `requires_human != null` — reason + numbered steps + Mark Resolved
//      + Edit buttons.
//   B) `requires_human == null`  — compact "Flag for human" affordance
//      that opens the same modal as Edit, pre-filled empty.
// Both states share one editor modal. Mounted ONCE in IssueDetailView
// above the tabs so the panel is always at a consistent y-offset and
// `DrawerHeader`'s banner can scroll the user to it via #anchor.

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  patched: [issue: Issue];
}>();

const reqHuman = computed<RequiresHuman | null>(
  () => props.issue.requires_human,
);

const isSet = computed(() => reqHuman.value !== null);

const setByLabel = computed(() => {
  const r = reqHuman.value;
  if (!r) return "";
  // Tolerate legacy / imported YAML missing set_by — show "unknown"
  // rather than crashing the panel.
  const by =
    r.set_by === "agent" || r.set_by === "human" ? r.set_by : "unknown";
  if (!r.set_at) return `Set by ${by}`;
  const ms = Date.parse(r.set_at);
  if (Number.isNaN(ms)) return `Set by ${by}`;
  return `Set by ${by} ${relativeTime(ms)}`;
});

// ── Modal state ─────────────────────────────────────────────────────
const modalOpen = ref(false);
const modalReason = ref("");
const modalSteps = ref<string[]>([]);
const modalError = ref<string | null>(null);
const modalSaving = ref(false);

// Inline "did you complete every step?" confirm before clearing the
// field. Kept as a tri-state — closed (idle), open (asking the operator
// to confirm), busy (PATCH in flight).
const confirmResolve = ref<"closed" | "open" | "busy">("closed");
const resolveError = ref<string | null>(null);

function openEditModal(): void {
  modalError.value = null;
  if (reqHuman.value) {
    modalReason.value = reqHuman.value.reason;
    modalSteps.value = [...reqHuman.value.steps];
  } else {
    modalReason.value = "";
    modalSteps.value = [""];
  }
  modalOpen.value = true;
}

function closeModal(): void {
  modalOpen.value = false;
  modalError.value = null;
}

function addStep(): void {
  modalSteps.value = [...modalSteps.value, ""];
}

function removeStep(index: number): void {
  modalSteps.value = modalSteps.value.filter((_, i) => i !== index);
}

function moveStep(index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (target < 0 || target >= modalSteps.value.length) return;
  const next = [...modalSteps.value];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  modalSteps.value = next;
}

function updateStep(index: number, value: string): void {
  const next = [...modalSteps.value];
  next[index] = value;
  modalSteps.value = next;
}

async function saveModal(): Promise<void> {
  const reason = modalReason.value.trim();
  if (reason.length === 0) {
    modalError.value = "Reason is required";
    return;
  }
  // Drop empty trailing rows the operator left blank; preserve interior
  // blanks (they may be intentional placeholders the operator will
  // fill on a later edit).
  const steps = modalSteps.value
    .map((s) => s.trim())
    .filter((s, i, arr) => i < arr.length - 1 || s.length > 0);
  modalSaving.value = true;
  modalError.value = null;
  try {
    // Server stamps `set_by: "human"` + `set_at: now` — the wire shape
    // is `RequiresHumanPatchInput` (reason + steps only). The slim
    // type makes the contract explicit in the SPA, no placeholders.
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      requires_human: { reason, steps },
    });
    emit("patched", updated);
    modalOpen.value = false;
  } catch (err) {
    modalError.value = (err as Error).message;
  } finally {
    modalSaving.value = false;
  }
}

async function confirmAndClear(): Promise<void> {
  confirmResolve.value = "busy";
  resolveError.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      requires_human: null,
    });
    emit("patched", updated);
    confirmResolve.value = "closed";
  } catch (err) {
    resolveError.value = (err as Error).message;
    confirmResolve.value = "open";
  }
}

// Reset inline confirm state when the panel switches to a different
// card. Otherwise a stale "Did you complete every step?" prompt could
// follow the operator into a card where it makes no sense.
watch(
  () => props.issue.id,
  () => {
    confirmResolve.value = "closed";
    resolveError.value = null;
    if (modalOpen.value) closeModal();
  },
);

// Focus the reason textarea on modal open so the operator can start
// typing immediately. nextTick + watch lets the v-if mount the field
// before we look for it.
const reasonField = ref<HTMLTextAreaElement | null>(null);
watch(modalOpen, async (open) => {
  if (open) {
    await nextTick();
    reasonField.value?.focus();
  }
});
</script>

<template>
  <section
    id="requires-human-panel"
    class="rh-panel"
    :class="{ set: isSet, flag: !isSet }"
    data-test="requires-human-panel"
  >
    <template v-if="isSet && reqHuman">
      <header class="rh-header">
        <span class="rh-glyph" aria-hidden="true">👤</span>
        <span class="rh-title">Requires Human</span>
        <span class="rh-set-by" data-test="rh-set-by">{{ setByLabel }}</span>
      </header>
      <p class="rh-reason" data-test="rh-reason">{{ reqHuman.reason }}</p>
      <ol
        v-if="reqHuman.steps.length > 0"
        class="rh-steps"
        data-test="rh-steps"
      >
        <li
          v-for="(step, i) in reqHuman.steps"
          :key="i"
          class="rh-step"
        >{{ step }}</li>
      </ol>
      <p
        v-else
        class="rh-empty-steps"
        data-test="rh-empty-steps"
      >(no steps provided)</p>
      <div v-if="confirmResolve === 'closed'" class="rh-actions">
        <button
          type="button"
          class="rh-btn rh-btn-primary"
          data-test="rh-mark-resolved"
          @click="confirmResolve = 'open'"
        >Mark Resolved</button>
        <button
          type="button"
          class="rh-btn rh-btn-secondary"
          data-test="rh-edit"
          @click="openEditModal"
        >Edit</button>
      </div>
      <div
        v-else
        class="rh-confirm"
        data-test="rh-confirm"
      >
        <span class="rh-confirm-prompt">Did you complete every step?</span>
        <button
          type="button"
          class="rh-btn rh-btn-primary"
          :disabled="confirmResolve === 'busy'"
          data-test="rh-confirm-yes"
          @click="confirmAndClear"
        >{{ confirmResolve === 'busy' ? 'Clearing…' : 'Yes, clear' }}</button>
        <button
          type="button"
          class="rh-btn rh-btn-secondary"
          :disabled="confirmResolve === 'busy'"
          data-test="rh-confirm-cancel"
          @click="confirmResolve = 'closed'"
        >Cancel</button>
        <span
          v-if="resolveError"
          class="rh-error"
          data-test="rh-resolve-error"
        >{{ resolveError }}</span>
      </div>
    </template>
    <template v-else>
      <button
        type="button"
        class="rh-flag"
        data-test="rh-flag"
        @click="openEditModal"
      >
        <span class="rh-glyph" aria-hidden="true">👤</span>
        Flag for human
      </button>
    </template>

    <div
      v-if="modalOpen"
      class="rh-modal-backdrop"
      data-test="rh-modal"
      @click.self="closeModal"
    >
      <div class="rh-modal">
        <header class="rh-modal-header">
          <span class="rh-glyph" aria-hidden="true">👤</span>
          <span class="rh-modal-title">
            {{ isSet ? "Edit requires-human record" : "Flag for human" }}
          </span>
          <button
            type="button"
            class="rh-modal-close"
            aria-label="Close"
            @click="closeModal"
          >×</button>
        </header>
        <label class="rh-field">
          <span class="rh-field-label">Reason</span>
          <textarea
            ref="reasonField"
            v-model="modalReason"
            class="rh-textarea"
            rows="3"
            placeholder="One sentence — what does the human need to do?"
            data-test="rh-modal-reason"
          />
        </label>
        <div class="rh-field">
          <span class="rh-field-label">Steps</span>
          <ol class="rh-modal-steps">
            <li
              v-for="(step, i) in modalSteps"
              :key="i"
              class="rh-modal-step"
              :data-test="`rh-modal-step-${i}`"
            >
              <input
                :value="step"
                class="rh-step-input"
                type="text"
                placeholder="Concrete action a non-engineer could execute"
                @input="updateStep(i, ($event.target as HTMLInputElement).value)"
              />
              <button
                type="button"
                class="rh-step-btn"
                aria-label="Move up"
                :disabled="i === 0"
                @click="moveStep(i, -1)"
              >↑</button>
              <button
                type="button"
                class="rh-step-btn"
                aria-label="Move down"
                :disabled="i === modalSteps.length - 1"
                @click="moveStep(i, 1)"
              >↓</button>
              <button
                type="button"
                class="rh-step-btn rh-step-btn-remove"
                aria-label="Remove step"
                @click="removeStep(i)"
              >×</button>
            </li>
          </ol>
          <button
            type="button"
            class="rh-add-step"
            data-test="rh-modal-add-step"
            @click="addStep"
          >+ Add step</button>
        </div>
        <p
          v-if="modalError"
          class="rh-error"
          data-test="rh-modal-error"
        >{{ modalError }}</p>
        <footer class="rh-modal-footer">
          <button
            type="button"
            class="rh-btn rh-btn-secondary"
            :disabled="modalSaving"
            data-test="rh-modal-cancel"
            @click="closeModal"
          >Cancel</button>
          <button
            type="button"
            class="rh-btn rh-btn-primary"
            :disabled="modalSaving"
            data-test="rh-modal-save"
            @click="saveModal"
          >{{ modalSaving ? "Saving…" : "Save" }}</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rh-panel {
  padding: 12px 20px;
  border-bottom: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rh-panel.set {
  background: rgb(249 115 22 / 0.08);
  border-left: 3px solid #f97316;
}
.rh-panel.flag {
  padding: 8px 20px;
}
.rh-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rh-glyph {
  font-size: 14px;
}
.rh-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #fdba74;
}
.rh-set-by {
  margin-left: auto;
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}
.rh-reason {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #f1f5f9;
}
.rh-steps {
  margin: 0;
  padding-left: 24px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rh-step {
  font-size: 13px;
  color: #e2e8f0;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.rh-empty-steps {
  margin: 0;
  font-size: 12px;
  color: #64748b;
  font-style: italic;
}
.rh-actions,
.rh-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rh-confirm-prompt {
  font-size: 12px;
  color: #fde68a;
}
.rh-btn {
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid transparent;
}
.rh-btn:disabled {
  cursor: wait;
  opacity: 0.7;
}
.rh-btn-primary {
  background: #f97316;
  color: #0b1220;
  border-color: #f97316;
}
.rh-btn-primary:hover:not(:disabled) {
  background: #fb923c;
}
.rh-btn-secondary {
  background: rgb(30 41 59 / 0.6);
  color: #cbd5e1;
  border-color: #334155;
}
.rh-btn-secondary:hover:not(:disabled) {
  background: rgb(51 65 85 / 0.8);
}
.rh-flag {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #fdba74;
  background: rgb(249 115 22 / 0.06);
  border: 1px dashed rgb(249 115 22 / 0.4);
  cursor: pointer;
  font-family: inherit;
}
.rh-flag:hover {
  background: rgb(249 115 22 / 0.12);
}
.rh-error {
  font-size: 11px;
  color: #fca5a5;
}

.rh-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.rh-modal {
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 16px 20px;
  width: min(560px, 90vw);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rh-modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rh-modal-title {
  font-size: 14px;
  font-weight: 600;
  color: #f1f5f9;
}
.rh-modal-close {
  margin-left: auto;
  background: none;
  border: 0;
  color: #94a3b8;
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  font-family: inherit;
}
.rh-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rh-field-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}
.rh-textarea {
  background: #0b1220;
  border: 1px solid #334155;
  border-radius: 4px;
  color: #e2e8f0;
  font-family: inherit;
  font-size: 13px;
  padding: 6px 8px;
  resize: vertical;
  min-height: 64px;
}
.rh-modal-steps {
  margin: 0;
  padding-left: 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rh-modal-step {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rh-step-input {
  flex: 1;
  background: #0b1220;
  border: 1px solid #334155;
  border-radius: 4px;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 4px 6px;
}
.rh-step-btn {
  background: rgb(30 41 59 / 0.6);
  border: 1px solid #334155;
  border-radius: 3px;
  color: #94a3b8;
  cursor: pointer;
  font-size: 11px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
}
.rh-step-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rh-step-btn-remove {
  color: #f87171;
}
.rh-add-step {
  align-self: flex-start;
  background: none;
  border: 1px dashed #475569;
  border-radius: 4px;
  color: #94a3b8;
  cursor: pointer;
  font-size: 11px;
  padding: 4px 10px;
  font-family: inherit;
  margin-top: 4px;
}
.rh-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid #1e293b;
  padding-top: 12px;
}
</style>
