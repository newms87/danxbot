<script setup lang="ts">
defineProps<{
  busy: boolean;
  error: string | null;
  title: string;
  ariaLabel: string;
  confirmLabel: string;
  busyLabel: string;
  testPrefix: string;
  variant: "danger" | "success";
}>();
defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="ariaLabel"
    :data-test="`${testPrefix}-modal`"
  >
    <div class="modal">
      <h2 class="title">{{ title }}</h2>
      <!-- Body slot: pass <p class="warn">…</p> blocks for the documented prose styling. -->
      <slot name="body" />
      <div
        v-if="error"
        class="error"
        :data-test="`${testPrefix}-error`"
      >{{ error }}</div>
      <footer class="actions">
        <button
          type="button"
          class="btn btn-cancel"
          :disabled="busy"
          :data-test="`${testPrefix}-cancel`"
          @click="$emit('cancel')"
        >Cancel</button>
        <button
          type="button"
          class="btn btn-confirm"
          :class="variant === 'danger' ? 'btn-danger' : 'btn-success'"
          :disabled="busy"
          :data-test="`${testPrefix}-confirm`"
          @click="$emit('confirm')"
        >{{ busy ? busyLabel : confirmLabel }}</button>
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
.modal :slotted(.warn) {
  margin: 0;
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.55;
}
.modal :slotted(.warn code) {
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
  color: white;
  font-weight: 600;
}
.btn-danger {
  background: #ef4444;
  border-color: #ef4444;
}
.btn-danger:hover {
  background: #dc2626;
}
.btn-success {
  background: #22c55e;
  border-color: #22c55e;
}
.btn-success:hover {
  background: #16a34a;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
