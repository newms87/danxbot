<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { IssueDetail } from "../../types";
import type { ChatBlock, ChatSession } from "./chatTypes";
import { fetchBoardSessions, fetchIssueSessions, useChat } from "../../composables/useChat";
import ChatTimeline from "./ChatTimeline.vue";
import ChatComposer from "./ChatComposer.vue";
import SessionContextBar from "./SessionContextBar.vue";
import BoardSessionPicker from "./BoardSessionPicker.vue";

type Mode = "issue" | "board";

const props = defineProps<{
  mode: Mode;
  issue?: IssueDetail | null;
  repo?: string | null;
}>();

const chat = useChat();

/** Sessions visible to the picker — populated by the per-mode `refreshSessions`. */
const sessions = ref<ChatSession[]>([]);
const picking = ref<boolean>(false);
const loading = ref<boolean>(false);
const errorMessage = ref<string | null>(null);
const scrollRef = ref<HTMLDivElement | null>(null);
let loadEpoch = 0;

async function refreshSessionsForIssue(): Promise<void> {
  if (!props.issue) {
    sessions.value = [];
    return;
  }
  const epoch = ++loadEpoch;
  loading.value = true;
  errorMessage.value = null;
  try {
    const rows = await fetchIssueSessions(props.issue.id);
    if (epoch !== loadEpoch) return;
    sessions.value = rows;
    if (rows.length > 0) {
      // Most-recent dispatch first → resume it on open.
      await chat.openExisting(rows[0].id);
    }
  } catch (err) {
    if (epoch !== loadEpoch) return;
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (epoch === loadEpoch) loading.value = false;
  }
}

async function refreshSessionsForBoard(): Promise<void> {
  if (!props.repo) {
    sessions.value = [];
    return;
  }
  const epoch = ++loadEpoch;
  loading.value = true;
  errorMessage.value = null;
  try {
    const rows = await fetchBoardSessions(props.repo);
    if (epoch !== loadEpoch) return;
    sessions.value = rows;
  } catch (err) {
    if (epoch !== loadEpoch) return;
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (epoch === loadEpoch) loading.value = false;
  }
}

function resetForIssue(): void {
  chat.reset();
  picking.value = false;
  void refreshSessionsForIssue();
}

function resetForBoard(): void {
  chat.reset();
  picking.value = true;
  void refreshSessionsForBoard();
}

if (props.mode === "issue") {
  resetForIssue();
} else {
  resetForBoard();
}

watch(
  () => props.issue?.id,
  () => {
    if (props.mode === "issue") resetForIssue();
  },
);

watch(
  () => props.mode,
  (m) => {
    if (m === "issue") resetForIssue();
    else resetForBoard();
  },
);

watch(
  [() => chat.blocks.value.length, () => chat.session.value?.id, chat.streaming],
  () => {
    void nextTick(() => {
      const el = scrollRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

const allBlocks = computed<ChatBlock[]>(() => chat.blocks.value);

const displayRepo = computed<string>(
  () => chat.session.value?.repo || props.repo || "",
);

const scope = computed<string>(() => {
  if (props.mode === "issue" && props.issue) {
    const r = displayRepo.value;
    return r ? `${props.issue.id} · ${r}` : props.issue.id;
  }
  const r = displayRepo.value || "—";
  return `${r} board`;
});

const composerPlaceholder = computed<string>(() => {
  if (props.mode === "issue" && props.issue) {
    return `Ask danxbot about ${props.issue.id}…`;
  }
  return `Ask danxbot about the ${displayRepo.value} board…`;
});

async function onSend(text: string): Promise<void> {
  errorMessage.value = null;
  try {
    if (chat.session.value) {
      await chat.sendMessage(text);
    } else if (props.mode === "board" && props.repo) {
      await chat.startBoard(props.repo, text);
    } else {
      throw new Error("Cannot send: no active session and no board repo");
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

async function onStop(): Promise<void> {
  try {
    await chat.cancel();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

async function onPick(s: ChatSession): Promise<void> {
  picking.value = false;
  errorMessage.value = null;
  try {
    await chat.openExisting(s.id);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

function startNew(): void {
  chat.reset();
  picking.value = false;
  // Board chats start when the operator sends their first message via
  // the composer below — that's when we have a `task` to launch with.
  // Issue chats need a prior dispatch to resume, so the empty-state
  // path stays the only entry point for "no prior session" issues.
}

function backToPicker(): void {
  chat.reset();
  picking.value = true;
  void refreshSessionsForBoard();
}

onBeforeUnmount(() => {
  // The composable handles its own onBeforeUnmount disconnect.
});
</script>

<template>
  <div class="agent-chat">
    <BoardSessionPicker
      v-if="mode === 'board' && picking"
      :sessions="sessions"
      :repo="repo ?? null"
      :loading="loading"
      :error="errorMessage"
      @pick="onPick"
      @start-new="startNew"
    />
    <div
      v-else-if="mode === 'issue' && !chat.session.value && !loading"
      class="empty-issue"
    >
      <div class="bubble-icon">💬</div>
      <div class="empty-title">No agent session yet for {{ issue?.id }}</div>
      <div class="empty-text">
        This issue hasn't been picked up by danxbot yet. Once a dispatch
        runs against this card, the Chat tab will resume the live
        Claude Code session here.
      </div>
      <div v-if="errorMessage" class="error">{{ errorMessage }}</div>
    </div>
    <div v-else-if="loading" class="loading">Loading chat…</div>
    <template v-else-if="chat.session.value || mode === 'board'">
      <div v-if="mode === 'board'" class="top-actions">
        <button type="button" class="back" @click="backToPicker">← All sessions</button>
        <span class="active-title">
          {{ chat.session.value?.title ?? `New chat about ${repo}` }}
        </span>
      </div>
      <SessionContextBar
        v-if="chat.session.value"
        :session="chat.session.value"
        :scope="scope"
        :streaming="chat.streaming.value"
        @stop="onStop"
      />
      <div ref="scrollRef" class="scroll">
        <ChatTimeline :blocks="allBlocks" :streaming="chat.streaming.value" />
      </div>
      <div v-if="errorMessage" class="error inline">{{ errorMessage }}</div>
      <ChatComposer
        :disabled="chat.streaming.value"
        :placeholder="composerPlaceholder"
        @send="onSend"
      />
    </template>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.empty-issue {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
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
  margin-bottom: 16px;
  text-wrap: pretty;
}
.loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #94a3b8;
}
.error {
  font-size: 12px;
  color: #fca5a5;
  padding: 8px 16px;
}
.error.inline {
  border-top: 1px solid rgb(239 68 68 / 0.25);
}
.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid #1e293b;
  background: rgb(2 6 23 / 0.4);
  font-size: 11px;
}
.back {
  background: none;
  border: 0;
  color: #94a3b8;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  padding: 0;
}
.active-title {
  color: #cbd5e1;
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  background: rgb(2 6 23 / 0.4);
}
</style>
