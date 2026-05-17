<script setup lang="ts">
/**
 * DX-586 — OUT-of-blocked confirmation dialog. Fires when the operator
 * drags a card OUT of a `blocked`-type column (or picks a non-blocked
 * list from the drawer's List dropdown) AND the card currently carries
 * `blocked != null`. Confirm → parent calls
 * `useIssues.moveIssueList(id, destList, {blocked: null})`; cancel →
 * no-op (the card stays in the Blocked column visually because the
 * optimistic mutation has NOT fired yet).
 *
 * The card's current `blocked.reason` is rendered so the operator
 * can confirm they understand what they're clearing — the reason is
 * about to be discarded (set to null), and there is no undo.
 *
 * DanxUI mandate: shell is `DanxDialog`, primary action is the dialog's
 * own confirm button. No raw `<dialog>` / `title=` / one-off CSS.
 */
import { DanxDialog } from "@thehammer/danx-ui";

const props = defineProps<{
  modelValue: boolean;
  issueId: string;
  /** Destination list display name (where the card will land). */
  destListName: string;
  /** Current self-block reason — the field the operator is about to discard. */
  currentReason: string | null;
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  /** Confirm → parent runs the PATCH with `{blocked: null}`. */
  confirm: [];
  cancel: [];
}>();

function onConfirm(): void {
  if (props.busy) return;
  emit("confirm");
}

function onCancel(): void {
  emit("cancel");
  emit("update:modelValue", false);
}
</script>

<template>
  <DanxDialog
    :model-value="props.modelValue"
    :title="`Unblock ${props.issueId}?`"
    :close-button="'Keep blocked'"
    :confirm-button="props.busy ? 'Unblocking…' : `Unblock & move to ${props.destListName}`"
    :is-saving="props.busy"
    persistent
    @close="onCancel"
    @confirm="onConfirm"
    @update:model-value="(v: boolean) => { if (!v) onCancel(); }"
  >
    <div class="body" data-test="unblock-dialog-body">
      <p>
        This will clear the card's blocked reason and move it to
        <strong>{{ props.destListName }}</strong>. The reason text is
        discarded (no undo).
      </p>
      <div
        v-if="props.currentReason"
        class="reason-preview"
        data-test="unblock-dialog-reason"
      >
        <span class="reason-label">Current reason:</span>
        {{ props.currentReason }}
      </div>
      <p
        v-if="props.error"
        class="error"
        data-test="unblock-dialog-error"
      >{{ props.error }}</p>
    </div>
  </DanxDialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.5;
}
.body p {
  margin: 0;
}
.reason-preview {
  padding: 8px 10px;
  font-size: 12px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.08);
  border: 1px solid rgb(239 68 68 / 0.25);
  border-radius: 4px;
}
.reason-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  color: #fdba74;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 2px;
}
.error {
  padding: 6px 8px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.12);
  border: 1px solid rgb(239 68 68 / 0.3);
  border-radius: 4px;
  font-size: 11px;
}
</style>
