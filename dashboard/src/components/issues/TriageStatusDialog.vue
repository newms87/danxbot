<script setup lang="ts">
/**
 * Status + cancel dialog for an in-flight triage orchestrator dispatch.
 *
 * Shows:
 *   - Current status (`queued` / `running`) + elapsed time since start.
 *   - Operator notes — the `## Operator notes` block stripped out of
 *     the dispatch's initial prompt. If the prompt is bare
 *     `/danx-triage-orchestrator`, renders the default-pass note.
 *   - Cancel button → POST `/api/cancel/:jobId?repo=`. SSE bus surfaces
 *     the status flip to `cancelled` and the parent component swaps the
 *     indicator back to the Triage button automatically.
 *
 * The dispatch row is passed in as a prop so the dialog re-renders in
 * lockstep with the SSE-fed parent. Closing the dialog only hides it —
 * the dispatch keeps running.
 */
import { computed, ref, watch } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";
import type { Dispatch } from "../../types";
import { cancelDispatch, type ToggleError } from "../../api";
import { useNowTick } from "../../composables/useNowTick";

const props = defineProps<{
  modelValue: boolean;
  repo: string;
  dispatch: Dispatch;
}>();

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
}>();

const cancelling = ref<boolean>(false);
const errorMessage = ref<string | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    cancelling.value = false;
    errorMessage.value = null;
  },
);

const OPERATOR_NOTES_RE = /\n\n## Operator notes\n\n([\s\S]*)$/;

const operatorNotes = computed<string | null>(() => {
  const prompt = (props.dispatch.triggerMetadata as { initialPrompt?: string })
    .initialPrompt;
  if (!prompt) return null;
  const m = prompt.match(OPERATOR_NOTES_RE);
  return m ? m[1].trim() : null;
});

const now = useNowTick(1_000);
const elapsedLabel = computed<string>(() => {
  const startedMs = props.dispatch.startedAt;
  const diffMs = Math.max(0, now.value - startedMs);
  const totalSec = Math.floor(diffMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
});

async function onCancel(): Promise<void> {
  if (cancelling.value) return;
  cancelling.value = true;
  errorMessage.value = null;
  try {
    await cancelDispatch(props.repo, props.dispatch.id);
    emit("update:modelValue", false);
  } catch (err) {
    const e = err as ToggleError;
    errorMessage.value =
      e.serverMessage ?? (err instanceof Error ? err.message : String(err));
    cancelling.value = false;
  }
}

function onClose(): void {
  if (cancelling.value) return;
  emit("update:modelValue", false);
}
</script>

<template>
  <DanxDialog
    :model-value="modelValue"
    title="Triage running"
    :subtitle="`Status: ${dispatch.status} · running ${elapsedLabel}`"
    :persistent="cancelling"
    :is-saving="cancelling"
    close-button="Close"
    confirm-button="Cancel triage"
    confirm-button-class="confirm-cancel"
    width="540px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @close="onClose"
    @confirm="onCancel"
  >
    <div class="body" data-test="triage-status-body">
      <section class="field">
        <span class="label">Dispatch</span>
        <code class="mono">{{ dispatch.id }}</code>
      </section>

      <section class="field">
        <span class="label">Operator notes</span>
        <p
          v-if="operatorNotes"
          class="notes"
          data-test="triage-status-notes"
        >{{ operatorNotes }}</p>
        <p
          v-else
          class="notes empty"
          data-test="triage-status-notes-empty"
        >Default pass — no operator notes. Orchestrator triages the Review list.</p>
      </section>

      <p
        v-if="errorMessage"
        class="error"
        data-test="triage-status-error"
        role="alert"
      >{{ errorMessage }}</p>
    </div>
  </DanxDialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cbd5e1;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  border-radius: 4px;
  padding: 4px 8px;
  align-self: flex-start;
}
.notes {
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  color: #e2e8f0;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  border-radius: 6px;
  white-space: pre-wrap;
}
.notes.empty {
  color: #94a3b8;
  font-style: italic;
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
