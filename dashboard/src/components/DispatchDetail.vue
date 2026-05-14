<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { Dispatch, DispatchDetail, JsonlBlock } from "../types";
import { DanxButton, DanxIcon } from "@thehammer/danx-ui";
import arrowDownIcon from "danx-icon/src/fontawesome/solid/arrow-down.svg?raw";
import { fetchDispatchDetail, followDispatch } from "../api";
import SessionTimeline from "./SessionTimeline.vue";
import TriggerBadge from "./TriggerBadge.vue";
import StatusBadge from "./StatusBadge.vue";

const props = defineProps<{ dispatch: Dispatch }>();
defineEmits<{ close: [] }>();

const detail = ref<DispatchDetail | null>(null);
const liveBlocks = ref<JsonlBlock[]>([]);
const loading = ref(true);
// Distinguishes "first paint after load()" (pin to bottom unconditionally)
// from "later updates" (respect user scroll position). Resetting on every
// load() means a prop-change reload also pins on first paint.
let pendingFirstFill = true;
let stopFollow: (() => void) | null = null;

// Auto-scroll discipline: only follow the tail if the user is already
// pinned to the bottom of the timeline. The moment they scroll up to
// read something we stop auto-scrolling and surface a "new entries ↓"
// affordance instead. `userAtBottom` tracks position; `newEntriesPending`
// signals the affordance.
const timelineRef = ref<HTMLDivElement | null>(null);
const userAtBottom = ref(true);
const newEntriesPending = ref(false);
const BOTTOM_PX_THRESHOLD = 32;

function isPinnedToBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_PX_THRESHOLD;
}

function onScroll(): void {
  const el = timelineRef.value;
  if (!el) return;
  userAtBottom.value = isPinnedToBottom(el);
  if (userAtBottom.value) newEntriesPending.value = false;
}

function scrollToBottom(): void {
  const el = timelineRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  userAtBottom.value = true;
  newEntriesPending.value = false;
}

async function load(id: string): Promise<void> {
  loading.value = true;
  detail.value = null;
  liveBlocks.value = [];
  pendingFirstFill = true;
  try {
    detail.value = await fetchDispatchDetail(id);
  } finally {
    loading.value = false;
  }
  if (detail.value?.dispatch.status === "running" || detail.value?.dispatch.status === "queued") {
    stopFollow = followDispatch(
      id,
      (block) => {
        liveBlocks.value.push(block);
      },
      () => {},
    );
  }
}

onMounted(() => load(props.dispatch.id));
onUnmounted(() => stopFollow?.());

watch(
  () => props.dispatch.id,
  (id) => {
    stopFollow?.();
    stopFollow = null;
    load(id);
  },
);

const combinedBlocks = computed<JsonlBlock[]>(() => [
  ...(detail.value?.timeline ?? []),
  ...liveBlocks.value,
]);

watch(combinedBlocks, async (curr) => {
  if (curr.length === 0) return;
  if (pendingFirstFill) {
    pendingFirstFill = false;
    await nextTick();
    scrollToBottom();
    return;
  }
  if (userAtBottom.value) {
    await nextTick();
    scrollToBottom();
  } else {
    newEntriesPending.value = true;
  }
});

const totals = computed(() => detail.value?.totals ?? null);

function durationSec(d: Dispatch): string {
  const end = d.completedAt ?? Date.now();
  const s = Math.max(0, Math.floor((end - d.startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Top tools: count occurrences across timeline (including sub-agent blocks).
// The Agent tool_use wrapper IS counted alongside its nested subagent
// blocks — the existing test pins this semantic ("subagent wrapper itself
// counts as a parent tool_use") so operators see one consolidated tool
// frequency table including the meta dispatch action.
function collectToolCounts(blocks: JsonlBlock[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of blocks) {
    if (b.type !== "tool_use") continue;
    counts[b.name] = (counts[b.name] || 0) + 1;
    if (b.subagent) {
      const nested = collectToolCounts(b.subagent.blocks);
      for (const [k, v] of Object.entries(nested)) {
        counts[k] = (counts[k] || 0) + v;
      }
    }
  }
  return counts;
}

const topTools = computed(() => {
  const counts = collectToolCounts(combinedBlocks.value);
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
});
</script>

<template>
  <div data-test="backdrop" class="fixed inset-0 bg-slate-950/70 z-40" @click="$emit('close')"></div>
  <div
    class="fixed right-0 top-0 h-full w-[min(1100px,95vw)] bg-slate-950 border-l border-slate-800 shadow-2xl overflow-hidden z-50 flex flex-col"
  >
    <div class="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/70">
      <div class="flex items-center gap-3 flex-wrap">
        <TriggerBadge :trigger="dispatch.trigger" />
        <StatusBadge :status="dispatch.status" />
        <span class="text-sm text-slate-300">{{ dispatch.repoName }}</span>
        <span class="text-xs text-slate-500 font-mono">{{ dispatch.id.slice(0, 12) }}</span>
        <span class="text-xs text-slate-500">
          {{ new Date(dispatch.startedAt).toISOString().replace("T", " ").slice(0, 19) }}
        </span>
        <span class="text-xs text-slate-400">duration {{ durationSec(dispatch) }}</span>
        <span v-if="dispatch.danxbotCommit" class="text-xs text-slate-500 font-mono">
          danxbot {{ dispatch.danxbotCommit }}
        </span>
      </div>
      <button
        class="text-slate-400 hover:text-slate-200 text-xl leading-none"
        @click="$emit('close')"
      >✕</button>
    </div>

    <div class="grid grid-cols-[1fr_260px] flex-1 overflow-hidden">
      <div class="relative overflow-hidden">
        <div
          ref="timelineRef"
          data-test="timeline-scroll"
          class="absolute inset-0 overflow-auto p-5 bg-slate-950"
          @scroll="onScroll"
        >
          <div v-if="loading" class="text-slate-500 text-sm">Loading timeline…</div>
          <div v-else-if="combinedBlocks.length === 0" class="text-slate-500 text-sm">
            No JSONL entries yet.
          </div>
          <SessionTimeline v-else :blocks="combinedBlocks" />
        </div>
        <DanxButton
          v-if="newEntriesPending"
          data-test="new-entries-affordance"
          size="sm"
          class="!absolute bottom-4 right-4 z-10 shadow-lg"
          @click="scrollToBottom"
        >
          <span class="flex items-center gap-1.5">
            new entries
            <DanxIcon :icon="arrowDownIcon" class="w-3 h-3" />
          </span>
        </DanxButton>
      </div>

      <aside class="border-l border-slate-800 bg-slate-900/40 overflow-auto p-4 text-xs text-slate-300">
        <section class="mb-5">
          <h4 class="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Totals</h4>
          <div class="grid grid-cols-2 gap-y-1 font-mono">
            <span class="text-slate-500">Turns</span>
            <span class="text-right">{{ combinedBlocks.filter(b => b.type === 'assistant_text').length }}</span>
            <span class="text-slate-500">Tool calls</span>
            <span class="text-right">{{ totals?.toolCallCount ?? dispatch.toolCallCount }}</span>
            <span class="text-slate-500">Sub-agents</span>
            <span class="text-right">{{ totals?.subagentCount ?? dispatch.subagentCount }}</span>
            <span class="text-slate-500">Nudges</span>
            <span class="text-right">{{ dispatch.nudgeCount }}</span>
          </div>
        </section>

        <section class="mb-5">
          <h4 class="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Tokens</h4>
          <div class="grid grid-cols-2 gap-y-1 font-mono">
            <span class="text-slate-500">Total</span>
            <span class="text-right">{{ (totals?.tokensTotal ?? dispatch.tokensTotal).toLocaleString() }}</span>
            <span class="text-slate-500">In</span>
            <span class="text-right">{{ (totals?.tokensIn ?? dispatch.tokensIn).toLocaleString() }}</span>
            <span class="text-slate-500">Out</span>
            <span class="text-right">{{ (totals?.tokensOut ?? dispatch.tokensOut).toLocaleString() }}</span>
            <span class="text-slate-500">Cache read</span>
            <span class="text-right">{{ (totals?.cacheRead ?? dispatch.cacheRead).toLocaleString() }}</span>
            <span class="text-slate-500">Cache write</span>
            <span class="text-right">{{ (totals?.cacheWrite ?? dispatch.cacheWrite).toLocaleString() }}</span>
          </div>
        </section>

        <section class="mb-5">
          <h4 class="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Top tools</h4>
          <div v-if="topTools.length === 0" class="text-slate-500">None yet.</div>
          <div
            v-for="[name, count] in topTools"
            :key="name"
            class="flex justify-between font-mono"
          >
            <span class="text-slate-300">{{ name }}</span>
            <span class="text-slate-500">{{ count }}</span>
          </div>
        </section>

        <section>
          <h4 class="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Artifacts</h4>
          <a
            v-if="dispatch.jsonlPath"
            :href="`/api/dispatches/${dispatch.id}/raw`"
            class="block text-indigo-300 hover:text-indigo-200 underline"
          >Download JSONL</a>
          <div v-else class="text-slate-500">No JSONL recorded.</div>
          <div v-if="dispatch.sessionUuid" class="mt-1 text-[11px] text-slate-500 font-mono break-all">
            session {{ dispatch.sessionUuid }}
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>
