<script setup lang="ts">
import { ref, watch } from "vue";
import { DanxDialog } from "@thehammer/danx-ui";
import {
  patchGithubCredentials,
  type GithubCredentialsSnapshot,
  type ToggleError,
} from "../../api";

// DX-649 — Register/Rotate token modal. Pairs with GitHubCredentialsSection
// which owns the open/close state via useDialog. The modal is the single
// PATCH writer for `/api/agents/:repo/github-credentials`; on a 200 it
// emits `saved` carrying the fresh snapshot so the parent can update its
// badge without a second GET round-trip. 422 / network errors render
// inline and keep the form state — operator corrects + retries.

const props = defineProps<{
  open: boolean;
  repo: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [snapshot: GithubCredentialsSnapshot];
}>();

const token = ref<string>("");
const saving = ref<boolean>(false);
const errorMessage = ref<string | null>(null);

// Reset form whenever the dialog opens — stale token / error from a prior
// session would otherwise persist visually.
watch(
  () => props.open,
  (now) => {
    if (now) {
      token.value = "";
      errorMessage.value = null;
      saving.value = false;
    }
  },
);

async function onConfirm(): Promise<void> {
  const trimmed = token.value.trim();
  if (trimmed.length === 0) {
    errorMessage.value = "Paste a GitHub token before saving.";
    return;
  }
  saving.value = true;
  errorMessage.value = null;
  try {
    const snapshot = await patchGithubCredentials(props.repo, trimmed);
    emit("saved", snapshot);
    emit("update:open", false);
  } catch (err) {
    const te = err as ToggleError;
    errorMessage.value =
      te?.serverMessage ?? te?.message ?? "Failed to save token.";
  } finally {
    saving.value = false;
  }
}

function onClose(): void {
  if (saving.value) return;
  emit("update:open", false);
}
</script>

<template>
  <DanxDialog
    :model-value="open"
    title="Register / Rotate GitHub token"
    :persistent="saving"
    close-button="Cancel"
    confirm-button="Save token"
    :is-saving="saving"
    @update:model-value="emit('update:open', $event)"
    @confirm="onConfirm"
    @close="onClose"
  >
    <div class="space-y-4 text-sm" data-test="github-credentials-modal">
      <p class="text-gray-700 dark:text-gray-300">
        Paste a GitHub <strong>fine-grained</strong> personal access token
        with <code>Contents: Read and write</code> +
        <code>Metadata: Read-only</code> for this repo. The token is stored
        only in <code>&lt;repo&gt;/.danxbot/.env</code> on this host and
        never sent to a third party.
      </p>

      <label class="block">
        <span class="text-xs font-medium text-gray-700 dark:text-gray-300">
          Personal access token
        </span>
        <input
          v-model="token"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="ghp_… or github_pat_…"
          class="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 dark:text-gray-100 px-2 py-1.5 text-xs font-mono"
          data-test="github-credentials-token-input"
          :disabled="saving"
        />
      </label>

      <a
        href="https://github.com/settings/personal-access-tokens/new"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-block text-xs text-blue-600 dark:text-blue-400 hover:underline"
        data-test="github-credentials-pat-link"
      >
        Open GitHub fine-grained PAT creation page →
      </a>

      <div
        class="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3"
      >
        <p class="text-xs font-medium text-gray-700 dark:text-gray-300">
          Setup steps
        </p>
        <ol
          class="mt-2 list-decimal list-inside space-y-1 text-xs text-gray-700 dark:text-gray-300"
        >
          <li>Click the link above (opens in a new tab).</li>
          <li>
            Token name: <code>danxbot-{{ repo }}-&lt;host&gt;</code>.
          </li>
          <li>Expiration: 90 days (recommended).</li>
          <li>
            Repository access: <em>Only select repositories</em> → pick the
            repo this dashboard manages.
          </li>
          <li>
            Permissions → Repository permissions →
            <code>Contents: Read and write</code> +
            <code>Metadata: Read-only</code>.
          </li>
          <li>
            Click <strong>Generate token</strong>, copy the value, paste
            above.
          </li>
        </ol>
      </div>

      <p
        class="text-xs text-amber-700 dark:text-amber-300"
        data-test="github-credentials-restart-note"
      >
        After saving, restart the worker for the new token to take effect:
        <code>make launch-worker REPO={{ repo }}</code>. The container
        loads env at compose-up; live rotation requires restart.
      </p>

      <p
        v-if="errorMessage"
        class="rounded bg-red-50 dark:bg-red-900/30 px-3 py-2 text-xs text-red-700 dark:text-red-300"
        data-test="github-credentials-modal-error"
      >
        {{ errorMessage }}
      </p>
    </div>
  </DanxDialog>
</template>
