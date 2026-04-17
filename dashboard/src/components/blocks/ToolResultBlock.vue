<script setup lang="ts">
import { ref } from "vue";
import type { ToolResultBlock } from "../../types";

const props = defineProps<{ block: ToolResultBlock }>();

const expanded = ref(false);
const LONG_THRESHOLD = 500;
const isLong = props.block.content.length > LONG_THRESHOLD;
</script>

<template>
  <div
    class="rounded-md px-3 py-2 my-2 ml-4 text-xs border"
    :class="block.isError
      ? 'bg-red-500/5 border-red-500/30 text-red-200'
      : 'bg-emerald-500/5 border-emerald-500/25 text-emerald-200'"
  >
    <div class="font-mono text-[11px] mb-1 flex items-center justify-between">
      <span class="font-semibold">{{ block.isError ? "TOOL ERROR" : "TOOL RESULT" }}</span>
      <span class="text-[10.5px] opacity-70">{{ block.toolUseId }}</span>
    </div>
    <pre
      class="font-mono text-[11.5px] whitespace-pre-wrap overflow-hidden m-0"
      :class="expanded || !isLong ? '' : 'max-h-48'"
    >{{ block.content }}</pre>
    <button
      v-if="isLong"
      class="mt-2 text-[10.5px] opacity-80 hover:opacity-100 underline"
      @click="expanded = !expanded"
    >
      {{ expanded ? "Collapse" : "Expand full output" }}
    </button>
  </div>
</template>
