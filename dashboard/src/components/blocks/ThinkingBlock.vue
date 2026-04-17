<script setup lang="ts">
import type { ThinkingBlock } from "../../types";

defineProps<{ block: ThinkingBlock }>();
</script>

<template>
  <div class="bg-slate-800/30 border border-dashed border-slate-700 rounded-md px-3 py-2 my-2 ml-4 text-slate-400 italic text-xs">
    <span class="not-italic text-amber-300 font-semibold text-[10.5px] tracking-wider mr-2">THINKING</span>
    <span class="whitespace-pre-wrap">{{ block.text }}</span>
  </div>
</template>
