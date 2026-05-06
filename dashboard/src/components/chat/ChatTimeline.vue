<script setup lang="ts">
import { computed } from "vue";
import type { ChatBlock } from "./chatFixtures";
import ChatUserBlock from "./ChatUserBlock.vue";
import ChatAssistantText from "./ChatAssistantText.vue";
import ChatThinking from "./ChatThinking.vue";
import ChatToolUse from "./ChatToolUse.vue";

interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  toolUseId: string;
  result: string;
}

type Pair =
  | { kind: "user"; text: string; ts?: number; key: string }
  | { kind: "assistant_text"; text: string; key: string }
  | { kind: "thinking"; text: string; key: string }
  | { kind: "tool"; block: ToolUseBlock; result: ToolResultBlock | null; key: string };

const props = defineProps<{
  blocks: ChatBlock[];
  streaming: boolean;
}>();

const pairs = computed<Pair[]>(() => {
  const out: Pair[] = [];
  const blocks = props.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "tool_use") {
      const next = blocks[i + 1];
      if (next && next.type === "tool_result" && next.toolUseId === b.id) {
        out.push({ kind: "tool", block: b, result: next, key: `tool-${b.id}` });
        i += 1;
      } else {
        out.push({ kind: "tool", block: b, result: null, key: `tool-${b.id}` });
      }
    } else if (b.type === "tool_result") {
      // Orphan tool_result (no preceding tool_use). Skip — UI never renders bare results.
      continue;
    } else if (b.type === "user") {
      out.push({ kind: "user", text: b.text, ts: b.ts, key: `u-${i}` });
    } else if (b.type === "assistant_text") {
      out.push({ kind: "assistant_text", text: b.text, key: `a-${i}` });
    } else if (b.type === "thinking") {
      out.push({ kind: "thinking", text: b.text, key: `t-${i}` });
    }
  }
  return out;
});
</script>

<template>
  <div class="timeline">
    <template v-for="p in pairs" :key="p.key">
      <ChatUserBlock v-if="p.kind === 'user'" :text="p.text" :ts="p.ts" />
      <ChatAssistantText v-else-if="p.kind === 'assistant_text'" :text="p.text" />
      <ChatThinking v-else-if="p.kind === 'thinking'" :text="p.text" />
      <ChatToolUse v-else-if="p.kind === 'tool'" :block="p.block" :result="p.result" />
    </template>
    <div v-if="streaming" class="streaming">
      <span class="label">danxbot is working</span>
      <span class="dots">
        <span class="dot dot-0" />
        <span class="dot dot-1" />
        <span class="dot dot-2" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
}
.streaming {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  color: #94a3b8;
}
.label {
  font-size: 10px;
  color: #a5b4fc;
}
.dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  margin-left: 4px;
}
.dot {
  width: 4px;
  height: 4px;
  border-radius: 9999px;
  background: #a5b4fc;
  animation: chat-pulse 1.2s ease-in-out infinite;
}
.dot-0 { animation-delay: 0s; }
.dot-1 { animation-delay: 0.15s; }
.dot-2 { animation-delay: 0.3s; }
@keyframes chat-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
  40% { opacity: 1; transform: scale(1); }
}
</style>
