<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import AgentChat from "./AgentChat.vue";

defineProps<{ repo: string | null }>();
const emit = defineEmits<{ close: [] }>();

const closeButtonRef = ref<HTMLButtonElement | null>(null);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  closeButtonRef.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="scrim" aria-hidden="true" @click="emit('close')" />
  <aside class="overlay" role="dialog" aria-modal="true" aria-label="Chat with danxbot">
    <div class="header">
      <div class="header-left">
        <span class="title">Chat with danxbot</span>
        <span v-if="repo" class="repo-chip">{{ repo }} board</span>
      </div>
      <button
        ref="closeButtonRef"
        type="button"
        class="close"
        aria-label="Close chat"
        @click="emit('close')"
      >✕</button>
    </div>
    <div class="body">
      <AgentChat mode="board" :repo="repo" />
    </div>
  </aside>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgb(2 6 23 / 0.7);
  z-index: 40;
  animation: chat-overlay-fade 150ms ease-out;
}
.overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(640px, 100vw);
  background: #020617;
  border-left: 1px solid #1e293b;
  box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
  z-index: 50;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: chat-overlay-slide 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #1e293b;
  background: rgb(15 23 42 / 0.7);
}
.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}
.repo-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(99 102 241 / 0.15);
  color: #a5b4fc;
  font-weight: 500;
}
.close {
  background: none;
  border: 0;
  color: #94a3b8;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 4px;
  font-family: inherit;
}
.body {
  flex: 1;
  overflow: hidden;
}
@keyframes chat-overlay-slide {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
@keyframes chat-overlay-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
