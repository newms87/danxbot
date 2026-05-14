<script setup lang="ts">
/**
 * DX-350 — Create Card dialog. Submitted by the operator from the Issues
 * tab. POSTs `/api/issues` (Phase 2 backend) to allocate the next
 * `<PREFIX>-N` + write the YAML, then fires `/api/flesh-out` (Phase 1)
 * fire-and-forget so the dispatched agent rewrites the description,
 * populates `ac[]`, and (if status: Review) ICE-scores the card.
 *
 * The Issues tab re-renders the new card immediately via the existing
 * `issue:updated` SSE topic — the dialog does NOT need to push the
 * created card up itself (the API echo is used only for the local
 * "card is being fleshed out" indicator).
 *
 * The flesh-out dispatch is fire-and-forget: a failure inside the
 * worker / poller queue does not roll back the create, and the
 * operator can still see the stub card. Surface a non-fatal warning
 * in the dialog if the fire fails, but always close on a successful
 * create.
 */
import { computed, ref, watch } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";
import { createIssue, fleshOutIssue, type IssueCreateInput } from "../../api";

const props = defineProps<{
  /** v-model — controls visibility. */
  modelValue: boolean;
  /** Repo to create the card under. */
  repo: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
  /**
   * Fired after a successful create — gives the parent the new id so
   * it can open the drawer / scroll the new card into view without
   * waiting for the SSE round-trip.
   */
  created: [issueId: string];
}>();

const STATUS_OPTIONS: ReadonlyArray<{ id: IssueCreateInput["status"]; label: string; hint: string }> = [
  {
    id: "Review",
    label: "Review",
    hint: "Triage + flesh-out before pickup",
  },
  {
    id: "ToDo",
    label: "ToDo",
    hint: "Ready to dispatch immediately",
  },
];

const TYPE_OPTIONS: ReadonlyArray<{ id: IssueCreateInput["type"]; label: string }> = [
  { id: "Bug", label: "Bug" },
  { id: "Feature", label: "Feature" },
  { id: "Epic", label: "Epic" },
  { id: "Chore", label: "Chore" },
];

const title = ref<string>("");
const description = ref<string>("");
const status = ref<IssueCreateInput["status"]>("Review");
const type = ref<IssueCreateInput["type"]>("Feature");
const submitting = ref<boolean>(false);
const errorMessage = ref<string | null>(null);

// Reset all form state every time the dialog re-opens so a previous
// validation error or stale draft doesn't leak across sessions.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      title.value = "";
      description.value = "";
      status.value = "Review";
      type.value = "Feature";
      submitting.value = false;
      errorMessage.value = null;
    }
  },
);

const canSubmit = computed<boolean>(
  () =>
    !submitting.value &&
    title.value.trim().length > 0 &&
    description.value.trim().length > 0,
);

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorMessage.value = null;
  try {
    const issue = await createIssue(props.repo, {
      title: title.value.trim(),
      description: description.value.trim(),
      status: status.value,
      type: type.value,
    });
    // Fire flesh-out — do not await; the operator sees the stub card
    // appear immediately, then watches it grow over the next ~30-60s.
    // Swallow rejection so a flesh-out failure does not block the
    // create-flow happy path (the operator can re-trigger via the
    // drawer if it fails).
    void fleshOutIssue(props.repo, issue.id).catch(() => {});
    // Reset submitting BEFORE the close emit so any caller that decides
    // to keep the dialog open after `created` (e.g. for a follow-up
    // action) sees a clean state. The `watch(props.modelValue)` reset
    // is the canonical path; this is defense-in-depth (code review).
    submitting.value = false;
    emit("created", issue.id);
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
    title="Create card"
    subtitle="Stub now, flesh-out in ~30s"
    :persistent="submitting"
    :is-saving="submitting"
    :disabled="!canSubmit"
    close-button="Cancel"
    confirm-button="Create"
    width="540px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @close="onClose"
    @confirm="onSubmit"
  >
    <form class="form" data-test="create-card-form" @submit.prevent="onSubmit">
      <label class="field">
        <span class="label">Title</span>
        <input
          v-model="title"
          type="text"
          class="input"
          autocomplete="off"
          autofocus
          required
          data-test="create-card-title"
        />
      </label>

      <label class="field">
        <span class="label">Description</span>
        <textarea
          v-model="description"
          class="input textarea"
          rows="4"
          required
          data-test="create-card-description"
          placeholder="One sentence is enough — the agent fleshes this out."
        />
      </label>

      <fieldset class="field">
        <legend class="label">Status</legend>
        <div class="radio-row" role="radiogroup" data-test="create-card-status">
          <label
            v-for="opt in STATUS_OPTIONS"
            :key="opt.id"
            class="radio"
            :class="{ active: status === opt.id }"
          >
            <input
              v-model="status"
              type="radio"
              :value="opt.id"
              :data-test="`status-${opt.id}`"
            />
            <span class="radio-label">{{ opt.label }}</span>
            <span class="radio-hint">{{ opt.hint }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="field">
        <legend class="label">Type</legend>
        <div class="radio-row tight" role="radiogroup" data-test="create-card-type">
          <label
            v-for="opt in TYPE_OPTIONS"
            :key="opt.id"
            class="radio compact"
            :class="{ active: type === opt.id }"
          >
            <input
              v-model="type"
              type="radio"
              :value="opt.id"
              :data-test="`type-${opt.id}`"
            />
            <span class="radio-label">{{ opt.label }}</span>
          </label>
        </div>
      </fieldset>

      <p
        v-if="errorMessage"
        class="error"
        data-test="create-card-error"
        role="alert"
      >
        {{ errorMessage }}
      </p>
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
  min-height: 80px;
  font-family: inherit;
  line-height: 1.45;
}
.radio-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.radio-row.tight {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 6px;
}
.radio {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  background: rgb(15 23 42 / 0.4);
  transition: border-color 120ms, background 120ms;
}
.radio.compact {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
}
.radio.active {
  border-color: rgb(99 102 241 / 0.55);
  background: rgb(99 102 241 / 0.12);
}
.radio input[type="radio"] {
  accent-color: #6366f1;
  cursor: pointer;
  margin-right: 6px;
}
.radio.compact input[type="radio"] {
  margin-right: 0;
}
.radio-label {
  font-size: 12px;
  color: #e2e8f0;
  font-weight: 500;
}
.radio-hint {
  font-size: 11px;
  color: #64748b;
  margin-left: 22px;
}
.error {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgb(239 68 68 / 0.4);
  background: rgb(239 68 68 / 0.1);
  color: #fca5a5;
  font-size: 12px;
}
</style>
