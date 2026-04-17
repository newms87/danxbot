<script setup lang="ts">
import { computed } from "vue";
import type { ToolUseBlock } from "../../types";
import SessionTimeline from "../SessionTimeline.vue";

const props = defineProps<{ block: ToolUseBlock }>();

const inputJson = computed(() =>
  JSON.stringify(props.block.input, null, 2),
);
</script>

<template>
  <div class="bg-indigo-500/5 border border-indigo-500/20 rounded-md px-3 py-2 my-2 ml-4 text-xs">
    <div class="flex justify-between text-indigo-200 font-mono mb-1">
      <span class="font-semibold">{{ block.name }}</span>
      <span class="text-indigo-400 text-[11px]">{{ block.id }}</span>
    </div>
    <pre class="text-indigo-300 font-mono text-[11.5px] overflow-x-auto whitespace-pre m-0">{{ inputJson }}</pre>

    <div v-if="block.subagent" class="mt-2 ml-3 border-l-[3px] border-pink-400 pl-3 py-2 bg-pink-500/5 rounded-r">
      <div class="text-[11px] font-bold uppercase tracking-wider text-pink-300 mb-2">
        {{ block.subagent.agentType }} sub-agent
        <span class="text-pink-400/60 font-normal ml-2">— {{ block.subagent.description }}</span>
      </div>
      <SessionTimeline :blocks="block.subagent.blocks" />
    </div>
  </div>
</template>
