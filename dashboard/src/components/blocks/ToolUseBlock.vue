<script setup lang="ts">
import { computed, ref } from "vue";
import { DanxButton, DanxIcon } from "@thehammer/danx-ui";
import wrenchIcon from "danx-icon/src/fontawesome/solid/wrench.svg?raw";
import type { ToolUseBlock } from "../../types";
import SubagentBlock from "./SubagentBlock.vue";

const props = defineProps<{ block: ToolUseBlock }>();

const inputJson = computed(() => JSON.stringify(props.block.input, null, 2));

const LONG_THRESHOLD = 400;
const isLong = computed(() => inputJson.value.length > LONG_THRESHOLD);
const expanded = ref(false);
</script>

<template>
  <div class="bg-indigo-500/5 border border-indigo-500/20 rounded-md px-3 py-2 my-2 ml-4 text-xs">
    <div class="flex justify-between text-indigo-200 font-mono mb-1 items-center">
      <span class="font-semibold flex items-center gap-1.5">
        <DanxIcon :icon="wrenchIcon" class="w-3 h-3" />
        {{ block.name }}
      </span>
      <span class="text-indigo-400 text-[11px]">{{ block.id }}</span>
    </div>
    <pre
      class="text-indigo-300 font-mono text-[11.5px] overflow-x-auto whitespace-pre m-0"
      :class="expanded || !isLong ? '' : 'max-h-32 overflow-hidden'"
    >{{ inputJson }}</pre>
    <DanxButton
      v-if="isLong"
      data-test="tool-use-toggle"
      size="sm"
      type="text"
      class="mt-1 !text-[10.5px] !text-indigo-300 hover:!text-indigo-100"
      @click="expanded = !expanded"
    >{{ expanded ? "Show less" : "Show more" }}</DanxButton>

    <SubagentBlock v-if="block.subagent" :subagent="block.subagent" />
  </div>
</template>
