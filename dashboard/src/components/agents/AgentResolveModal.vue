<script setup lang="ts">
/**
 * AgentResolveModal — DX-298.
 *
 * Confirmation for the "Mark Resolved" action on a broken agent. The
 * dashboard cannot SET broken (that's the worker's prep verdict route);
 * the only legal write is the null clear. Once cleared the agent
 * returns to the dispatchable pool on the poller's next tick.
 *
 * Mirrors AgentDeleteModal — same overlay/modal shell, same disabled-
 * during-busy semantics, same error display.
 */
import type { AgentRecordWithName } from "../../types";

defineProps<{
  agent: AgentRecordWithName;
  busy: boolean;
  error: string | null;
}>();
defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="`Mark ${agent.name} resolved`"
    data-test="agent-resolve-modal"
  >
    <div class="modal">
      <h2 class="title">Mark “{{ agent.name }}” resolved?</h2>
      <p class="warn">
        Confirm the agent's environment is fixed. Cleared records cannot
        be recovered without a re-stamp from a future prep dispatch.
      </p>
      <p class="warn">
        The agent rejoins the dispatchable pool on the poller's next
        tick.
      </p>
      <div
        v-if="error"
        class="error"
        data-test="agent-resolve-error"
      >{{ error }}</div>
      <footer class="actions">
        <button
          type="button"
          class="btn btn-cancel"
          :disabled="busy"
          data-test="agent-resolve-cancel"
          @click="$emit('cancel')"
        >Cancel</button>
        <button
          type="button"
          class="btn btn-confirm"
          :disabled="busy"
          data-test="agent-resolve-confirm"
          @click="$emit('confirm')"
        >{{ busy ? "Clearing…" : "Yes, mark resolved" }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 23, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
}
.modal {
  width: min(440px, 90vw);
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #f1f5f9;
}
.warn {
  margin: 0;
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.55;
}
.error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid #f87171;
  color: #fecaca;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 6px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.btn {
  font-size: 13px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #334155;
  cursor: pointer;
}
.btn-cancel {
  background: transparent;
  color: #94a3b8;
}
.btn-cancel:hover {
  background: #1e293b;
}
.btn-confirm {
  background: #22c55e;
  color: white;
  border-color: #22c55e;
  font-weight: 600;
}
.btn-confirm:hover {
  background: #16a34a;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
