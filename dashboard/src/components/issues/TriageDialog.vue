<script setup lang="ts">
/**
 * Triage dialog. Operator clicks the Triage button → dialog opens →
 * operator optionally types free-form instructions (≤2000 chars, the
 * worker cap) → submit POSTs to `/api/triage` via `triggerTriage`. No
 * card picker — the dispatched orchestrator
 * (`danxbot:danx-triage-orchestrator`) picks targets from the Review
 * list and fans out per-card subagents (cap 3 in flight).
 *
 * Empty instructions are valid — they trigger the default Review-list
 * orchestrator pass. The worker rejects empty / whitespace-only
 * non-null `instructions`, so the wrapper passes `null` instead of `""`
 * when the textarea is blank.
 *
 * Validation: any input >2000 chars is blocked client-side with an
 * inline error (no fetch). 4xx server errors surface the body's
 * `error` string verbatim. 5xx errors surface a generic
 * "dispatch failed, retry in a moment" so the operator does not see
 * raw stack details for transient infra failures.
 */
import { computed, ref, watch } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";
import { triggerTriage } from "../../api";

const props = defineProps<{
  /** v-model — controls visibility. */
  modelValue: boolean;
  /** Repo to scope the triage against. */
  repo: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
  /** Fired after a successful dispatch. */
  dispatched: [];
}>();

const MAX_INSTRUCTIONS_CHARS = 2000;

const RETRY_MESSAGE = "Dispatch failed, retry in a moment.";

const instructions = ref<string>("");
const submitting = ref<boolean>(false);
const errorMessage = ref<string | null>(null);

// Reset form state every time the dialog re-opens.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    instructions.value = "";
    submitting.value = false;
    errorMessage.value = null;
  },
  { immediate: true },
);

const oversized = computed<boolean>(
  () => instructions.value.length > MAX_INSTRUCTIONS_CHARS,
);

const canSubmit = computed<boolean>(
  () => !submitting.value && !oversized.value,
);

const charCountLabel = computed<string>(
  () => `${instructions.value.length} / ${MAX_INSTRUCTIONS_CHARS}`,
);

async function onSubmit(): Promise<void> {
  if (oversized.value) {
    errorMessage.value = `Instructions exceed the ${MAX_INSTRUCTIONS_CHARS}-character limit (current ${instructions.value.length}).`;
    return;
  }
  if (!canSubmit.value) return;

  submitting.value = true;
  errorMessage.value = null;
  // Empty/whitespace-only instructions => null. The worker's body
  // validation rejects an empty *string* but accepts omission entirely;
  // treating "" as null routes through the default-orchestrator path.
  const trimmed = instructions.value.trim();
  const payload: string | null = trimmed.length > 0 ? instructions.value : null;
  try {
    await triggerTriage(props.repo, payload);
    submitting.value = false;
    emit("dispatched");
    emit("update:modelValue", false);
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err
        ? Number((err as { status: unknown }).status)
        : 0;
    const serverMessage =
      err && typeof err === "object" && "serverMessage" in err
        ? (err as { serverMessage?: string }).serverMessage
        : undefined;
    if (status >= 500 || status === 0) {
      // Mask infra detail for transient failures — the operator can retry.
      errorMessage.value = RETRY_MESSAGE;
    } else if (serverMessage) {
      errorMessage.value = serverMessage;
    } else {
      errorMessage.value = err instanceof Error ? err.message : String(err);
    }
    submitting.value = false;
  }
}

function onClose(): void {
  if (submitting.value) return;
  emit("update:modelValue", false);
}
</script>

<template>
  <DanxDialog
    :model-value="modelValue"
    title="Triage Review list"
    subtitle="Dispatch an orchestrator to re-score Review cards (parallel batches of 3)"
    :persistent="submitting"
    :is-saving="submitting"
    :disabled="!canSubmit"
    close-button="Cancel"
    confirm-button="Triage"
    width="540px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @close="onClose"
    @confirm="onSubmit"
  >
    <form class="form" data-test="triage-dialog-form" @submit.prevent="onSubmit">
      <label class="field">
        <span class="label">
          Operator notes
          <span class="char-count" :class="{ over: oversized }">{{ charCountLabel }}</span>
        </span>
        <textarea
          v-model="instructions"
          class="input textarea"
          rows="6"
          spellcheck="true"
          data-test="triage-instructions"
          placeholder="Optional — direct the orchestrator. e.g. 'only Blocked cards', 'skip epics', 're-score considering DX-269', 'focus on cards older than 2 weeks'. Leave blank for a default Review-list pass."
        />
      </label>

      <p
        v-if="errorMessage"
        class="error"
        data-test="triage-error"
        role="alert"
      >{{ errorMessage }}</p>
    </form>
  </DanxDialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 0;
  padding: 0;
}
.label {
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.char-count {
  font-size: 10px;
  font-weight: 500;
  color: #64748b;
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.char-count.over {
  color: #fca5a5;
  font-weight: 600;
}
.input {
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  color: #e2e8f0;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #334155;
  border-radius: 6px;
  font-family: inherit;
  outline: none;
  transition: border-color 120ms;
}
.input:focus {
  border-color: rgb(99 102 241 / 0.6);
}
.textarea {
  resize: vertical;
  min-height: 110px;
  line-height: 1.45;
}
.error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgb(239 68 68 / 0.4);
  background: rgb(239 68 68 / 0.1);
  color: #fca5a5;
  font-size: 12px;
  white-space: pre-wrap;
}
</style>
