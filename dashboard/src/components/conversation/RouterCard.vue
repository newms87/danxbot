<script setup lang="ts">
import { ref } from "vue";
import { CodeViewer, DanxChip } from "danx-ui";
import type { ParsedRouter } from "../../types";
import { formatTokens } from "../../utils/format";

defineProps<{ entry: ParsedRouter }>();

const showRaw = ref(false);
</script>

<template>
  <div class="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/30 dark:bg-amber-950/10 px-3 py-2">
    <!-- Header row: badges + cost -->
    <div class="flex items-center gap-2 text-xs mb-2">
      <DanxChip type="warning" size="xs" label="Router" />
      <DanxChip
        :type="entry.needsAgent ? 'info' : 'success'"
        size="xxs"
        :label="entry.needsAgent ? 'Agent needed' : 'Router only'"
      />
      <DanxChip type="muted" size="xxs" :label="entry.complexity" />
      <span
        v-if="entry.model"
        class="font-mono text-[10px] text-gray-500 dark:text-gray-400"
      >
        {{ entry.model }}
      </span>
      <span
        v-if="entry.costUsd > 0"
        class="ml-auto font-semibold text-[11px] text-amber-700 dark:text-amber-300"
      >
        ${{ entry.costUsd.toFixed(4) }}
      </span>
    </div>

    <!-- Quick response -->
    <div v-if="entry.quickResponse" class="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap mb-1">
      {{ entry.quickResponse }}
    </div>

    <!-- Reason -->
    <div v-if="entry.reason" class="text-[10px] text-gray-400 dark:text-gray-500 italic mb-2">
      {{ entry.reason }}
    </div>

    <!-- Token usage breakdown -->
    <div v-if="entry.usage" class="flex items-center gap-3 text-[10px] text-gray-500 dark:text-gray-400 font-mono mb-1">
      <span>in: {{ formatTokens(entry.usage.inputTokens) }}</span>
      <span>out: {{ formatTokens(entry.usage.outputTokens) }}</span>
      <span v-if="entry.usage.cacheReadTokens > 0">cache-r: {{ formatTokens(entry.usage.cacheReadTokens) }}</span>
      <span v-if="entry.usage.cacheWriteTokens > 0">cache-w: {{ formatTokens(entry.usage.cacheWriteTokens) }}</span>
    </div>

    <!-- Raw JSON toggle -->
    <div v-if="entry.rawRequest || entry.rawResponse">
      <button
        class="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400 mb-1"
        @click="showRaw = !showRaw"
      >
        <span>{{ showRaw ? '\u25BC' : '\u25B6' }}</span> Raw API
      </button>
      <div v-if="showRaw" class="space-y-2">
        <CodeViewer
          v-if="entry.rawRequest"
          :model-value="entry.rawRequest"
          format="json"
          label="Request"
          collapsible
          default-collapsed
          :hide-footer="true"
          theme="dark"
        />
        <CodeViewer
          v-if="entry.rawResponse"
          :model-value="entry.rawResponse"
          format="json"
          label="Response"
          collapsible
          default-collapsed
          :hide-footer="true"
          theme="dark"
        />
      </div>
    </div>
  </div>
</template>
