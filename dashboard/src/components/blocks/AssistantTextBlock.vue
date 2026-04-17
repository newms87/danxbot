<script setup lang="ts">
import type { AssistantTextBlock } from "../../types";

defineProps<{ block: AssistantTextBlock }>();
</script>

<template>
  <div class="border-l-2 border-violet-400/70 pl-4 mb-4">
    <div class="text-[11px] font-semibold uppercase tracking-wider text-violet-300 mb-1">Assistant</div>
    <div class="text-slate-100 whitespace-pre-wrap leading-relaxed">{{ block.text }}</div>
  </div>
</template>
