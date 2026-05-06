<script setup lang="ts">
import { computed } from "vue";
import type { ChatSession } from "./chatFixtures";
import TokenMeter from "./TokenMeter.vue";

const props = defineProps<{
  session: ChatSession;
  scope: string;
  streaming: boolean;
}>();

const emit = defineEmits<{ stop: [] }>();

const isLive = computed(() => props.session.status === "running");
const dispatchShort = computed(() =>
  props.session.dispatchId ? props.session.dispatchId.slice(0, 8) : null,
);
</script>

<template>
  <div class="context-bar">
    <span class="badge" :class="{ live: isLive, idle: !isLive }">
      <span class="dot" :class="{ blink: isLive }" />
      {{ isLive ? "Live · resumable" : "Resumable" }}
    </span>
    <span
      v-if="dispatchShort"
      class="dispatch"
      :title="`Dispatch ${session.dispatchId}`"
    >↳ dispatch {{ dispatchShort }}</span>
    <span v-if="scope" class="scope">{{ scope }}</span>
    <span class="right">
      <span class="counters">
        {{ session.turns }} turns · {{ session.toolCalls }} tools<template v-if="session.subagentCount"> · {{ session.subagentCount }} sub-agents</template>
      </span>
      <TokenMeter :session="session" />
      <button
        v-if="streaming"
        type="button"
        class="stop"
        title="Interrupt the agent"
        @click="emit('stop')"
      >
        <span class="square" />
        Stop
      </button>
    </span>
  </div>
</template>

<style scoped>
.context-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid #1e293b;
  background: rgb(15 23 42 / 0.4);
  font-size: 11px;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-weight: 600;
}
.badge.live {
  background: rgb(245 158 11 / 0.18);
  color: #fcd34d;
}
.badge.idle {
  background: rgb(16 185 129 / 0.15);
  color: #6ee7b7;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #10b981;
}
.badge.live .dot {
  background: #f59e0b;
}
.dot.blink {
  animation: chat-blink 1.4s ease-in-out infinite;
}
.dispatch {
  font-family: ui-monospace, monospace;
  color: #94a3b8;
}
.scope {
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(99 102 241 / 0.12);
  color: #a5b4fc;
  font-weight: 500;
}
.right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.counters {
  color: #64748b;
}
.stop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 9999px;
  background: rgb(239 68 68 / 0.15);
  color: #fca5a5;
  border: 1px solid rgb(239 68 68 / 0.35);
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.square {
  width: 8px;
  height: 8px;
  background: currentColor;
  border-radius: 1.5px;
}
@keyframes chat-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
