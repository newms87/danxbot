<script setup lang="ts">
import { ref } from "vue";
import { DanxButton, DanxDialog, useDialog } from "danx-ui";
import { resetAllData, type ResetAllDataResult } from "../api";

const { isOpen, open, close } = useDialog();

const saving = ref(false);
const result = ref<ResetAllDataResult | null>(null);
const errorMessage = ref<string | null>(null);

async function onConfirmReset(): Promise<void> {
  saving.value = true;
  errorMessage.value = null;
  try {
    result.value = await resetAllData();
    close();
  } catch (err) {
    errorMessage.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

function dismissResult(): void {
  result.value = null;
}
</script>

<template>
  <div class="max-w-3xl">
    <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">
      Settings
    </h2>

    <section
      class="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5"
      data-test="danger-zone"
    >
      <h3 class="text-base font-semibold text-red-800 dark:text-red-200">
        Danger zone
      </h3>
      <p class="mt-1 text-sm text-red-900 dark:text-red-200">
        Wipe operational data (dispatches, Slack threads, health checks).
        Users and API tokens are preserved — you stay logged in.
      </p>
      <div class="mt-4">
        <DanxButton
          type="danger"
          icon="trash"
          data-test="reset-data-open"
          @click="open"
        >
          Reset all data
        </DanxButton>
      </div>

      <div
        v-if="result"
        data-test="reset-data-success"
        class="mt-4 rounded border border-green-400 dark:border-green-700 bg-green-50 dark:bg-green-900/30 px-3 py-2 text-sm text-green-900 dark:text-green-100 flex items-start justify-between gap-3"
      >
        <div>
          <div class="font-medium">
            Reset complete — {{ result.rowsDeleted }} row(s) deleted.
          </div>
          <ul class="mt-1 text-xs list-disc list-inside">
            <li v-for="table in result.tablesCleared" :key="table">
              {{ table }}: {{ result.perTable[table] ?? 0 }}
            </li>
          </ul>
        </div>
        <button
          type="button"
          class="text-green-900 dark:text-green-100 hover:opacity-70"
          aria-label="Dismiss"
          @click="dismissResult"
        >
          ✕
        </button>
      </div>
    </section>

    <DanxDialog
      v-model="isOpen"
      title="Reset all data?"
      subtitle="This cannot be undone."
      :persistent="saving"
      close-button="Cancel"
      confirm-button="Reset everything"
      :is-saving="saving"
      @confirm="onConfirmReset"
      @close="close"
    >
      <div class="space-y-3 text-sm">
        <p>
          The following tables will be <strong>truncated</strong>:
        </p>
        <ul class="list-disc list-inside text-red-800 dark:text-red-300">
          <li><code>dispatches</code> — all job history</li>
          <li><code>threads</code> — Slack thread continuation state</li>
          <li><code>health_check</code></li>
        </ul>
        <p>
          These tables are preserved so login continues to work:
          <code>users</code>, <code>api_tokens</code>.
        </p>
        <p
          v-if="errorMessage"
          data-test="reset-data-error"
          class="rounded bg-red-100 dark:bg-red-900/40 px-3 py-2 text-red-900 dark:text-red-100"
        >
          {{ errorMessage }}
        </p>
      </div>
    </DanxDialog>
  </div>
</template>
