<script setup lang="ts">
import { computed } from "vue";
import type { ChatSession } from "./chatTypes";
import { relativeTime } from "../../utils/relativeTime";

const props = defineProps<{
  sessions: ChatSession[];
  repo: string | null;
  loading?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  pick: [session: ChatSession];
  "start-new": [];
}>();

const repoSessions = computed(() =>
  props.repo ? props.sessions.filter((s) => s.repo === props.repo) : props.sessions,
);
</script>

<template>
  <div class="picker">
    <div class="picker-header">
      <div class="label">Recent sessions<template v-if="repo"> · {{ repo }}</template></div>
      <button type="button" class="new-chat" @click="emit('start-new')">+ New chat</button>
    </div>
    <div v-if="loading" class="empty">Loading sessions…</div>
    <div v-else-if="error" class="empty error">{{ error }}</div>
    <div v-else-if="repoSessions.length === 0" class="empty">
      No board chats yet for this repo.
    </div>
    <div v-else class="list">
      <button
        v-for="s in repoSessions"
        :key="s.id"
        type="button"
        class="row"
        @click="emit('pick', s)"
      >
        <div class="title">{{ s.title }}</div>
        <div class="last-message">{{ s.lastMessage }}</div>
        <div class="meta">
          <span class="repo">{{ s.repo }}</span>
          <span>·</span>
          <span>{{ s.turns }} turns · {{ s.toolCalls }} tools</span>
          <span class="ts">{{ relativeTime(s.updatedAt ?? s.startedAt) }}</span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.new-chat {
  padding: 5px 10px;
  border-radius: 6px;
  border: 0;
  background: #4f46e5;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: #475569;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
.empty.error {
  color: #fca5a5;
  border-color: rgb(239 68 68 / 0.35);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 10px 12px;
  border-radius: 6px;
  text-align: left;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  cursor: pointer;
  font-family: inherit;
  gap: 4px;
}
.row:hover {
  border-color: #334155;
}
.title {
  font-size: 13px;
  font-weight: 500;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.last-message {
  font-size: 12px;
  color: #64748b;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: #475569;
  margin-top: 2px;
}
.repo {
  color: #94a3b8;
  text-transform: capitalize;
}
.ts {
  margin-left: auto;
}
</style>
