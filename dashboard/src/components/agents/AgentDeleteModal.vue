<script setup lang="ts">
/**
 * AgentDeleteModal — DX-160 Phase 2.
 *
 * Confirms agent deletion with a clear warning that the worktree +
 * branch will be torn down (Phase 3 owns the actual teardown wiring;
 * Phase 2 only removes the settings record + per-agent dir). The copy
 * matches the long-term contract so operators see the same warning
 * regardless of when teardown lands.
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
    :aria-label="`Delete ${agent.name}`"
    data-test="agent-delete-modal"
  >
    <div class="modal">
      <h2 class="title">Delete agent “{{ agent.name }}”?</h2>
      <p class="warn">
        This will remove the agent's record from
        <code>.danxbot/settings.json</code> and tear down its worktree +
        branch when the agent is idle. Avatar files under
        <code>.danxbot/agents/{{ agent.name }}/</code> are also removed.
      </p>
      <p class="warn">
        This action is <strong>irreversible</strong>.
      </p>
      <div v-if="error" class="error" data-test="agent-delete-error">{{ error }}</div>
      <footer class="actions">
        <button
          type="button"
          class="btn btn-cancel"
          :disabled="busy"
          data-test="agent-delete-cancel"
          @click="$emit('cancel')"
        >Cancel</button>
        <button
          type="button"
          class="btn btn-confirm"
          :disabled="busy"
          data-test="agent-delete-confirm"
          @click="$emit('confirm')"
        >{{ busy ? "Deleting…" : "Delete" }}</button>
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
.warn code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(15, 23, 42, 0.7);
  padding: 1px 4px;
  border-radius: 3px;
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
  background: #ef4444;
  color: white;
  border-color: #ef4444;
  font-weight: 600;
}
.btn-confirm:hover {
  background: #dc2626;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
