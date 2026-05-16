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
 * DX-544 — UI overhaul:
 *  - Status + Type render as `<DanxTabs>` with per-tab `color` pulled
 *    from `issuePalette.ts` (canonical color tokens for the column +
 *    type chips, so the dialog is visually consistent with the Issues
 *    tab columns and the IssueCard chips).
 *  - Priority renders as a row of tier buttons backed by
 *    `PRIORITY_TIERS` from `dashboard/src/lib/priorityTier.ts`;
 *    clicking a tier commits its `defaultValue`. Default = `medium`
 *    (3.0, `PRIORITY_DEFAULT`).
 *  - Description renders as `<MarkdownEditor>` from `@thehammer/danx-ui`,
 *    positioned LAST in the form. A muted helper note immediately above
 *    the editor explains that an LLM agent will probe the codebase and
 *    rewrite the body + AC after submit.
 *  - The create POST always lands the card in `status: "Blocked"` on
 *    the server side (with a sentinel `blocked.reason` encoding the
 *    operator's chosen starting status); the flesh-out agent clears the
 *    block + restores the chosen status. The race the dialog used to
 *    have with the poller is closed at the server layer; this component
 *    still sends the operator's chosen starting status verbatim.
 */
import { computed, ref, watch } from "vue";
import { DanxDialog, DanxTabs, MarkdownEditor, type DanxTab } from "@thehammer/danx-ui";
import { createIssue, fleshOutIssue, type IssueCreateInput } from "../../api";
import { COLUMN_ACCENTS, ISSUE_TYPE_META, typeToId } from "./issuePalette";
import { PRIORITY_TIERS, priorityTier, type PriorityTierKey } from "../../lib/priorityTier";

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

const STATUS_TABS: DanxTab[] = [
  {
    value: "Review",
    label: "Review",
    activeColor: COLUMN_ACCENTS.Review.accent,
  },
  {
    value: "ToDo",
    label: "ToDo",
    activeColor: COLUMN_ACCENTS.ToDo.accent,
  },
];

const TYPE_TABS: DanxTab[] = (
  ["Bug", "Feature", "Epic", "Chore"] as const
).map<DanxTab>((t) => ({
  value: t,
  label: t,
  activeColor: ISSUE_TYPE_META[typeToId(t)].fg,
}));

const PRIORITY_DEFAULT_TIER: PriorityTierKey = "medium";

const title = ref<string>("");
const description = ref<string>("");
const status = ref<IssueCreateInput["status"]>("Review");
const type = ref<IssueCreateInput["type"]>("Feature");
const priority = ref<number>(
  PRIORITY_TIERS.find((t) => t.key === PRIORITY_DEFAULT_TIER)!.defaultValue,
);
const submitting = ref<boolean>(false);
const errorMessage = ref<string | null>(null);

const activeTierKey = computed<PriorityTierKey>(() => priorityTier(priority.value));

function pickTier(tier: PriorityTierKey): void {
  const t = PRIORITY_TIERS.find((p) => p.key === tier);
  if (t) priority.value = t.defaultValue;
}

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
      priority.value = PRIORITY_TIERS.find(
        (t) => t.key === PRIORITY_DEFAULT_TIER,
      )!.defaultValue;
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
    const { issue } = await createIssue(props.repo, {
      title: title.value.trim(),
      description: description.value.trim(),
      status: status.value,
      type: type.value,
      priority: priority.value,
    });
    // Fire flesh-out — do not await; the operator sees the stub card
    // appear immediately, then watches it grow over the next ~30-60s.
    // Swallow rejection so a flesh-out failure does not block the
    // create-flow happy path (the operator can re-trigger via the
    // drawer if it fails).
    void fleshOutIssue(props.repo, issue.id).catch(() => {});
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
    width="640px"
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

      <div class="field" data-test="create-card-status">
        <span class="label">Status</span>
        <DanxTabs v-model="status" :tabs="STATUS_TABS" />
      </div>

      <div class="field" data-test="create-card-type">
        <span class="label">Type</span>
        <DanxTabs v-model="type" :tabs="TYPE_TABS" />
      </div>

      <div class="field" data-test="create-card-priority">
        <span class="label">Priority</span>
        <div class="priority-row" role="radiogroup">
          <button
            v-for="tier in PRIORITY_TIERS"
            :key="tier.key"
            type="button"
            class="priority-tier"
            :class="{ active: activeTierKey === tier.key }"
            :data-test="`priority-${tier.key}`"
            :aria-pressed="activeTierKey === tier.key"
            @click="pickTier(tier.key)"
          >{{ tier.label }}</button>
        </div>
      </div>

      <div class="field">
        <span class="label">Description</span>
        <p class="helper" data-test="create-card-llm-note">
          One sentence is enough — an LLM agent reads the codebase and
          rewrites the full description plus acceptance criteria after submit.
        </p>
        <div class="editor-wrap" data-test="create-card-description-wrap">
          <MarkdownEditor
            v-model="description"
            hide-footer
            data-test="create-card-description"
          />
        </div>
      </div>

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
.helper {
  margin: 0;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.45;
}
.editor-wrap {
  border: 1px solid #334155;
  border-radius: 6px;
}
.priority-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.priority-tier {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: #cbd5e1;
  background: rgb(15 23 42 / 0.4);
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
  transition: border-color 120ms, background 120ms;
}
.priority-tier.active {
  color: #e2e8f0;
  border-color: rgb(99 102 241 / 0.55);
  background: rgb(99 102 241 / 0.12);
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
