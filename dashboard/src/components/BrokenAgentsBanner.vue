<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  DanxButton,
  DanxIcon,
  MarkdownEditor,
  chevronDownIcon,
  chevronRightIcon,
} from "@thehammer/danx-ui";
import { useBrokenAgents } from "../composables/useBrokenAgents";
import { useNowTick } from "../composables/useNowTick";

defineEmits<{
  "open-agent": [repo: string, agent: string];
}>();

const { entries, error, unblock, reRunEvaluator } = useBrokenAgents();

const now = useNowTick();

const pendingUnblock = ref<{ repo: string; agent: string } | null>(null);

const expanded = ref<Record<string, boolean>>({});

watch(entries, (list) => {
  const keys = new Set(list.map((e) => `${e.repoName}/${e.agentName}`));
  for (const k of Object.keys(expanded.value)) {
    if (!keys.has(k)) delete expanded.value[k];
  }
});

function rowKey(repo: string, agent: string): string {
  return `${repo}/${agent}`;
}

function toggle(repo: string, agent: string): void {
  const k = rowKey(repo, agent);
  expanded.value = { ...expanded.value, [k]: !expanded.value[k] };
}

function isExpanded(repo: string, agent: string): boolean {
  return !!expanded.value[rowKey(repo, agent)];
}

function relativeTime(iso: string): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = now.value - ts;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function truncate(s: string, max = 100): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function summarize(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return truncate(oneLine, 140);
}

const visible = computed(() => entries.value.length > 0);

function openUnblockConfirm(repo: string, agent: string): void {
  pendingUnblock.value = { repo, agent };
}

function closeUnblockConfirm(): void {
  pendingUnblock.value = null;
}

async function confirmUnblock(): Promise<void> {
  if (!pendingUnblock.value) return;
  const { repo, agent } = pendingUnblock.value;
  pendingUnblock.value = null;
  await unblock(repo, agent);
}
</script>

<template>
  <section
    v-if="visible"
    role="alert"
    aria-live="assertive"
    data-test="broken-agents-banner"
    class="broken-section"
  >
    <div class="section-title">
      <span aria-hidden="true">🔴</span>
      <span>Agents Broken — Action Required</span>
      <span class="count">{{ entries.length }}</span>
    </div>

    <div
      v-if="error"
      class="row-error"
      data-test="broken-agents-banner-error"
    >{{ error }}</div>

    <div
      v-for="entry in entries"
      :key="`${entry.repoName}/${entry.agentName}`"
      class="gate gate-broken"
      :class="{ expanded: isExpanded(entry.repoName, entry.agentName) }"
      :data-test="`broken-row-${entry.repoName}-${entry.agentName}`"
    >
      <button
        type="button"
        class="gate-bar"
        :aria-expanded="isExpanded(entry.repoName, entry.agentName)"
        :data-test="`broken-toggle-${entry.repoName}-${entry.agentName}`"
        @click="toggle(entry.repoName, entry.agentName)"
      >
        <DanxIcon
          :icon="isExpanded(entry.repoName, entry.agentName) ? chevronDownIcon : chevronRightIcon"
          class="chev"
        />
        <span class="gate-glyph" aria-hidden="true">🔴</span>
        <span class="gate-label">{{ entry.agentName }}</span>
        <span class="repo-chip">{{ entry.repoName }}</span>
        <span class="gate-summary">{{ summarize(entry.broken.reason) }}</span>
        <span
          v-if="entry.broken.evaluator_status !== 'completed'"
          class="evaluator-pill"
          :data-evaluator-status="entry.broken.evaluator_status"
        >eval: {{ entry.broken.evaluator_status }}</span>
        <span class="gate-meta">{{ relativeTime(entry.broken.set_at) }}</span>
      </button>

      <div
        v-if="isExpanded(entry.repoName, entry.agentName)"
        class="gate-body"
      >
        <div class="reason">
          <MarkdownEditor
            :model-value="entry.broken.reason"
            readonly
            hide-footer
          />
        </div>

        <div v-if="entry.strikes.history.length > 0" class="strikes">
          <div class="strikes-label">Strikes:</div>
          <ul>
            <li
              v-for="(strike, idx) in entry.strikes.history"
              :key="`${entry.agentName}-strike-${idx}`"
            >
              <code>{{ strike.issue_id }}</code>
              <span class="strike-status">({{ strike.terminal_status }})</span>
              at {{ relativeTime(strike.timestamp) }}
              <span v-if="strike.raw_error" class="strike-err">— {{ truncate(strike.raw_error) }}</span>
            </li>
          </ul>
        </div>

        <div class="gate-actions">
          <DanxButton
            size="sm"
            variant="warning"
            :disabled="entry.unblocking"
            :loading="entry.unblocking"
            :data-test="`broken-unblock-${entry.repoName}-${entry.agentName}`"
            @click="openUnblockConfirm(entry.repoName, entry.agentName)"
          >Unblock + reset strikes</DanxButton>
          <DanxButton
            size="sm"
            variant="muted"
            :disabled="entry.reRunning || entry.broken.evaluator_status === 'running'"
            :data-test="`broken-reeval-${entry.repoName}-${entry.agentName}`"
            @click="reRunEvaluator(entry.repoName, entry.agentName)"
          >
            <span v-if="entry.broken.evaluator_status === 'running'">Evaluator running…</span>
            <span v-else-if="entry.reRunning">Queuing…</span>
            <span v-else>Re-run evaluator</span>
          </DanxButton>
          <DanxButton
            size="sm"
            variant="muted"
            :data-test="`broken-view-${entry.repoName}-${entry.agentName}`"
            @click="$emit('open-agent', entry.repoName, entry.agentName)"
          >View agent</DanxButton>
        </div>
      </div>
    </div>

    <div
      v-if="pendingUnblock"
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm unblock"
      data-test="broken-unblock-modal"
      tabindex="-1"
      @click.self="closeUnblockConfirm"
      @keydown.esc.prevent="closeUnblockConfirm"
    >
      <div class="modal">
        <h2 class="modal-title">
          Unblock {{ pendingUnblock.agent }}?
        </h2>
        <p class="modal-body">
          Unblocking <code>{{ pendingUnblock.agent }}</code> resets its
          strike counter to 0. The strikes that led to the broken state are
          preserved on the agent record for forensics. The cause flagged in
          this banner may recur on the next dispatch.
        </p>
        <div class="modal-actions">
          <DanxButton
            size="sm"
            variant="muted"
            data-test="broken-unblock-cancel"
            @click="closeUnblockConfirm"
          >Cancel</DanxButton>
          <DanxButton
            size="sm"
            variant="warning"
            data-test="broken-unblock-confirm"
            @click="confirmUnblock"
          >Unblock + reset strikes</DanxButton>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.broken-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  border: 1px solid rgb(239 68 68 / 0.35);
  background: rgb(239 68 68 / 0.08);
}
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #fca5a5;
  margin-bottom: 2px;
}
.count {
  margin-left: 2px;
  background: rgb(0 0 0 / 0.3);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 700;
  color: #fee2e2;
}
.row-error {
  background: rgb(0 0 0 / 0.3);
  color: #fee2e2;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
}
.gate {
  border-radius: 6px;
  border: 1px solid rgb(239 68 68 / 0.30);
  background: rgb(239 68 68 / 0.10);
  overflow: hidden;
}
.gate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: 0;
  font-family: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.gate-bar:hover {
  background: rgb(255 255 255 / 0.03);
}
.chev {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: #94a3b8;
}
.gate-glyph {
  font-size: 12px;
  flex-shrink: 0;
}
.gate-label {
  font-size: 12px;
  font-weight: 700;
  color: #fca5a5;
  flex-shrink: 0;
}
.repo-chip {
  background: rgb(0 0 0 / 0.3);
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #e2e8f0;
  flex-shrink: 0;
}
.gate-summary {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #cbd5e1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.evaluator-pill {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.15);
  color: #fde68a;
  flex-shrink: 0;
}
.evaluator-pill[data-evaluator-status="failed"] {
  background: rgb(0 0 0 / 0.4);
  color: #fca5a5;
}
.gate-meta {
  font-size: 10px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.gate-body {
  padding: 4px 12px 12px 32px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  color: #cbd5e1;
}
.reason {
  background: #0f172a;
  color: #f1f5f9;
  border: 1px solid rgb(255 255 255 / 0.12);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 13px;
}
.reason :deep(*) { color: #f1f5f9; }
.reason :deep(p) { margin: 6px 0; }
.reason :deep(a) { color: #93c5fd; }
.reason :deep(code) {
  background: rgb(255 255 255 / 0.1);
  color: #fde68a;
  padding: 1px 5px;
  border-radius: 3px;
}
.reason :deep(pre) {
  background: rgb(0 0 0 / 0.5);
  color: #f1f5f9;
  padding: 8px 10px;
  border-radius: 4px;
  overflow-x: auto;
}
.reason :deep(pre code) { background: transparent; color: inherit; padding: 0; }
.reason :deep(blockquote) {
  border-left: 3px solid #475569;
  margin: 6px 0;
  padding-left: 10px;
  color: #cbd5e1;
}
.strikes {
  font-size: 12px;
  color: #fee2e2;
}
.strikes-label {
  font-weight: 600;
  margin-bottom: 2px;
}
.strikes ul {
  list-style: disc;
  padding-left: 20px;
  margin: 0;
}
.strikes code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgb(0 0 0 / 0.3);
  border-radius: 3px;
  padding: 0 4px;
}
.strike-status { font-style: italic; color: #fed7aa; }
.strike-err { color: #fca5a5; }
.gate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 90;
}
.modal {
  width: min(440px, 90vw);
  background: #0f172a;
  color: #f1f5f9;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.modal-title { margin: 0; font-size: 16px; font-weight: 700; }
.modal-body { margin: 0; font-size: 13px; line-height: 1.55; color: #cbd5e1; }
.modal-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgb(255 255 255 / 0.08);
  padding: 1px 5px;
  border-radius: 3px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
