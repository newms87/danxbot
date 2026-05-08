<script setup lang="ts">
import { computed } from "vue";
import type { SystemError } from "../types";

const props = defineProps<{
  errors: SystemError[];
}>();

defineEmits<{
  dismiss: [id: string];
}>();

/**
 * Highest-severity color band for the banner. `error` from any source
 * promotes the whole banner to red; otherwise warn-yellow.
 */
const palette = computed(() =>
  props.errors.some((e) => e.severity === "error")
    ? {
        wrap: "border-red-500 bg-red-50 dark:bg-red-900/30 dark:border-red-500 text-red-900 dark:text-red-100",
        sub: "text-red-700 dark:text-red-300",
        chip: "bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-200",
        button:
          "border-red-600 dark:border-red-400 bg-white dark:bg-red-950 text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900",
        icon: "⛔",
        label: "System errors",
      }
    : {
        wrap: "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-500 text-yellow-900 dark:text-yellow-100",
        sub: "text-yellow-700 dark:text-yellow-300",
        chip: "bg-yellow-100 dark:bg-yellow-950 text-yellow-800 dark:text-yellow-200",
        button:
          "border-yellow-600 dark:border-yellow-400 bg-white dark:bg-yellow-950 text-yellow-700 dark:text-yellow-200 hover:bg-yellow-100 dark:hover:bg-yellow-900",
        icon: "⚠️",
        label: "System warnings",
      },
);

function whenText(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}
</script>

<template>
  <div
    v-if="errors.length > 0"
    role="alert"
    :class="['mb-3 rounded-lg border px-4 py-3 text-sm', palette.wrap]"
  >
    <div class="flex items-center gap-2 font-semibold">
      <span aria-hidden="true" class="text-lg leading-none">{{ palette.icon }}</span>
      <span>{{ palette.label }}</span>
      <span :class="['ml-1 rounded-full px-2 py-0.5 text-xs font-normal', palette.chip]">
        {{ errors.length }}
      </span>
    </div>
    <ul class="mt-2 space-y-1.5">
      <li
        v-for="err in errors"
        :key="err.id"
        class="flex items-start justify-between gap-3"
      >
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" :class="palette.sub">
            <span :class="['rounded-full px-2 py-0.5 font-mono', palette.chip]">{{ err.source }}</span>
            <span :class="['rounded-full px-2 py-0.5', palette.chip]">{{ err.repo }}</span>
            <span :class="['rounded-full px-2 py-0.5', palette.chip]">{{ err.severity }}</span>
            <span>{{ whenText(err.timestamp) }}</span>
          </div>
          <p class="mt-0.5 break-words">{{ err.message }}</p>
        </div>
        <button
          type="button"
          :class="['shrink-0 rounded-md border px-2 py-0.5 text-xs', palette.button]"
          aria-label="Dismiss"
          @click="$emit('dismiss', err.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>
