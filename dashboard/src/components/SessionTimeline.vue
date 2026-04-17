<script setup lang="ts">
import type { JsonlBlock } from "../types";
import UserBlock from "./blocks/UserBlock.vue";
import AssistantTextBlock from "./blocks/AssistantTextBlock.vue";
import ThinkingBlock from "./blocks/ThinkingBlock.vue";
import ToolUseBlock from "./blocks/ToolUseBlock.vue";
import ToolResultBlock from "./blocks/ToolResultBlock.vue";
import SystemBlock from "./blocks/SystemBlock.vue";
import UsageLine from "./blocks/UsageLine.vue";

defineProps<{ blocks: JsonlBlock[] }>();

function keyFor(block: JsonlBlock, i: number): string {
  if (block.type === "tool_use" || block.type === "tool_result") {
    return `${block.type}-${
      block.type === "tool_use" ? block.id : block.toolUseId
    }-${i}`;
  }
  return `${block.type}-${block.timestampMs}-${i}`;
}
</script>

<template>
  <div>
    <template v-for="(block, i) in blocks" :key="keyFor(block, i)">
      <UserBlock v-if="block.type === 'user'" :block="block" />
      <AssistantTextBlock v-else-if="block.type === 'assistant_text'" :block="block" />
      <ThinkingBlock v-else-if="block.type === 'thinking'" :block="block" />
      <ToolUseBlock v-else-if="block.type === 'tool_use'" :block="block" />
      <ToolResultBlock v-else-if="block.type === 'tool_result'" :block="block" />
      <SystemBlock v-else-if="block.type === 'system'" :block="block" />
      <UsageLine v-else-if="block.type === 'usage'" :block="block" />
    </template>
  </div>
</template>
