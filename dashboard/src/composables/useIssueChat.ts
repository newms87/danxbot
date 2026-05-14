/**
 * Per-card chat composable (DX-352 Phase 4).
 *
 * Owns the timeline + send wiring behind the IssueDrawer's Chat tab.
 * Symmetric with the worker's `POST /api/chat` + `chat:<ISS-N>` SSE
 * alias topic shipped in DX-351 Phase 3.
 *
 * Distinct from `useChat()` in `useChat.ts` (DX-84) — that composable
 * powers the standalone Agent Chat shell + Board Chat overlay and
 * follows a single dispatch's `dispatch:jsonl:<jobId>` stream. This
 * one follows the stable per-card alias so the conversation persists
 * across resume turns (each turn spawns a new dispatch row, but the
 * alias re-resolves to the new leaf on every fresh subscription).
 *
 * Re-subscribe contract (per DX-351 retro): the `chat:<ISS-N>` topic
 * binds to ONE leaf dispatch at subscribe time. A new turn (POST
 * /api/chat → new dispatch row) requires re-establishing the SSE so
 * the stream re-resolves to the new leaf. The composable handles
 * this internally — `send()` POSTs, then disconnects + re-subscribes.
 *
 * Dedup invariant: every JSONL block is keyed and tracked in
 * `seenKeys`. The JSONL watcher hydrates existing file content on
 * each fresh subscribe (DX-227 watcher hydration), so reconnect
 * would replay the entire timeline. Dedup by stable key keeps the
 * rendered list stable across reconnects.
 */

import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  ref,
  watch,
  type Ref,
} from "vue";
import { fetchWithAuth, sendChatMessage } from "../api";
import { useStream, type StreamEventHandler } from "./useStream";
import type { JsonlBlock } from "../types";
import { jsonlBlockToChatBlock } from "./useChat";
import type { ChatBlock } from "../components/chat/chatTypes";

export interface UseIssueChatReturn {
  /** Rendered timeline (deduped by stable key — JSONL re-hydration safe). */
  blocks: Ref<ChatBlock[]>;
  /** True while POST /api/chat is in flight OR the SSE stream is mid-turn. */
  loading: Ref<boolean>;
  /** Last error message from POST or stream failure. `null` after every successful action. */
  error: Ref<string | null>;
  /** Underlying SSE connection state — exposed so the UI can show "connecting…". */
  connectionState: Ref<"connecting" | "connected" | "disconnected">;
  /** Post the next user turn. Disconnects + re-subscribes to track the new leaf dispatch. */
  send(text: string): Promise<void>;
  /** Tear down the SSE subscription. Called automatically on unmount. */
  disconnect(): void;
}

function dedupKey(b: JsonlBlock): string | null {
  switch (b.type) {
    case "tool_use":
      return `tool_use:${b.id}`;
    case "tool_result":
      return `tool_result:${b.toolUseId}`;
    case "user":
    case "assistant_text":
    case "thinking":
      return `${b.type}:${b.timestampMs}`;
    default:
      return null;
  }
}

export function useIssueChat(
  repo: Ref<string>,
  issueId: Ref<string>,
): UseIssueChatReturn {
  const blocks = ref<ChatBlock[]>([]);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);
  const seenKeys = new Set<string>();
  // Optimistic user-message tracker: we push immediately on send() so
  // the operator sees their input land. When the same text re-appears
  // via the JSONL hydration (claude writes user turns to the session
  // file as the dispatch processes them), the dedup key on
  // `user:<timestampMs>` differs from our optimistic block's ts —
  // so the optimistic block must be dropped via a separate match.
  const optimisticTexts: string[] = [];

  const stream = useStream();
  const connectionState = computed(() => stream.connectionState.value);
  let unsubscribe: (() => void) | null = null;
  let probing = false;

  function pushBlocks(rawBlocks: JsonlBlock[]): void {
    let appendedUserText = false;
    for (const b of rawBlocks) {
      const key = dedupKey(b);
      if (key === null) continue;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const cb = jsonlBlockToChatBlock(b);
      if (!cb) continue;
      blocks.value.push(cb);
      if (cb.type === "user") appendedUserText = true;
    }
    // Drop the optimistic placeholder once the live user message lands.
    // `optimisticTexts` matches by content because timestamps from the
    // optimistic push (Date.now()) won't match the JSONL block's
    // timestampMs (claude's own clock).
    if (appendedUserText && optimisticTexts.length > 0) {
      for (let i = blocks.value.length - 1; i >= 0; i--) {
        const block = blocks.value[i];
        if (
          block.type === "user" &&
          block.ts === undefined &&
          optimisticTexts.includes(block.text)
        ) {
          const idx = optimisticTexts.indexOf(block.text);
          optimisticTexts.splice(idx, 1);
          blocks.value.splice(i, 1);
        }
      }
    }
  }

  const handler: StreamEventHandler = (event) => {
    if (!Array.isArray(event.data)) {
      // eslint-disable-next-line no-console
      console.warn(
        `useIssueChat(${issueId.value}): expected JsonlBlock[] payload, got`,
        event.data,
      );
      return;
    }
    pushBlocks(event.data as JsonlBlock[]);
    loading.value = false;
  };

  /**
   * Probe whether a chat alias is resolvable before subscribing.
   * `chat:<ISS-N>` 404s when no chat session exists yet for the card
   * (i.e. the first turn has not been posted). Without this guard,
   * `useStream` would attempt the subscription, the backend returns
   * 404, and useStream's reconnect backoff loop fires every 1-30s
   * indefinitely against the same dead topic.
   *
   * Resolution: do a HEAD-ish GET on the stream endpoint with the
   * topic. 200 → subscribe. 404 → defer until the first send() lands.
   */
  async function probeChatExists(target: string): Promise<boolean> {
    if (!target) return false;
    try {
      // The /api/stream endpoint is an SSE stream — we GET it just to
      // read the status line. AbortController cancels the streaming
      // body after the headers resolve so the multiplex doesn't keep
      // a subscriber slot open. A 200 means the alias resolved to a
      // live leaf dispatch; 404 means there is no chat session yet.
      const ctrl = new AbortController();
      const res = await fetchWithAuth(
        `/api/stream?topics=${encodeURIComponent(target)}`,
        { signal: ctrl.signal },
      );
      ctrl.abort();
      return res.status === 200;
    } catch (err) {
      // Distinguish a real fetch failure (5xx, DNS, offline) from the
      // 404 "no prior chat" case — the former is worth surfacing so a
      // misbehaving backend doesn't silently degrade to "always empty
      // tab." Both still gate-out the subscribe (next send drives the
      // attach attempt), but only the unexpected case warns.
      // eslint-disable-next-line no-console
      console.warn(
        `useIssueChat: chat-alias probe for "${target}" failed`,
        err,
      );
      return false;
    }
  }

  async function attach(): Promise<void> {
    if (probing) return;
    if (!issueId.value) return;
    detach();
    const target = `chat:${issueId.value}`;
    probing = true;
    try {
      const exists = await probeChatExists(target);
      if (!exists) {
        // No prior chat for the card — defer subscribe until first send.
        return;
      }
      if (target !== `chat:${issueId.value}`) {
        // The bound issue changed during the probe await. Drop this attach.
        return;
      }
      unsubscribe = stream.subscribe(target, handler);
    } finally {
      probing = false;
    }
  }

  function detach(): void {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!issueId.value || !repo.value) {
      error.value = "Cannot send: missing repo or issue id";
      return;
    }
    error.value = null;
    loading.value = true;
    // Optimistic: surface the user message immediately while the POST
    // completes. The matching JSONL `user` block (when claude writes
    // it) supersedes via the deduper above.
    optimisticTexts.push(trimmed);
    blocks.value.push({ type: "user", text: trimmed });
    try {
      await sendChatMessage(repo.value, issueId.value, trimmed);
      // The new dispatch row carries the leaf jobId. Re-establish the
      // SSE so the alias resolves to the new leaf's `dispatch:jsonl:*`
      // watcher (per DX-351 retro: alias does NOT auto-rebind on resume).
      detach();
      await attach();
    } catch (err) {
      // Roll back the optimistic block — POST never landed.
      const idx = optimisticTexts.indexOf(trimmed);
      if (idx !== -1) optimisticTexts.splice(idx, 1);
      const at = blocks.value.findIndex(
        (b) => b.type === "user" && b.ts === undefined && b.text === trimmed,
      );
      if (at !== -1) blocks.value.splice(at, 1);
      error.value = err instanceof Error ? err.message : String(err);
      loading.value = false;
    }
  }

  function reset(): void {
    detach();
    blocks.value = [];
    seenKeys.clear();
    optimisticTexts.length = 0;
    loading.value = false;
    error.value = null;
  }

  watch(
    () => issueId.value,
    () => {
      reset();
      void attach();
    },
    { immediate: true },
  );

  // `onBeforeUnmount` is a no-op outside a component setup() context
  // (test harnesses calling the composable directly). Guard the
  // registration so the Vue warn never fires.
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      detach();
      stream.disconnect();
    });
  }

  return {
    blocks,
    loading,
    error,
    connectionState,
    send,
    disconnect: detach,
  };
}
