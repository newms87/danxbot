<script setup lang="ts">
/**
 * DX-558 — root-clone dirty / rebase-conflict banner.
 *
 * Mirrors `CriticalFailureBanner.vue`'s visual language so the two
 * banners stack cleanly on the same `RepoCard`. Variant colour:
 *
 *   - `dirty` (amber) — operator must clean up working tree.
 *   - `rebase-conflict` (red) — non-ff against `origin/main` that
 *     auto-rebase could not resolve; operator must fix in the root
 *     clone manually.
 *
 * The retry button proxies the `POST /api/sync-root/:repo` call —
 * useful after the operator has cleaned the tree to short-circuit
 * the cron's per-tick retry window.
 */

import { computed } from "vue";
import { DanxButton, DanxIcon } from "@thehammer/danx-ui";
import triangleExclamation from "danx-icon/src/fontawesome/solid/triangle-exclamation.svg?raw";
import circleExclamation from "danx-icon/src/fontawesome/solid/circle-exclamation.svg?raw";
import type { RepoRootSyncError } from "../../types";

const props = defineProps<{
  error: RepoRootSyncError;
  repoName: string;
  retrying?: boolean;
}>();

const emit = defineEmits<{
  retry: [repo: string];
}>();

const isRebaseConflict = computed(() => props.error.reason === "rebase-conflict");

const headline = computed(() =>
  isRebaseConflict.value
    ? `Repo root ${props.repoName} cannot sync with origin/main — rebase conflict`
    : `Repo root ${props.repoName} cannot sync with origin/main — working tree dirty (tracked changes / untracked files)`,
);

const sinceText = computed(() => formatTs(props.error.since));
const lastTriedText = computed(() => formatTs(props.error.lastTriedAt));

function formatTs(value: string): string {
  try {
    const ts = new Date(value);
    if (Number.isNaN(ts.getTime())) return value;
    return ts.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

const containerClass = computed(() =>
  isRebaseConflict.value
    ? "mb-3 rounded-lg border border-red-500 bg-red-50 dark:bg-red-900/30 dark:border-red-500 px-4 py-3 text-sm text-red-900 dark:text-red-100"
    : "mb-3 rounded-lg border border-amber-500 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-500 px-4 py-3 text-sm text-amber-900 dark:text-amber-100",
);

const detailClass = computed(() =>
  isRebaseConflict.value
    ? "mt-2 text-xs whitespace-pre-wrap text-red-800 dark:text-red-200"
    : "mt-2 text-xs whitespace-pre-wrap text-amber-800 dark:text-amber-200",
);

const metaClass = computed(() =>
  isRebaseConflict.value
    ? "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-red-700 dark:text-red-300"
    : "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-amber-700 dark:text-amber-300",
);

function onRetry(): void {
  emit("retry", props.repoName);
}
</script>

<template>
  <div role="alert" :class="containerClass" data-test="repo-root-dirty-banner">
    <div class="flex items-start justify-between gap-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 font-semibold">
          <DanxIcon
            class="h-5 w-5 shrink-0"
            :icon="isRebaseConflict ? circleExclamation : triangleExclamation"
            aria-hidden="true"
          />
          <span>{{ headline }}</span>
        </div>
        <p :class="detailClass">{{ error.detail }}</p>
        <div :class="metaClass">
          <span>since {{ sinceText }}</span>
          <span>·</span>
          <span>last tried {{ lastTriedText }}</span>
        </div>
      </div>
      <DanxButton
        size="sm"
        :variant="isRebaseConflict ? 'danger' : 'warning'"
        :disabled="retrying"
        data-test="repo-root-dirty-retry"
        @click="onRetry"
      >
        {{ retrying ? "Retrying…" : "Retry now" }}
      </DanxButton>
    </div>
  </div>
</template>
