<script setup lang="ts">
import { CodeViewer, DanxChip } from "danx-ui";
import { ref } from "vue";
import type { ParsedHeartbeat } from "../../types";

defineProps<{ entry: ParsedHeartbeat }>();

const showActivity = ref(false);
</script>

<template>
  <div
    class="rounded-lg border px-3 py-2"
    :style="{ borderColor: entry.color + '40', backgroundColor: entry.color + '08' }"
  >
    <div class="flex items-center gap-2 text-xs">
      <DanxChip
        size="xxs"
        :label="'Heartbeat'"
        :style="{ backgroundColor: entry.color + '20', color: entry.color }"
      />
      <span class="text-gray-700 dark:text-gray-300">{{ entry.text }}</span>
    </div>
    <div v-if="entry.activitySummary" class="mt-1">
      <button
        class="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400"
        @click="showActivity = !showActivity"
      >
        <span>{{ showActivity ? '\u25BC' : '\u25B6' }}</span> Activity
      </button>
      <CodeViewer
        v-if="showActivity"
        :model-value="entry.activitySummary"
        format="text"
        :hide-footer="true"
        theme="dark"
        class="mt-1"
      />
    </div>
  </div>
</template>
