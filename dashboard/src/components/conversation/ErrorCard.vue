<script setup lang="ts">
import { CodeViewer, DanxChip } from "danx-ui";
import { ref } from "vue";
import type { ParsedError } from "../../types";
import { formatMs } from "../../utils/format";

defineProps<{ entry: ParsedError }>();

const showStderr = ref(false);
</script>

<template>
  <div class="rounded-lg border border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 px-3 py-2">
    <div class="flex items-center gap-2 text-xs mb-1">
      <DanxChip type="danger" size="xs" label="Error" />
      <span class="ml-auto text-gray-400 dark:text-gray-600 font-mono text-[10px]">{{ formatMs(entry.deltaMs) }}</span>
    </div>
    <div class="text-xs text-red-700 dark:text-red-300 font-mono">{{ entry.message }}</div>
    <div v-if="entry.stderr" class="mt-1">
      <button
        class="flex items-center gap-1 text-[10px] text-red-400 dark:text-red-500 hover:text-red-600 dark:hover:text-red-400"
        @click="showStderr = !showStderr"
      >
        <span>{{ showStderr ? '\u25BC' : '\u25B6' }}</span> stderr
      </button>
      <CodeViewer
        v-if="showStderr"
        :model-value="entry.stderr"
        format="text"
        :hide-footer="true"
        theme="dark"
        class="mt-1"
      />
    </div>
  </div>
</template>
