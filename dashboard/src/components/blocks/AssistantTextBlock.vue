<script setup lang="ts">
import type { AssistantTextBlock } from "../../types";

defineProps<{ block: AssistantTextBlock }>();
</script>

<template>
  <div
    data-test="assistant-text"
    class="text-slate-100 whitespace-pre-wrap leading-relaxed mb-2"
  >{{ block.text }}</div>
</template>
