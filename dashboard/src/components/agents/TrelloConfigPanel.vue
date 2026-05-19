<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { DanxButton } from "@thehammer/danx-ui";
import type { AgentSnapshot, Feature } from "../../types";
import {
  patchTrelloCredentials,
  type ToggleError,
  type TrelloCredentialPatch,
} from "../../api";
import { envDefaultForFeature } from "../../featureDefaults";
import { useTransientStatus } from "../../composables/useTransientStatus";
import FeatureToggle from "./FeatureToggle.vue";

// DX-304 — dedicated Trello settings panel: trelloSync toggle (single
// source of truth in the UI), read-only board / list ids, and masked
// credential edit rows. Mounted under RepoCard on the Settings page.
//
// Architecture: the panel owns the credential PATCH flow end-to-end
// (input dirty state, error rendering, success refresh). The trelloSync
// toggle is delegated to the parent via the existing `toggle` event so
// the optimistic-update path in `useAgents.toggle` is the single
// authority on overrides.trelloSync.enabled. After a successful
// credential PATCH the panel emits `refresh` so the parent re-fetches
// the agent snapshot — masked display values update from the rotated
// .env, dirty state clears, error banner clears.

type CredentialField = "apiKey" | "apiToken";

interface CredentialRow {
  editing: boolean;
  input: string;
  revealing: boolean;
}

function makeRow(): CredentialRow {
  return { editing: false, input: "", revealing: false };
}

const props = defineProps<{
  agent: AgentSnapshot;
  busyFeature: Feature | null;
}>();

const emit = defineEmits<{
  toggle: [repo: string, feature: Feature, enabled: boolean | null];
  refresh: [repo: string];
}>();

// Per-field UI state — one object per credential so adding a new field
// (e.g. a future board-secret rotation) lands one entry, not three
// parallel maps to keep in sync.
const rows = reactive<Record<CredentialField, CredentialRow>>({
  apiKey: makeRow(),
  apiToken: makeRow(),
});
const saving = ref<boolean>(false);
const errorMessage = ref<string | null>(null);
const restartRequired = ref<boolean>(false);
// "idle" | "copied" | "failed" — surfaces the clipboard outcome inline
// for ~2s so the operator gets feedback on insecure-context / permission
// failures instead of a silent click. Resets back to idle automatically.
const copy = useTransientStatus<"idle" | "copied" | "failed">({
  idleMs: 2000,
  idleValue: "idle",
});
const copyState = copy.status;

// Vite injects DEV=true under `vitest run`/`npm run dev`, false in
// `npm run build`. Operators in prod must NEVER see a button that
// reveals a secret. Spec: `[reveal]` is dev-mode only.
const showReveal = computed<boolean>(() => import.meta.env.DEV === true);

const display = computed(() => props.agent.settings.display.trello ?? {});

const overrideValue = computed<boolean | null>(
  () => props.agent.settings.overrides.trelloSync.enabled,
);

const envDefault = computed<boolean>(
  () => envDefaultForFeature(props.agent, "trelloSync"),
);

const effectiveSyncEnabled = computed<boolean>(() =>
  overrideValue.value === null ? envDefault.value : overrideValue.value,
);

const effectiveSourceLabel = computed<string>(() =>
  overrideValue.value === null ? "env default" : "override",
);

function displayString(key: string): string {
  const value = display.value[key];
  return typeof value === "string" && value.length > 0 ? value : "(not set)";
}

function maskedValue(field: CredentialField): string {
  return displayString(field);
}

function startEdit(field: CredentialField): void {
  rows[field].editing = true;
  rows[field].input = "";
  errorMessage.value = null;
  restartRequired.value = false;
}

function cancelEdit(field: CredentialField): void {
  rows[field] = makeRow();
}

function toggleReveal(field: CredentialField): void {
  if (!showReveal.value) return;
  rows[field].revealing = !rows[field].revealing;
}

function inputType(field: CredentialField): "password" | "text" {
  return rows[field].revealing ? "text" : "password";
}

// Dirty = the operator opened the editor AND typed at least one
// non-whitespace character. Empty inputs are noops — clicking [edit]
// without typing must NOT overwrite the existing credential.
function isDirty(field: CredentialField): boolean {
  return rows[field].editing && rows[field].input.trim().length > 0;
}

const saveDisabled = computed<boolean>(() => {
  if (saving.value) return true;
  return !isDirty("apiKey") && !isDirty("apiToken");
});

function buildPatch(): TrelloCredentialPatch {
  const patch: TrelloCredentialPatch = {};
  if (isDirty("apiKey")) patch.apiKey = rows.apiKey.input.trim();
  if (isDirty("apiToken")) patch.apiToken = rows.apiToken.input.trim();
  return patch;
}

async function onSave(): Promise<void> {
  if (saveDisabled.value) return;
  const patch = buildPatch();
  saving.value = true;
  errorMessage.value = null;
  restartRequired.value = false;
  try {
    const result = await patchTrelloCredentials(props.agent.name, patch);
    restartRequired.value = result.restartRequired;
    // Close editors + clear inputs for the fields the backend rotated.
    // A partial-success response (e.g. server-side preflight rejects
    // one field) MUST leave the un-rotated editor open so the operator
    // can correct + retry without re-typing the successful field.
    for (const field of result.updated) {
      rows[field] = makeRow();
    }
    emit("refresh", props.agent.name);
  } catch (err) {
    const te = err as ToggleError;
    errorMessage.value =
      te?.serverMessage ?? te?.message ?? "Failed to rotate credentials.";
  } finally {
    saving.value = false;
  }
}

async function onCopyBoardId(): Promise<void> {
  const value = display.value["boardId"];
  if (typeof value !== "string" || value.length === 0) return;
  try {
    await navigator.clipboard.writeText(value);
    copy.set("copied");
  } catch {
    // Insecure contexts (HTTP) + permission-denied don't crash —
    // surface the failure inline so the operator can manually select.
    copy.set("failed");
  }
}
</script>

<template>
  <article
    class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
    data-test="trello-config-panel"
  >
    <header class="mb-3 flex items-center justify-between">
      <h3 class="text-base font-bold text-gray-900 dark:text-white">
        Trello configuration
      </h3>
      <span
        v-if="restartRequired"
        class="text-xs font-medium text-amber-700 dark:text-amber-300"
        data-test="trello-restart-required"
      >
        Restart worker to apply rotated credentials.
      </span>
    </header>

    <FeatureToggle
      feature="trelloSync"
      label="Trello sync"
      :enabled="overrideValue"
      :env-default="envDefault"
      subline="inbound + outbound Trello calls"
      :busy="busyFeature === 'trelloSync'"
      @change="(f, e) => $emit('toggle', agent.name, f, e)"
    />

    <p
      class="mt-2 text-xs text-gray-500 dark:text-gray-400"
      data-test="trello-effective-line"
    >
      Effective: <span class="font-semibold">{{ effectiveSyncEnabled ? "true" : "false" }}</span>
      (from <span>{{ effectiveSourceLabel }}</span>)
    </p>

    <div class="mt-4 space-y-2" data-test="trello-id-rows">
      <div class="flex items-center justify-between text-sm">
        <span class="text-gray-700 dark:text-gray-300">Board ID</span>
        <span class="flex items-center gap-2">
          <code
            class="font-mono text-xs text-gray-900 dark:text-gray-100"
            data-test="trello-board-id"
          >{{ displayString("boardId") }}</code>
          <DanxButton
            variant="muted"
            size="xs"
            class="bg-transparent border-0 underline"
            data-test="trello-copy-board-id"
            :disabled="displayString('boardId') === '(not set)'"
            @click="onCopyBoardId"
          >
            copy
          </DanxButton>
          <span
            v-if="copyState === 'copied'"
            class="text-xs text-green-600 dark:text-green-400"
            data-test="trello-copy-feedback"
          >copied</span>
          <span
            v-else-if="copyState === 'failed'"
            class="text-xs text-red-600 dark:text-red-400"
            data-test="trello-copy-feedback"
          >copy failed — select &amp; ctrl-c</span>
        </span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-gray-700 dark:text-gray-300">ToDo list ID</span>
        <code
          class="font-mono text-xs text-gray-900 dark:text-gray-100"
          data-test="trello-todo-list-id"
        >{{ displayString("todoListId") }}</code>
      </div>
    </div>

    <div class="mt-4 space-y-3" data-test="trello-credential-rows">
      <div
        v-for="field in (['apiKey', 'apiToken'] as const)"
        :key="field"
        class="flex items-center justify-between gap-2 text-sm"
      >
        <span class="text-gray-700 dark:text-gray-300 w-24">
          {{ field === "apiKey" ? "API Key" : "API Token" }}
        </span>
        <span v-if="!rows[field].editing" class="flex flex-1 items-center justify-end gap-2">
          <code
            class="font-mono text-xs text-gray-900 dark:text-gray-100"
            :data-test="`trello-${field}-masked`"
          >{{ maskedValue(field) }}</code>
          <DanxButton
            variant="muted"
            size="xs"
            class="bg-transparent border-0 underline"
            :data-test="`trello-${field}-edit`"
            :disabled="saving"
            @click="startEdit(field)"
          >
            edit
          </DanxButton>
        </span>
        <span v-else class="flex flex-1 items-center justify-end gap-2">
          <input
            v-model="rows[field].input"
            :type="inputType(field)"
            :placeholder="field === 'apiKey' ? 'paste new API key' : 'paste new API token'"
            autocomplete="off"
            spellcheck="false"
            class="flex-1 max-w-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 dark:text-gray-100 px-2 py-1 text-xs font-mono"
            :data-test="`trello-${field}-input`"
            :disabled="saving"
          />
          <DanxButton
            v-if="showReveal"
            variant="muted"
            size="xs"
            class="bg-transparent border-0 underline"
            :data-test="`trello-${field}-reveal`"
            :disabled="saving"
            @click="toggleReveal(field)"
          >
            {{ rows[field].revealing ? "hide" : "reveal" }}
          </DanxButton>
          <DanxButton
            variant="muted"
            size="xs"
            class="bg-transparent border-0 underline"
            :data-test="`trello-${field}-cancel`"
            :disabled="saving"
            @click="cancelEdit(field)"
          >
            cancel
          </DanxButton>
        </span>
      </div>
    </div>

    <div class="mt-4 flex items-center justify-between gap-3">
      <p
        v-if="errorMessage"
        class="text-xs text-red-600 dark:text-red-400"
        data-test="trello-save-error"
      >
        {{ errorMessage }}
      </p>
      <span v-else class="flex-1" aria-hidden="true" />
      <DanxButton
        variant=""
        size="sm"
        data-test="trello-save"
        :disabled="saveDisabled"
        :loading="saving"
        @click="onSave"
      >
        {{ saving ? "Saving…" : "Save" }}
      </DanxButton>
    </div>
  </article>
</template>
