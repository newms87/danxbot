<script setup lang="ts">
/**
 * DX-586 — INTO-blocked confirmation dialog. The board's drag/drop or
 * the drawer's List dropdown triggers a move whose destination's
 * `ListType === "blocked"`; the parent (`IssuesPage`) opens this
 * dialog instead of firing the PATCH immediately. Submit → parent
 * calls `useIssues.moveIssueList(id, destList, {blocked: {reason}})`;
 * cancel → no-op (the optimistic mutation has NOT fired yet — the
 * card stays in its source column).
 *
 * Conforms to the dashboard's DanxUI mandate
 * (`.claude/rules/dashboard.md`): the modal shell is `DanxDialog`, the
 * primary action is `DanxButton`, no raw `<dialog>` / `title=` /
 * one-off CSS modal.
 *
 * The reason field is required (non-empty after trim). Pressing
 * Enter inside the textarea submits when valid; Esc + the dialog's
 * X close.
 */
import { computed, ref, watch, nextTick } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";

const props = defineProps<{
  /** Open / close (v-model). */
  modelValue: boolean;
  /** Issue id rendered in the dialog header — `Move DX-586 to Blocked`. */
  issueId: string;
  /** Destination blocked-type list's display name. */
  destListName: string;
  /** Bubble up the submit's busy state so the parent can disable input. */
  busy?: boolean;
  /** Optional server error from the parent's last PATCH attempt. */
  error?: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  /** Submit — parent runs the PATCH with `{blocked: {reason}}`. */
  submit: [reason: string];
  /** Cancel — parent closes the dialog with no state change. */
  cancel: [];
}>();

const reason = ref("");
const reasonInput = ref<HTMLTextAreaElement | null>(null);

// Reset the field every time the dialog (re-)opens so an aborted
// previous flow does not leak its draft into the next card.
watch(
  () => props.modelValue,
  async (next) => {
    if (next) {
      reason.value = "";
      await nextTick();
      reasonInput.value?.focus();
    }
  },
);

const isValid = computed(() => reason.value.trim().length > 0);

function onSubmit(): void {
  if (!isValid.value || props.busy) return;
  emit("submit", reason.value.trim());
}

function onCancel(): void {
  emit("cancel");
  emit("update:modelValue", false);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    onSubmit();
  }
}
</script>

<template>
  <DanxDialog
    :model-value="props.modelValue"
    :title="`Move ${props.issueId} to ${props.destListName}`"
    :close-button="'Cancel'"
    :confirm-button="props.busy ? 'Saving…' : 'Block'"
    :is-saving="props.busy"
    :disabled="!isValid"
    persistent
    @close="onCancel"
    @confirm="onSubmit"
    @update:model-value="(v: boolean) => { if (!v) onCancel(); }"
  >
    <div class="body" data-test="blocked-dialog-body">
      <label class="field-label" for="blocked-reason">
        Why is this card blocked?
      </label>
      <textarea
        id="blocked-reason"
        ref="reasonInput"
        v-model="reason"
        class="reason-input"
        rows="3"
        :disabled="props.busy"
        placeholder="e.g. Spec needs clarification from product"
        data-test="blocked-dialog-reason"
        @keydown="onKeydown"
      />
      <p class="hint">
        The reason is appended to the card and surfaces in the Blocked
        banner. Cmd/Ctrl + Enter to submit.
      </p>
      <p
        v-if="props.error"
        class="error"
        data-test="blocked-dialog-error"
      >{{ props.error }}</p>
    </div>
  </DanxDialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field-label {
  font-size: 12px;
  font-weight: 600;
  color: #cbd5e1;
}
.reason-input {
  width: 100%;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  color: #e2e8f0;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  resize: vertical;
  min-height: 64px;
}
.reason-input:focus {
  outline: 0;
  border-color: rgb(99 102 241 / 0.55);
}
.reason-input:disabled {
  opacity: 0.6;
  cursor: progress;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: #64748b;
}
.error {
  margin: 0;
  padding: 6px 8px;
  font-size: 11px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.12);
  border: 1px solid rgb(239 68 68 / 0.3);
  border-radius: 4px;
}
</style>
