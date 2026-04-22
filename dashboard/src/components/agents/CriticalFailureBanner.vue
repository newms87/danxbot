<script setup lang="ts">
import { computed } from "vue";
import type { CriticalFailurePayload } from "../../types";

const props = defineProps<{
  flag: CriticalFailurePayload;
  repoName: string;
  busy?: boolean;
}>();

defineEmits<{
  /**
   * Raised when the operator clicks "Clear flag". Parent composable
   * calls the dashboard DELETE proxy and refreshes the snapshot; the
   * banner unmounts when `flag` becomes null on the next render.
   */
  clear: [repo: string];
}>();

const whenText = computed(() => {
  try {
    const ts = new Date(props.flag.timestamp);
    if (Number.isNaN(ts.getTime())) return props.flag.timestamp;
    return ts.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return props.flag.timestamp;
  }
});

const sourceLabel = computed(() => {
  switch (props.flag.source) {
    case "agent":
      return "agent-signaled";
    case "post-dispatch-check":
      return "post-dispatch check (card didn't move)";
    case "unparseable":
      return "flag file unparseable";
  }
  return props.flag.source;
});
</script>

<template>
  <div
    role="alert"
    class="mb-3 rounded-lg border border-red-500 bg-red-50 dark:bg-red-900/30 dark:border-red-500 px-4 py-3 text-sm text-red-900 dark:text-red-100"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 font-semibold">
          <span aria-hidden="true" class="text-lg leading-none">⛔</span>
          <span>Poller halted — critical failure</span>
          <span
            class="text-xs font-normal text-red-700 dark:text-red-300"
          >({{ sourceLabel }})</span>
        </div>
        <p class="mt-1 font-medium">{{ flag.reason }}</p>
        <p
          v-if="flag.detail"
          class="mt-2 text-xs whitespace-pre-wrap text-red-800 dark:text-red-200"
        >{{ flag.detail }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-red-700 dark:text-red-300">
          <span>dispatch <code class="font-mono">{{ flag.dispatchId }}</code></span>
          <span>·</span>
          <span>{{ whenText }}</span>
          <a
            v-if="flag.cardUrl"
            :href="flag.cardUrl"
            target="_blank"
            rel="noopener"
            class="underline hover:text-red-900 dark:hover:text-red-100"
          >view card ↗</a>
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 rounded-md border border-red-600 dark:border-red-400 bg-white dark:bg-red-950 px-3 py-1 text-xs font-semibold text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="busy"
        @click="$emit('clear', repoName)"
      >
        {{ busy ? "Clearing…" : "Clear flag" }}
      </button>
    </div>
  </div>
</template>
