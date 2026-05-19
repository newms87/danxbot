<script setup lang="ts">
import { nextTick, ref } from "vue";
import { DanxButton } from "@thehammer/danx-ui";

const props = defineProps<{
  disabled: boolean;
  placeholder?: string;
}>();

const emit = defineEmits<{
  send: [text: string];
}>();

const text = ref("");
const taRef = ref<HTMLTextAreaElement | null>(null);

function autosize(): void {
  const el = taRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(160, el.scrollHeight)}px`;
}

function onInput(e: Event): void {
  text.value = (e.target as HTMLTextAreaElement).value;
  autosize();
}

function submit(): void {
  const trimmed = text.value.trim();
  if (!trimmed || props.disabled) return;
  emit("send", trimmed);
  text.value = "";
  void nextTick(autosize);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="composer">
    <div class="input-row">
      <textarea
        ref="taRef"
        :value="text"
        :placeholder="placeholder ?? 'Reply to danxbot…'"
        rows="1"
        @input="onInput"
        @keydown="onKeydown"
      />
      <DanxButton
        variant=""
        size="sm"
        class="send"
        :disabled="!text.trim() || disabled"
        @click="submit"
      >Send ↵</DanxButton>
    </div>
    <div class="footer">
      <span>↵ to send · ⇧↵ for newline</span>
      <span>Resumes the live Claude Code session — see all tool calls &amp; thinking</span>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border-top: 1px solid #1e293b;
  padding: 10px 14px;
  background: rgb(2 6 23 / 0.6);
}
.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-radius: 8px;
  border: 1px solid #334155;
  background: rgb(15 23 42 / 0.8);
}
textarea {
  flex: 1;
  resize: none;
  outline: none;
  border: 0;
  background: transparent;
  color: #e2e8f0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  max-height: 160px;
  padding: 5px 0;
}
.send {
  padding: 6px 12px;
  border-radius: 6px;
  border: 0;
  background: #4f46e5;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.send:disabled {
  background: rgb(51 65 85 / 0.6);
  color: #64748b;
  cursor: not-allowed;
}
.footer {
  margin-top: 4px;
  font-size: 10px;
  color: #475569;
  display: flex;
  justify-content: space-between;
}
</style>
