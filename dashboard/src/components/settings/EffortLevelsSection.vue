<script setup lang="ts">
/**
 * DX-510 — Settings tab "Effort levels" section. Renders the seven
 * canonical effort levels as an editable table (label fixed, model +
 * effort editable) plus a textarea below for the operator-tunable
 * `effortAssignmentPrompt`. Save button PATCHes both fields atomically
 * via `patchEffortSettings`.
 *
 * Source of truth: `props.settings.effortLevels` /
 * `props.settings.effortAssignmentPrompt`. The reader on the backend
 * normalizes missing / malformed values to defaults so the props are
 * always populated. SSE `agent:updated` updates the parent's snapshot
 * which re-renders here — operator never sees a torn state.
 *
 * Reset-to-default for the prompt writes the empty string; the reader's
 * normalize step then serves the built-in default text on the next
 * read. The textarea re-populates with the resolved (default) value via
 * the prop, so the operator sees the default they will get.
 */
import { computed, ref, watch } from "vue";
import { DanxButton } from "@thehammer/danx-ui";
import { patchEffortSettings, type ToggleError } from "../../api";
import type {
  EffortLevelMapping,
  EffortLevelName,
  Settings,
} from "../../types";
import { EFFORT_LEVEL_NAMES } from "../../types";

const props = defineProps<{
  repo: string;
  settings: Settings;
}>();

// Working draft state that the operator edits in place. We seed from
// props and re-seed whenever the prop reference flips (a fresh
// snapshot from SSE) — but only when the operator is not mid-edit, so
// an inflight server push does not clobber a draft.
const isDirty = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

const draftLevels = ref<EffortLevelMapping[]>(
  seedLevels(props.settings.effortLevels),
);
const draftPrompt = ref<string>(
  typeof props.settings.effortAssignmentPrompt === "string"
    ? props.settings.effortAssignmentPrompt
    : "",
);

function seedLevels(
  levels: readonly EffortLevelMapping[] | undefined,
): EffortLevelMapping[] {
  const list: EffortLevelMapping[] = [];
  for (let i = 0; i < EFFORT_LEVEL_NAMES.length; i++) {
    const name = EFFORT_LEVEL_NAMES[i] as EffortLevelName;
    const row = levels?.[i];
    list.push({
      name,
      model: row?.model ?? "",
      effort: row?.effort ?? "",
    });
  }
  return list;
}

// Re-seed on prop flip — but only when the operator hasn't started
// editing. Preserves draft state during an SSE-driven re-render.
watch(
  () => props.settings.effortLevels,
  (next) => {
    if (!isDirty.value) draftLevels.value = seedLevels(next);
  },
  { deep: false },
);
watch(
  () => props.settings.effortAssignmentPrompt,
  (next) => {
    if (!isDirty.value) {
      draftPrompt.value = typeof next === "string" ? next : "";
    }
  },
);

function onLevelEdit(i: number, field: "model" | "effort", value: string): void {
  const row = draftLevels.value[i];
  draftLevels.value = [
    ...draftLevels.value.slice(0, i),
    { ...row, [field]: value },
    ...draftLevels.value.slice(i + 1),
  ];
  isDirty.value = true;
}

function onPromptEdit(value: string): void {
  draftPrompt.value = value;
  isDirty.value = true;
}

/**
 * Reset-to-default: write `""` to the prompt. The backend reader
 * normalizes empty → default text, and the next SSE snapshot reseeds
 * `draftPrompt` with that default. We do this through a Save so the
 * operator sees one round-trip with the actual default the reader will
 * serve, not a guess at the default string.
 */
async function onResetPrompt(): Promise<void> {
  if (saving.value) return;
  draftPrompt.value = "";
  isDirty.value = true;
  await onSave();
}

const canSave = computed<boolean>(() => isDirty.value && !saving.value);

async function onSave(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  errorMessage.value = null;
  try {
    await patchEffortSettings(props.repo, {
      effortLevels: draftLevels.value.map((r) => ({ ...r })),
      effortAssignmentPrompt: draftPrompt.value,
    });
    isDirty.value = false;
  } catch (err) {
    const te = err as ToggleError;
    errorMessage.value =
      te?.serverMessage ?? te?.message ?? "Save effort settings failed.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    class="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
    data-test="effort-levels-section"
  >
    <header class="mb-3 flex items-start justify-between">
      <div>
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">
          Effort levels
        </h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Operator-tuned table that maps the seven canonical effort labels
          to `{model, effort}` pairs. Agents pick a level via the assignment
          prompt below.
        </p>
      </div>
    </header>

    <table class="w-full text-sm" data-test="effort-levels-table">
      <thead>
        <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <th class="pb-2 font-semibold">Label</th>
          <th class="pb-2 pl-3 font-semibold">Model</th>
          <th class="pb-2 pl-3 font-semibold">Effort</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, i) in draftLevels"
          :key="row.name"
          class="border-t border-gray-100 dark:border-gray-700"
          :data-test="`effort-row-${row.name}`"
        >
          <td class="py-2 font-mono text-xs text-gray-700 dark:text-gray-200">
            {{ row.name }}
          </td>
          <td class="py-2 pl-3">
            <input
              type="text"
              class="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100"
              :value="row.model"
              :data-test="`effort-model-${row.name}`"
              @input="(e) => onLevelEdit(i, 'model', (e.target as HTMLInputElement).value)"
            />
          </td>
          <td class="py-2 pl-3">
            <input
              type="text"
              class="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100"
              :value="row.effort"
              :data-test="`effort-effort-${row.name}`"
              @input="(e) => onLevelEdit(i, 'effort', (e.target as HTMLInputElement).value)"
            />
          </td>
        </tr>
      </tbody>
    </table>

    <div class="mt-5">
      <label class="block">
        <span class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Assignment prompt
        </span>
        <textarea
          class="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100"
          rows="10"
          :value="draftPrompt"
          data-test="effort-prompt"
          @input="(e) => onPromptEdit((e.target as HTMLTextAreaElement).value)"
        ></textarea>
      </label>
      <div class="mt-2 flex justify-end">
        <DanxButton
          variant="muted"
          size="xs"
          class="effort-prompt-reset-btn"
          :disabled="saving"
          data-test="effort-prompt-reset"
          @click="onResetPrompt"
        >
          Reset to default
        </DanxButton>
      </div>
    </div>

    <div
      v-if="errorMessage"
      class="mt-3 rounded-md border border-red-400 bg-red-50 dark:bg-red-900/20 dark:border-red-600 p-3 text-sm text-red-700 dark:text-red-300"
      data-test="effort-settings-error"
    >
      {{ errorMessage }}
    </div>

    <div class="mt-4 flex items-center justify-end gap-2">
      <DanxButton
        variant=""
        size="sm"
        :disabled="!canSave"
        :loading="saving"
        data-test="effort-settings-save"
        @click="onSave"
      >
        {{ saving ? "Saving…" : "Save" }}
      </DanxButton>
    </div>
  </section>
</template>
