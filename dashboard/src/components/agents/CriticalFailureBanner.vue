<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { CriticalFailurePayload } from "../../types";

/**
 * DX-322 — banner has two visual variants:
 *
 *   - `critical-failure` (red): `source !== "throttle"`. Operator
 *     action required; the "Clear flag" button is the unblock path.
 *   - `throttled` (amber): `source === "throttle"`. Self-clearing —
 *     the poller auto-unlinks the flag past `resume_at`. The
 *     "Clear flag" button stays available so the operator can
 *     short-circuit the wait if they want.
 *
 * The amber variant runs a 1s setInterval to update the remaining-
 * time countdown; both variants render the same when/dispatch/clear
 * affordances.
 */

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
    case "throttle":
      return "rate-limit throttle";
    case "unparseable":
      return "flag file unparseable";
  }
  return props.flag.source;
});

const isThrottle = computed(() => props.flag.source === "throttle");

// DX-322 — live countdown for the throttle variant. `now` ticks every
// 1s so the "Xh Ym Zs" remaining time visibly counts down without a
// page refresh. Non-throttle banners skip the timer entirely.
const now = ref(Date.now());
let countdownTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  if (isThrottle.value && props.flag.resume_at) {
    countdownTimer = setInterval(() => {
      now.value = Date.now();
    }, 1_000);
  }
});
onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});

const remainingText = computed(() => {
  if (!isThrottle.value || !props.flag.resume_at) return null;
  const resumeMs = Date.parse(props.flag.resume_at);
  if (Number.isNaN(resumeMs)) return null;
  const ms = Math.max(0, resumeMs - now.value);
  if (ms === 0) return "now";
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
});

const resumeAtText = computed(() => {
  if (!props.flag.resume_at) return null;
  try {
    const ts = new Date(props.flag.resume_at);
    if (Number.isNaN(ts.getTime())) return props.flag.resume_at;
    return ts.toLocaleString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return props.flag.resume_at;
  }
});

const containerClass = computed(() =>
  isThrottle.value
    ? "mb-3 rounded-lg border border-amber-500 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-500 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
    : "mb-3 rounded-lg border border-red-500 bg-red-50 dark:bg-red-900/30 dark:border-red-500 px-4 py-3 text-sm text-red-900 dark:text-red-100",
);

const detailMutedClass = computed(() =>
  isThrottle.value
    ? "mt-2 text-xs whitespace-pre-wrap text-amber-800 dark:text-amber-200"
    : "mt-2 text-xs whitespace-pre-wrap text-red-800 dark:text-red-200",
);

const metaClass = computed(() =>
  isThrottle.value
    ? "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-amber-700 dark:text-amber-300"
    : "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-red-700 dark:text-red-300",
);

const sourceLabelClass = computed(() =>
  isThrottle.value
    ? "text-xs font-normal text-amber-700 dark:text-amber-300"
    : "text-xs font-normal text-red-700 dark:text-red-300",
);

const linkHoverClass = computed(() =>
  isThrottle.value
    ? "underline hover:text-amber-900 dark:hover:text-amber-100"
    : "underline hover:text-red-900 dark:hover:text-red-100",
);

const clearButtonClass = computed(() =>
  isThrottle.value
    ? "shrink-0 rounded-md border border-amber-600 dark:border-amber-400 bg-white dark:bg-amber-950 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60"
    : "shrink-0 rounded-md border border-red-600 dark:border-red-400 bg-white dark:bg-red-950 px-3 py-1 text-xs font-semibold text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-60",
);
</script>

<template>
  <div role="alert" :class="containerClass">
    <div class="flex items-start justify-between gap-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 font-semibold">
          <span aria-hidden="true" class="text-lg leading-none">
            {{ isThrottle ? "⏳" : "⛔" }}
          </span>
          <span v-if="isThrottle">
            Throttled<span v-if="remainingText"> — resumes in {{ remainingText }}</span>
          </span>
          <span v-else>Poller halted — critical failure</span>
          <span :class="sourceLabelClass">({{ sourceLabel }})</span>
        </div>
        <p class="mt-1 font-medium">{{ flag.reason }}</p>
        <p v-if="flag.detail" :class="detailMutedClass">{{ flag.detail }}</p>
        <div :class="metaClass">
          <span>dispatch <code class="font-mono">{{ flag.dispatchId }}</code></span>
          <span>·</span>
          <span>{{ whenText }}</span>
          <template v-if="isThrottle && resumeAtText">
            <span>·</span>
            <span>resumes at {{ resumeAtText }}</span>
          </template>
          <a
            v-if="flag.cardUrl"
            :href="flag.cardUrl"
            target="_blank"
            rel="noopener"
            :class="linkHoverClass"
          >view card ↗</a>
        </div>
      </div>
      <button
        type="button"
        :class="clearButtonClass"
        :disabled="busy"
        @click="$emit('clear', repoName)"
      >
        {{ busy ? "Clearing…" : "Clear flag" }}
      </button>
    </div>
  </div>
</template>
