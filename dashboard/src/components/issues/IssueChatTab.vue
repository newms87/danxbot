<script setup lang="ts">
/**
 * Per-card Chat tab body (DX-352 Phase 4).
 *
 * Mounts a `useIssueChat(repo, issueId)` composable + the
 * `IssueChatFilters` toggle row + a `ChatTimeline` + a `ChatComposer`.
 * Replaces the legacy `<AgentChat mode="issue">` wiring in
 * `IssueDetailView.vue` — that path required a prior dispatch row
 * (DX-84 board-chat semantics) and could not start a fresh chat from
 * the drawer. The DX-351 `POST /api/chat` endpoint creates the
 * session on the first user message, which is what this tab assumes.
 */
import { computed, nextTick, ref, toRef, watch } from "vue";
import type { Issue } from "../../types";
import type { ChatBlock } from "../chat/chatTypes";
import ChatTimeline from "../chat/ChatTimeline.vue";
import ChatComposer from "../chat/ChatComposer.vue";
import IssueChatFilters, { readInitialFilters } from "./IssueChatFilters.vue";
import { useIssueChat } from "../../composables/useIssueChat";

const props = defineProps<{
  issue: Issue;
  repo: string;
}>();

// `useIssueChat` accepts Refs so the composable can re-attach when the
// drawer flips between cards without remounting the SFC.
const chat = useIssueChat(toRef(props, "repo"), toRef(() => props.issue.id));

const initial = readInitialFilters();
const hideBash = ref<boolean>(initial.hideBash);
const hideThinking = ref<boolean>(initial.hideThinking);

const scrollRef = ref<HTMLDivElement | null>(null);

/**
 * Filtered timeline:
 *   - hideBash = true → drop every `Bash` tool_use AND its matching
 *     tool_result so the timeline doesn't render orphans.
 *   - hideThinking = true → drop every `thinking` block.
 *
 * Two-pass: build the `bashIds` set FIRST so a tool_result whose
 * matching tool_use appears later in the array (out-of-order JSONL
 * batch — uncommon but possible across a watcher boundary) still
 * filters cleanly.
 */
const visibleBlocks = computed<ChatBlock[]>(() => {
  let out: ChatBlock[] = chat.blocks.value;
  if (hideBash.value) {
    const bashIds = new Set<string>();
    for (const b of out) {
      if (b.type === "tool_use" && b.name === "Bash") bashIds.add(b.id);
    }
    out = out.filter((b) => {
      if (b.type === "tool_use" && b.name === "Bash") return false;
      if (b.type === "tool_result" && bashIds.has(b.toolUseId)) return false;
      return true;
    });
  }
  if (hideThinking.value) {
    out = out.filter((b) => b.type !== "thinking");
  }
  return out;
});

// Auto-scroll to the bottom when blocks arrive or filters change.
watch(
  [() => chat.blocks.value.length, hideBash, hideThinking, chat.loading],
  () => {
    void nextTick(() => {
      const el = scrollRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

async function onSend(text: string): Promise<void> {
  await chat.send(text);
}
</script>

<template>
  <div class="issue-chat-tab" data-test="issue-chat-tab">
    <IssueChatFilters
      v-model:hide-bash="hideBash"
      v-model:hide-thinking="hideThinking"
    />
    <div ref="scrollRef" class="scroll" data-test="chat-scroll">
      <ChatTimeline :blocks="visibleBlocks" :streaming="chat.loading.value" />
      <div
        v-if="visibleBlocks.length === 0 && !chat.loading.value"
        class="empty"
        data-test="chat-empty"
      >
        <div class="bubble-icon">💬</div>
        <div class="empty-title">Chat with danxbot about {{ issue.id }}</div>
        <div class="empty-text">
          Ask a question or request a change. The agent reads this card,
          can reply directly, or edit the YAML — saves stream back live
          to this drawer.
        </div>
      </div>
    </div>
    <div v-if="chat.error.value" class="error" data-test="chat-error">
      {{ chat.error.value }}
    </div>
    <!-- chat.* fields are Refs on a returned object, NOT top-level
         setup-bindings, so Vue's template auto-unwrap doesn't apply
         here — the explicit `.value` reads are required, not stylistic.
         A destructure into top-level `const { loading } = useIssueChat()`
         would discard reactivity (refs become plain refs without the
         enclosing reactive), so we keep the object form + `.value`. -->
    <ChatComposer
      :disabled="chat.loading.value"
      :placeholder="`Ask danxbot about ${issue.id}…`"
      @send="onSend"
    />
  </div>
</template>

<style scoped>
.issue-chat-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  background: rgb(2 6 23 / 0.4);
  min-height: 0;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
  min-height: 200px;
}
.bubble-icon {
  width: 56px;
  height: 56px;
  border-radius: 9999px;
  background: rgb(99 102 241 / 0.12);
  border: 1px solid rgb(99 102 241 / 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  margin-bottom: 16px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 6px;
}
.empty-text {
  font-size: 12px;
  color: #94a3b8;
  max-width: 360px;
  line-height: 1.55;
  text-wrap: pretty;
}
.error {
  font-size: 12px;
  color: #fca5a5;
  padding: 8px 16px;
  border-top: 1px solid rgb(239 68 68 / 0.25);
}
</style>
