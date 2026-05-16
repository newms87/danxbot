<script setup lang="ts">
import { computed, ref } from "vue";
import { MarkdownEditor } from "@thehammer/danx-ui";
import { useBrokenAgents } from "../composables/useBrokenAgents";
import { useNowTick } from "../composables/useNowTick";

defineEmits<{
  /** Operator clicked "View agent" — emit so the parent route can switch tabs. */
  "open-agent": [repo: string, agent: string];
}>();

const { entries, error, unblock, reRunEvaluator } = useBrokenAgents();

/**
 * Drives the "Nm ago" relative-time labels via the shared 60s cosmetic
 * ticker (`useNowTick`). Sharing the tick keeps the banner consistent
 * with `AgentCard`'s busy badge — no second clock skew.
 */
const now = useNowTick();

/** Track which row currently has its confirm modal open. */
const pendingUnblock = ref<{ repo: string; agent: string } | null>(null);

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

/** Banner visibility — silent green state when zero rows. */
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
  <div
    v-if="visible"
    role="alert"
    aria-live="assertive"
    data-test="broken-agents-banner"
    class="broken-banner"
  >
    <div class="headline">
      <span aria-hidden="true" class="icon">🔴</span>
      <span>AGENTS BROKEN — IMMEDIATE ACTION REQUIRED</span>
      <span class="count">{{ entries.length }}</span>
    </div>

    <div
      v-if="error"
      class="row-error"
      data-test="broken-agents-banner-error"
    >{{ error }}</div>

    <ul class="rows">
      <li
        v-for="entry in entries"
        :key="`${entry.repoName}/${entry.agentName}`"
        class="row"
        :data-test="`broken-row-${entry.repoName}-${entry.agentName}`"
      >
        <div class="row-head">
          <span class="agent-name">{{ entry.agentName }}</span>
          <span class="repo-chip">{{ entry.repoName }}</span>
          <span class="when">broken {{ relativeTime(entry.broken.set_at) }}</span>
          <span
            v-if="entry.broken.evaluator_status !== 'completed'"
            class="evaluator-status"
            :data-evaluator-status="entry.broken.evaluator_status"
          >evaluator: {{ entry.broken.evaluator_status }}</span>
        </div>

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

        <div class="row-actions">
          <button
            type="button"
            class="btn btn-unblock"
            :disabled="entry.unblocking"
            :data-test="`broken-unblock-${entry.repoName}-${entry.agentName}`"
            @click="openUnblockConfirm(entry.repoName, entry.agentName)"
          >{{ entry.unblocking ? "Unblocking…" : "Unblock + reset strikes" }}</button>
          <button
            type="button"
            class="btn btn-reevaluate"
            :disabled="entry.reRunning || entry.broken.evaluator_status === 'running'"
            :data-test="`broken-reeval-${entry.repoName}-${entry.agentName}`"
            @click="reRunEvaluator(entry.repoName, entry.agentName)"
          >
            <span v-if="entry.broken.evaluator_status === 'running'">Evaluator running…</span>
            <span v-else-if="entry.reRunning">Queuing…</span>
            <span v-else>Re-run evaluator</span>
          </button>
          <button
            type="button"
            class="btn btn-view"
            :data-test="`broken-view-${entry.repoName}-${entry.agentName}`"
            @click="$emit('open-agent', entry.repoName, entry.agentName)"
          >View agent</button>
        </div>
      </li>
    </ul>

    <!--
      Confirmation modal — Unblock destroys the strike-broken state.
      Accessibility: Escape + click-outside cancel; the overlay receives
      keyboard focus so the Escape handler fires without depending on
      browser focus heuristics.
    -->
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
          <button
            type="button"
            class="btn btn-cancel"
            data-test="broken-unblock-cancel"
            @click="closeUnblockConfirm"
          >Cancel</button>
          <button
            type="button"
            class="btn btn-confirm"
            data-test="broken-unblock-confirm"
            @click="confirmUnblock"
          >Unblock + reset strikes</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.broken-banner {
  background: #b91c1c; /* tailwind red-700 — sufficient contrast w/ white */
  color: #ffffff;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
  max-height: 40vh;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(127, 29, 29, 0.4);
}
.headline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.03em;
  margin-bottom: 8px;
}
.icon {
  font-size: 16px;
  line-height: 1;
}
.count {
  margin-left: 4px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  font-weight: 600;
}
.row-error {
  background: rgba(0, 0, 0, 0.25);
  color: #fee2e2;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 8px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 10px 12px;
}
.row-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
.agent-name {
  font-weight: 700;
}
.repo-chip {
  background: rgba(0, 0, 0, 0.3);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.when {
  color: #fecaca;
  font-size: 12px;
}
.evaluator-status {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
}
[data-evaluator-status="failed"] {
  background: rgba(0, 0, 0, 0.4);
}
.reason {
  margin-top: 8px;
  background: #0f172a;
  color: #f1f5f9;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 13px;
}
.reason :deep(*) {
  color: #f1f5f9;
}
.reason :deep(p) {
  margin: 6px 0;
}
.reason :deep(a) {
  color: #93c5fd;
}
.reason :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  color: #fde68a;
  padding: 1px 5px;
  border-radius: 3px;
}
.reason :deep(pre) {
  background: rgba(0, 0, 0, 0.5);
  color: #f1f5f9;
  padding: 8px 10px;
  border-radius: 4px;
  overflow-x: auto;
}
.reason :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}
.reason :deep(blockquote) {
  border-left: 3px solid #475569;
  margin: 6px 0;
  padding-left: 10px;
  color: #cbd5e1;
}
.strikes {
  margin-top: 8px;
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
  background: rgba(0, 0, 0, 0.3);
  border-radius: 3px;
  padding: 0 4px;
}
.strike-status {
  font-style: italic;
  color: #fed7aa;
}
.strike-err {
  color: #fca5a5;
}
.row-actions {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: rgba(0, 0, 0, 0.25);
  color: #ffffff;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.4);
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn-unblock {
  background: #f59e0b;
  border-color: #f59e0b;
  color: #1a1207;
}
.btn-unblock:hover:not(:disabled) {
  background: #fbbf24;
}
.btn-reevaluate {
  background: rgba(255, 255, 255, 0.92);
  border-color: rgba(255, 255, 255, 0.92);
  color: #7f1d1d;
}
.btn-reevaluate:hover:not(:disabled) {
  background: #ffffff;
}
.btn-view {
  background: transparent;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
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
.modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.modal-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: #cbd5e1;
}
.modal-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn-cancel {
  background: transparent;
  border-color: #475569;
  color: #94a3b8;
}
.btn-cancel:hover {
  background: #1e293b;
}
.btn-confirm {
  background: #f59e0b;
  border-color: #f59e0b;
  color: #1a1207;
}
.btn-confirm:hover {
  background: #fbbf24;
}
</style>
