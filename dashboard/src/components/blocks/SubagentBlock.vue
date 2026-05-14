<script setup lang="ts">
import { DanxIcon } from "@thehammer/danx-ui";
import chevronRight from "danx-icon/src/fontawesome/solid/chevron-right.svg?raw";
import type { SubagentTimeline } from "../../types";
import SessionTimeline from "../SessionTimeline.vue";

defineProps<{ subagent: SubagentTimeline }>();
</script>

<template>
  <div
    data-test="subagent-block"
    class="mt-2 ml-3 border-l-[3px] border-pink-400 pl-3 py-2 bg-pink-500/5 rounded-r"
  >
    <div
      class="text-[11px] font-bold uppercase tracking-wider text-pink-300 mb-2 flex items-center gap-1"
    >
      <DanxIcon :icon="chevronRight" class="w-3 h-3" />
      <span data-test="subagent-label">SUB-AGENT</span>
      <span class="text-pink-200 font-normal">· {{ subagent.agentType }}</span>
      <span v-if="subagent.description" class="text-pink-400/60 font-normal">
        — {{ subagent.description }}
      </span>
    </div>
    <SessionTimeline :blocks="subagent.blocks" />
  </div>
</template>
