<script setup lang="ts">
import { DanxTooltip } from "@thehammer/danx-ui";
import type { Feature } from "../../types";

const props = defineProps<{
  feature: Feature;
  label: string;
  // Three-valued override — `null` means "defer to env default".
  enabled: boolean | null;
  // Env default used when `enabled === null` so the pill can show the
  // effective state alongside "Default".
  envDefault: boolean;
  subline?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  change: [feature: Feature, enabled: boolean | null];
}>();

function effectiveEnabled(): boolean {
  return props.enabled === null ? props.envDefault : props.enabled;
}

function next(): boolean | null {
  // Three-state toggle cycle: if currently an explicit override, flip it;
  // if null (env default), produce an explicit override opposite to the
  // env default so the click is visible.
  if (props.enabled === true) return false;
  if (props.enabled === false) return true;
  return !props.envDefault;
}

function onToggle(): void {
  if (props.busy) return;
  emit("change", props.feature, next());
}

function onResetToDefault(event: Event): void {
  event.stopPropagation();
  if (props.busy) return;
  emit("change", props.feature, null);
}
</script>

<template>
  <div
    class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 bg-white dark:bg-gray-900"
    :class="{ 'opacity-60': busy }"
  >
    <div class="flex items-center justify-between mb-1">
      <span class="text-sm font-medium text-gray-900 dark:text-white">
        {{ label }}
      </span>
      <button
        type="button"
        role="switch"
        :aria-checked="effectiveEnabled()"
        :aria-label="`Toggle ${label}`"
        :disabled="busy"
        class="relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none disabled:cursor-not-allowed"
        :class="effectiveEnabled() ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'"
        @click="onToggle"
      >
        <span
          class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
          :class="effectiveEnabled() ? 'translate-x-5' : 'translate-x-0.5'"
        />
      </button>
    </div>
    <div class="flex items-center justify-between text-xs">
      <span
        class="font-semibold"
        :class="effectiveEnabled() ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
      >
        {{ effectiveEnabled() ? "Enabled" : "Disabled" }}
        <DanxTooltip
          v-if="enabled === null"
          tooltip="Deferring to env default"
        >
          <template #trigger>
            <span class="ml-1 text-gray-400 dark:text-gray-500 font-normal">
              (default)
            </span>
          </template>
        </DanxTooltip>
        <DanxTooltip
          v-else
          tooltip="Reset to env default"
        >
          <template #trigger>
            <button
              type="button"
              class="ml-1 text-gray-400 dark:text-gray-500 font-normal underline hover:text-gray-600 dark:hover:text-gray-300"
              :disabled="busy"
              @click="onResetToDefault"
            >
              reset
            </button>
          </template>
        </DanxTooltip>
      </span>
      <span v-if="subline" class="text-gray-500 dark:text-gray-400">{{ subline }}</span>
    </div>
  </div>
</template>
