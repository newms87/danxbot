<script setup lang="ts">
/**
 * Extracted modal editor for the `requires_human` field. Used by:
 *   - `DispatchGatesSection`'s requires_human banner (Edit button)
 *   - `DrawerHeader`'s flag icon button (when requires_human is null,
 *     opens a fresh "Flag for human" form)
 *
 * The component is controlled — the parent owns the open/close state.
 * Server stamps `set_by: "human"` + `set_at: now`; SPA ships only
 * `{reason, steps[]}`.
 */
import { nextTick, ref, watch } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";
import type { Issue, IssueDetail } from "../../types";
import { patchIssue } from "../../api";

const props = defineProps<{
  modelValue: boolean;
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  patched: [issue: Issue];
}>();

const reason = ref("");
const steps = ref<string[]>([""]);
const error = ref<string | null>(null);
const saving = ref(false);
const reasonField = ref<HTMLTextAreaElement | null>(null);

function seedFromIssue(): void {
  const rh = props.issue.requires_human;
  if (rh) {
    reason.value = rh.reason;
    steps.value = rh.steps.length > 0 ? [...rh.steps] : [""];
  } else {
    reason.value = "";
    steps.value = [""];
  }
  error.value = null;
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      seedFromIssue();
      await nextTick();
      reasonField.value?.focus();
    }
  },
);

function close(): void {
  if (saving.value) return;
  emit("update:modelValue", false);
}

function addStep(): void {
  steps.value = [...steps.value, ""];
}

function removeStep(i: number): void {
  steps.value = steps.value.filter((_, idx) => idx !== i);
}

function moveStep(i: number, delta: -1 | 1): void {
  const target = i + delta;
  if (target < 0 || target >= steps.value.length) return;
  const next = [...steps.value];
  const [item] = next.splice(i, 1);
  next.splice(target, 0, item);
  steps.value = next;
}

function updateStep(i: number, value: string): void {
  const next = [...steps.value];
  next[i] = value;
  steps.value = next;
}

async function save(): Promise<void> {
  const r = reason.value.trim();
  if (r.length === 0) {
    error.value = "Reason is required";
    return;
  }
  // Drop trailing empties only — interior blanks may be intentional
  // placeholders the operator will fill on a later edit.
  const cleaned = steps.value
    .map((s) => s.trim())
    .filter((s, i, arr) => i < arr.length - 1 || s.length > 0);
  saving.value = true;
  error.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      requires_human: { reason: r, steps: cleaned },
    });
    emit("patched", updated);
    emit("update:modelValue", false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <DanxDialog
    :model-value="modelValue"
    :title="issue.requires_human ? 'Edit requires-human record' : 'Flag for human'"
    :close-button="'Cancel'"
    :confirm-button="saving ? 'Saving…' : 'Save'"
    :is-saving="saving"
    :disabled="saving"
    persistent
    @close="close"
    @confirm="save"
  >
    <div class="rh-editor-body" data-test="rh-editor-body">
      <label class="rh-field">
        <span class="rh-field-label">Reason</span>
        <textarea
          ref="reasonField"
          v-model="reason"
          class="rh-textarea"
          rows="3"
          placeholder="One sentence — what does the human need to do?"
          data-test="rh-editor-reason"
        />
      </label>
      <div class="rh-field">
        <span class="rh-field-label">Steps</span>
        <ol class="rh-steps">
          <li
            v-for="(step, i) in steps"
            :key="i"
            class="rh-step"
            :data-test="`rh-editor-step-${i}`"
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
              :disabled="i === steps.length - 1"
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
          data-test="rh-editor-add-step"
          @click="addStep"
        >+ Add step</button>
      </div>
      <p v-if="error" class="rh-error" data-test="rh-editor-error">{{ error }}</p>
    </div>
  </DanxDialog>
</template>

<style scoped>
.rh-editor-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
  color: #cbd5e1;
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
.rh-steps {
  margin: 0;
  padding-left: 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rh-step {
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
.rh-error {
  margin: 0;
  font-size: 12px;
  color: #fca5a5;
}
</style>
