<script setup lang="ts">
import { computed } from "vue";
import type { JsonlBlock } from "../types";
import UserBlock from "./blocks/UserBlock.vue";
import AssistantTextBlock from "./blocks/AssistantTextBlock.vue";
import ThinkingBlock from "./blocks/ThinkingBlock.vue";
import ToolUseBlock from "./blocks/ToolUseBlock.vue";
import ToolResultBlock from "./blocks/ToolResultBlock.vue";
import SystemBlock from "./blocks/SystemBlock.vue";
import UsageLine from "./blocks/UsageLine.vue";

const props = defineProps<{ blocks: JsonlBlock[] }>();

type TurnItem =
  | { kind: "turn"; turnNumber: number; entries: JsonlBlock[] }
  | { kind: "single"; entry: JsonlBlock };

// Group consecutive assistant-related entries (assistant_text + the
// trailing thinking/tool_use/tool_result/usage entries that belong to
// the same model turn) under one visual wrapper. user/system entries
// break a turn. The turn opens at the first assistant_text; preceding
// thinking (rare in current JSONL but possible) folds into the upcoming
// turn so the "ASSISTANT · turn N" label still owns it.
const items = computed<TurnItem[]>(() => {
  const out: TurnItem[] = [];
  let turn = 0;
  let buffer: JsonlBlock[] | null = null;
  const flush = (): void => {
    if (buffer && buffer.length > 0) {
      turn += 1;
      out.push({ kind: "turn", turnNumber: turn, entries: buffer });
    }
    buffer = null;
  };
  for (const block of props.blocks) {
    if (
      block.type === "assistant_text" ||
      block.type === "thinking" ||
      block.type === "tool_use" ||
      block.type === "tool_result" ||
      block.type === "usage"
    ) {
      if (!buffer) buffer = [];
      buffer.push(block);
    } else {
      flush();
      out.push({ kind: "single", entry: block });
    }
  }
  flush();
  return out;
});

// Stable, content-derived keys — index-independent so stream insertion
// at the head of a turn doesn't re-mount every following block (which
// would drop the ToolUseBlock's local `expanded` state).
function keyFor(block: JsonlBlock): string {
  if (block.type === "tool_use") return `tool_use-${block.id}`;
  if (block.type === "tool_result") return `tool_result-${block.toolUseId}`;
  return `${block.type}-${block.timestampMs}`;
}
</script>

<template>
  <div>
    <template v-for="(item, i) in items" :key="`item-${i}`">
      <template v-if="item.kind === 'single'">
        <UserBlock v-if="item.entry.type === 'user'" :block="item.entry" />
        <SystemBlock v-else-if="item.entry.type === 'system'" :block="item.entry" />
      </template>
      <div
        v-else
        data-test="assistant-turn"
        class="border-l-2 border-violet-400/70 pl-4 mb-4"
      >
        <div
          data-test="assistant-turn-label"
          class="text-[11px] font-semibold uppercase tracking-wider text-violet-300 mb-1"
        >
          Assistant · turn {{ item.turnNumber }}
        </div>
        <template v-for="entry in item.entries" :key="keyFor(entry)">
          <AssistantTextBlock v-if="entry.type === 'assistant_text'" :block="entry" />
          <ThinkingBlock v-else-if="entry.type === 'thinking'" :block="entry" />
          <ToolUseBlock v-else-if="entry.type === 'tool_use'" :block="entry" />
          <ToolResultBlock v-else-if="entry.type === 'tool_result'" :block="entry" />
          <UsageLine v-else-if="entry.type === 'usage'" :block="entry" />
        </template>
      </div>
    </template>
  </div>
</template>
