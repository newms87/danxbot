<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { IssueDetail } from "../../types";
import type { ChatBlock, ChatSession } from "./chatFixtures";
import {
  FIXTURE_BOARD_SESSIONS,
  getIssueSession,
} from "./chatFixtures";
import ChatTimeline from "./ChatTimeline.vue";
import ChatComposer from "./ChatComposer.vue";
import SessionContextBar from "./SessionContextBar.vue";
import BoardSessionPicker from "./BoardSessionPicker.vue";

type Mode = "issue" | "board";

const props = defineProps<{
  mode: Mode;
  issue?: IssueDetail | null;
  repo?: string | null;
  sessions?: ChatSession[];
}>();

const sessions = computed<ChatSession[]>(() => props.sessions ?? FIXTURE_BOARD_SESSIONS);

const activeSession = ref<ChatSession | null>(null);
const picking = ref<boolean>(false);
const extraBlocks = ref<ChatBlock[]>([]);
const streaming = ref<boolean>(false);
const scrollRef = ref<HTMLDivElement | null>(null);
const timers: ReturnType<typeof setTimeout>[] = [];
// Bumped on every reset; queued setTimeout callbacks check this against the
// epoch they captured at schedule time and abort if it has changed. Guards
// against stream callbacks landing on a fresh session after a mode/issue
// switch.
let streamEpoch = 0;

function clearTimers(): void {
  streamEpoch += 1;
  while (timers.length > 0) {
    const t = timers.shift();
    if (t !== undefined) clearTimeout(t);
  }
}

function resetForIssue(): void {
  activeSession.value = props.issue ? getIssueSession(props.issue.id) : null;
  extraBlocks.value = [];
  streaming.value = false;
  picking.value = false;
  clearTimers();
}

function resetForBoard(): void {
  activeSession.value = null;
  extraBlocks.value = [];
  streaming.value = false;
  picking.value = true;
  clearTimers();
}

// Initial state.
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

// Autoscroll on new content.
watch(
  [() => extraBlocks.value.length, () => activeSession.value?.id, streaming],
  () => {
    void nextTick(() => {
      const el = scrollRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

const allBlocks = computed<ChatBlock[]>(() => {
  const fromSession = activeSession.value?.timeline ?? [];
  return [...fromSession, ...extraBlocks.value];
});

const displayRepo = computed<string>(
  () => activeSession.value?.repo ?? props.repo ?? "",
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

function onSend(text: string): void {
  extraBlocks.value.push({ type: "user", text, ts: Date.now() });
  streaming.value = true;
  const epoch = streamEpoch;
  const guard = (fn: () => void): (() => void) => () => {
    if (epoch !== streamEpoch) return;
    fn();
  };
  // Mock 3-step stream: 700ms thinking, 1500ms tool pair, 2400ms assistant text.
  const baseId = `live-${Date.now()}`;
  timers.push(
    setTimeout(
      guard(() => {
        extraBlocks.value.push({
          type: "thinking",
          text:
            "Re-reading the relevant code to answer with current state, then double-checking against the issue's AC.",
        });
      }),
      700,
    ),
  );
  timers.push(
    setTimeout(
      guard(() => {
        extraBlocks.value.push(
          {
            type: "tool_use",
            id: baseId,
            name: "read_file",
            input: { path: "src/poller/trello-client.ts" },
          },
          {
            type: "tool_result",
            toolUseId: baseId,
            result:
              "[file: src/poller/trello-client.ts] 218 lines · parseRetryAfter() at line 138",
          },
        );
      }),
      1500,
    ),
  );
  timers.push(
    setTimeout(
      guard(() => {
        extraBlocks.value.push({
          type: "assistant_text",
          text:
            "Resumed. The fix is live in `parseRetryAfter()` at line 138 — it parses both the integer-seconds and HTTP-date forms and caps at 5min. All 4 AC items shipped in commits 3a91c2 and f02bb1.\n\nWhat would you like me to dig into?",
        });
        streaming.value = false;
      }),
      2400,
    ),
  );
}

function onStop(): void {
  streaming.value = false;
  clearTimers();
}

function startNew(): void {
  const id = `sess_new_${Date.now()}`;
  const issue = props.issue;
  if (props.mode === "issue" && issue) {
    activeSession.value = {
      id,
      title: `New chat about ${issue.id}`,
      dispatchId: id.slice(5, 17),
      repo: props.repo ?? "",
      turns: 0,
      toolCalls: 0,
      subagentCount: 0,
      startedAt: Date.now(),
      status: "running",
      timeline: [
        {
          type: "user",
          text: `Loading context for ${issue.id} — ${issue.title}.`,
        },
        {
          type: "assistant_text",
          text: `Got it. I have ${issue.id} loaded with its description, ${issue.ac?.length ?? 0} AC items${
            issue.parent_id ? `, and parent epic ${issue.parent_id}` : ""
          }. What do you want to know?`,
        },
      ],
    };
  } else {
    const r = props.repo ?? "platform";
    activeSession.value = {
      id,
      title: "New board chat",
      repo: r,
      turns: 0,
      toolCalls: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: "running",
      timeline: [
        {
          type: "assistant_text",
          text: `New session for the ${r} board. I have all open and recently-closed issues loaded. What would you like to discuss?`,
        },
      ],
    };
  }
  extraBlocks.value = [];
  picking.value = false;
}

function onPick(s: ChatSession): void {
  activeSession.value = s;
  picking.value = false;
}

function backToPicker(): void {
  activeSession.value = null;
  picking.value = true;
  extraBlocks.value = [];
  clearTimers();
}

onBeforeUnmount(clearTimers);
</script>

<template>
  <div class="agent-chat">
    <BoardSessionPicker
      v-if="mode === 'board' && picking"
      :sessions="sessions"
      :repo="repo ?? null"
      @pick="onPick"
      @start-new="startNew"
    />
    <div v-else-if="mode === 'issue' && !activeSession" class="empty-issue">
      <div class="bubble-icon">💬</div>
      <div class="empty-title">No agent session yet for {{ issue?.id }}</div>
      <div class="empty-text">
        This issue hasn't been picked up by danxbot yet. Start a new session and
        the agent will load the issue context, the repo, and any related
        dispatches.
      </div>
      <button type="button" class="start-new" @click="startNew">Start new session →</button>
    </div>
    <template v-else-if="activeSession">
      <div v-if="mode === 'board'" class="top-actions">
        <button type="button" class="back" @click="backToPicker">← All sessions</button>
        <span class="active-title">{{ activeSession.title }}</span>
      </div>
      <SessionContextBar
        :session="activeSession"
        :scope="scope"
        :streaming="streaming"
        @stop="onStop"
      />
      <div ref="scrollRef" class="scroll">
        <ChatTimeline :blocks="allBlocks" :streaming="streaming" />
      </div>
      <ChatComposer
        :disabled="streaming"
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
.start-new {
  padding: 8px 16px;
  border-radius: 6px;
  border: 0;
  background: #4f46e5;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
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
