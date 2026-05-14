<script setup lang="ts">
import { computed, ref } from "vue";
import type { Issue, IssueDetail } from "../../types";
import { patchIssue } from "../../api";
import { relativeTime } from "../../utils/relativeTime";
import { DanxTooltip, MarkdownEditor } from "@thehammer/danx-ui";

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  "update:issue": [issue: Issue];
}>();

interface PendingComment {
  key: string;
  text: string;
}

// `bot` = danxbot-authored (every agent / worker append-path stamps
// `author: "danxbot"`); `unknown` = legacy / pre-DX-236 rows synced
// from Trello before the server-stamp landed; `named` = everything
// else (human dashboard user, Trello-mirrored member display name).
type AuthorKind = "named" | "bot" | "unknown";

interface RenderedComment {
  key: string;
  authorLabel: string;
  authorKind: AuthorKind;
  tsLabel: string;
  tsTooltip: string | null;
  text: string;
  pending: boolean;
}

function tsLabel(s: string): string {
  const n = Date.parse(s);
  if (Number.isNaN(n)) return s || "(no timestamp)";
  return relativeTime(n);
}

function classifyAuthor(raw: string): { kind: AuthorKind; label: string } {
  if (!raw) return { kind: "unknown", label: "unknown" };
  if (raw === "danxbot") return { kind: "bot", label: "danxbot" };
  return { kind: "named", label: raw };
}

const draft = ref("");
const submitting = ref(false);
const errorMsg = ref<string | null>(null);
// Optimistic insertions waiting for the PATCH to resolve. Each carries
// a unique `key` so removal is per-entry — text-equality dedupe
// (earlier draft) would drop a still-in-flight pending whenever the
// user re-posted the same string.
const pending = ref<PendingComment[]>([]);
const pendingSeq = ref(0);

const comments = computed<RenderedComment[]>(() => {
  const real = props.issue.comments.map<RenderedComment>((c, i) => {
    const a = classifyAuthor(c.author);
    return {
      key: c.id ?? `c-${i}`,
      authorLabel: a.label,
      authorKind: a.kind,
      tsLabel: tsLabel(c.timestamp),
      tsTooltip: c.timestamp || null,
      text: c.text,
      pending: false,
    };
  });
  const pendingRendered = pending.value.map<RenderedComment>((p) => ({
    key: p.key,
    authorLabel: "you",
    authorKind: "named",
    tsLabel: "just now",
    tsTooltip: null,
    text: p.text,
    pending: true,
  }));
  return [...real, ...pendingRendered];
});

const canSubmit = computed(
  () => !submitting.value && draft.value.trim().length > 0,
);

async function onSubmit(): Promise<void> {
  const text = draft.value;
  if (!text.trim() || submitting.value) return;
  pendingSeq.value += 1;
  const optimistic: PendingComment = {
    key: `pending-${pendingSeq.value}`,
    text,
  };
  pending.value = [...pending.value, optimistic];
  submitting.value = true;
  errorMsg.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
      comments_append: { text },
    });
    // Remove THIS pending entry by key — not by text — so a duplicate
    // post in flight is not collateral damage. The parent's
    // `update:issue` round-trip lands the server-stamped comment via
    // `props.issue.comments`.
    pending.value = pending.value.filter((p) => p.key !== optimistic.key);
    draft.value = "";
    emit("update:issue", updated);
  } catch (err) {
    pending.value = pending.value.filter((p) => p.key !== optimistic.key);
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="comments-tab">
    <div v-if="comments.length === 0" class="empty">
      No comments yet.
    </div>
    <div v-else class="comments">
      <div
        v-for="c in comments"
        :key="c.key"
        class="bubble"
        :class="{ bot: c.authorKind === 'bot', pending: c.pending }"
        :data-test="c.pending ? 'comment-pending' : 'comment-real'"
      >
        <div class="head">
          <span
            class="author"
            :class="c.authorKind"
            data-test="comment-author"
          >
            <span
              v-if="c.authorKind === 'bot'"
              class="bot-glyph"
              aria-hidden="true"
              data-test="comment-bot-icon"
            >🤖</span>{{ c.authorLabel }}</span>
          <DanxTooltip :tooltip="c.tsTooltip ?? undefined">
            <template #trigger>
              <span
                class="ts"
                :class="{ 'has-tooltip': c.tsTooltip !== null }"
                data-test="comment-ts"
              >{{ c.tsLabel }}</span>
            </template>
          </DanxTooltip>
        </div>
        <MarkdownEditor
          :model-value="c.text"
          readonly
          hide-footer
          class="text"
        />
      </div>
    </div>
    <div class="composer">
      <textarea
        v-model="draft"
        rows="3"
        class="composer-input"
        placeholder="Write a comment… (markdown supported)"
        :disabled="submitting"
        data-test="comment-composer"
      />
      <div v-if="errorMsg" class="error" data-test="comment-error">{{ errorMsg }}</div>
      <div class="composer-actions">
        <button
          type="button"
          class="post-btn"
          :disabled="!canSubmit"
          data-test="comment-post"
          @click="onSubmit"
        >{{ submitting ? "Posting…" : "Post" }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comments-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}
.empty {
  padding: 40px 0;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
.comments {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bubble {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
}
.bubble.bot {
  background: rgb(30 27 75 / 0.4);
  border-color: rgb(99 102 241 / 0.25);
}
.bubble.pending {
  opacity: 0.6;
  border-style: dashed;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.author {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}
.author.bot {
  color: #a5b4fc;
  font-style: italic;
}
.author.unknown {
  color: #64748b;
  font-weight: 500;
  font-style: italic;
}
.bot-glyph {
  margin-right: 4px;
}
.ts {
  font-size: 11px;
  color: #64748b;
}
.ts.has-tooltip {
  cursor: help;
}
.text {
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.5;
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid #1e293b;
}
.composer-input {
  font-family: inherit;
  font-size: 13px;
  color: #e2e8f0;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 8px 10px;
  resize: vertical;
  min-height: 64px;
}
.composer-input:focus {
  outline: none;
  border-color: #6366f1;
}
.composer-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.error {
  font-size: 12px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.1);
  border: 1px solid rgb(239 68 68 / 0.3);
  padding: 6px 10px;
  border-radius: 4px;
}
.composer-actions {
  display: flex;
  justify-content: flex-end;
}
.post-btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #f1f5f9;
  background: #6366f1;
  border: 0;
  border-radius: 4px;
  padding: 6px 14px;
  cursor: pointer;
}
.post-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
