<script setup lang="ts">
import { fmtChatTime } from "./chatFixtures";

defineProps<{ text: string; ts?: number }>();
</script>

<template>
  <div class="user-block">
    <div class="bubble">{{ text }}</div>
    <div v-if="ts" class="meta">you · {{ fmtChatTime(ts) }}</div>
  </div>
</template>

<style scoped>
.user-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-bottom: 12px;
}
.bubble {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 10px 10px 2px 10px;
  background: rgb(99 102 241 / 0.18);
  color: #e0e7ff;
  border: 1px solid rgb(99 102 241 / 0.3);
  font-size: 13px;
  line-height: 1.5;
  text-wrap: pretty;
  white-space: pre-wrap;
}
.meta {
  font-size: 10px;
  color: #475569;
  margin-top: 3px;
}
</style>
