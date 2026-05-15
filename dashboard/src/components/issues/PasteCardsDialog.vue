<script setup lang="ts">
/**
 * DX-519 — Paste dialog. Operator clicks Paste on the Issues list page,
 * which opens this dialog. A textarea accepts the JSON payload produced
 * by the Copy button (or anything in `IssueCopyPayload` shape from a
 * file / second dashboard). On Import the dialog POSTs to
 * `/api/issues/import?repo=<target>`; the server allocates fresh
 * `<PREFIX>-N` ids, rewrites internal refs, and atomically writes
 * every YAML. Successful import emits the new top-level id so the
 * caller can open the drawer on it.
 *
 * Clipboard read is attempted automatically when the dialog opens —
 * `navigator.clipboard.readText()` requires a focused secure context,
 * and some browsers reject it without explicit user activation. When
 * the read succeeds AND the value parses, the textarea pre-fills; on
 * any failure the operator pastes manually with no error message
 * (auto-read is convenience, not a contract).
 *
 * Validation strategy: the dialog accepts ANY non-empty text. Server-
 * side validation (`validatePayloadShape` + parseIssue round-trip)
 * owns the 400 surface. The dialog only catches `JSON.parse` errors
 * (purely client-side) so the operator gets immediate feedback on a
 * malformed paste before the round-trip; everything else flows
 * through the server and surfaces via the `ToggleError.serverMessage`.
 */
import { computed, ref, watch } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";
import type { Issue, IssueCopyPayload } from "../../types";
import { importIssues } from "../../api";

const props = defineProps<{
  /** v-model — controls visibility. */
  modelValue: boolean;
  /** Target repo to import into. */
  repo: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
  /**
   * Fired after a successful import — gives the parent the new top-
   * level id so it can open the drawer / scroll the new card into
   * view without waiting for the SSE round-trip.
   */
  imported: [topId: string, totalCards: number];
}>();

const payloadText = ref<string>("");
const submitting = ref<boolean>(false);
const errorMessage = ref<string | null>(null);
const lastResultMessage = ref<string | null>(null);

// Reset state every time the dialog re-opens; attempt a clipboard
// auto-read so the operator can hit Import without manually pasting.
// Auto-read failures (insecure context, permission denied, browser
// policy) silently leave the textarea empty — the manual paste path
// works the same way. `immediate: true` ensures the read fires when
// the dialog mounts with `modelValue: true` from the parent (e.g. on
// the first render after opening) — without it the watcher would
// only fire on subsequent toggles.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    payloadText.value = "";
    submitting.value = false;
    errorMessage.value = null;
    lastResultMessage.value = null;
    if (!navigator.clipboard?.readText) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().length > 0) {
        // Best-effort sanity check that the value looks like our
        // payload before stuffing it into the textarea — avoids
        // pre-filling with random clipboard content (URLs, code
        // snippets, prose).
        try {
          const parsed = JSON.parse(text);
          if (
            parsed &&
            typeof parsed === "object" &&
            "schema_version" in parsed &&
            "issues" in parsed &&
            Array.isArray((parsed as { issues: unknown }).issues)
          ) {
            payloadText.value = text;
          }
        } catch {
          /* not JSON — leave textarea empty */
        }
      }
    } catch {
      /* clipboard read denied — operator pastes manually */
    }
  },
  { immediate: true },
);

const canSubmit = computed<boolean>(
  () => !submitting.value && payloadText.value.trim().length > 0,
);

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorMessage.value = null;
  let parsed: IssueCopyPayload;
  try {
    parsed = JSON.parse(payloadText.value) as IssueCopyPayload;
  } catch (err) {
    errorMessage.value =
      err instanceof Error
        ? `Paste is not valid JSON: ${err.message}`
        : "Paste is not valid JSON";
    submitting.value = false;
    return;
  }
  try {
    const result: { topId: string; issues: Issue[] } = await importIssues(
      props.repo,
      parsed,
    );
    const n = result.issues.length;
    lastResultMessage.value = `Imported ${n} ${n === 1 ? "card" : "cards"} — opening ${result.topId}`;
    submitting.value = false;
    emit("imported", result.topId, n);
    emit("update:modelValue", false);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
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
    title="Paste cards"
    subtitle="Imports a Copy payload into this dashboard"
    :persistent="submitting"
    :is-saving="submitting"
    :disabled="!canSubmit"
    close-button="Cancel"
    confirm-button="Import"
    width="640px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @close="onClose"
    @confirm="onSubmit"
  >
    <form
      class="form"
      data-test="paste-cards-form"
      @submit.prevent="onSubmit"
    >
      <label class="field">
        <span class="label">JSON payload</span>
        <textarea
          v-model="payloadText"
          class="input textarea"
          rows="14"
          required
          spellcheck="false"
          data-test="paste-cards-textarea"
          placeholder='{"schema_version": 9, "issues": [...]}'
        />
      </label>
      <p
        v-if="errorMessage"
        class="error"
        data-test="paste-cards-error"
        role="alert"
      >{{ errorMessage }}</p>
    </form>
  </DanxDialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
}
.input {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #e2e8f0;
  background: rgb(15 23 42 / 0.7);
  border: 1px solid #334155;
  border-radius: 6px;
  outline: none;
  transition: border-color 120ms;
}
.input:focus {
  border-color: rgb(99 102 241 / 0.6);
}
.textarea {
  resize: vertical;
  min-height: 180px;
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
