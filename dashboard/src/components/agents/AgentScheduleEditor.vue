<script setup lang="ts">
/**
 * AgentScheduleEditor — DX-160 Phase 2.
 *
 * Per-day list of `HH:MM-HH:MM` 24h windows + IANA tz string. The shape
 * mirrors `AgentSchedule` from settings-file.ts; the parent owns the
 * model and we emit the entire updated object on change.
 *
 * Validation (lightweight): a malformed window stays in the list but
 * gets the `bad` class so the operator sees what failed before the
 * server 400s. The backend re-validates with the same regex, so this
 * is a UX hint, not a security gate.
 */
import { computed } from "vue";
import type { AgentSchedule } from "../../types";

const props = defineProps<{
  modelValue: AgentSchedule;
}>();
const emit = defineEmits<{ "update:modelValue": [AgentSchedule] }>();

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;
type Day = (typeof DAYS)[number][0];

const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
function isValidWindow(w: string): boolean {
  return WINDOW_RE.test(w);
}

const tz = computed({
  get: () => props.modelValue.tz,
  set: (v: string) =>
    emit("update:modelValue", { ...props.modelValue, tz: v }),
});

function setDay(day: Day, windows: string[]): void {
  emit("update:modelValue", { ...props.modelValue, [day]: windows });
}

function addWindow(day: Day): void {
  const windows = [...props.modelValue[day], "09:00-17:00"];
  setDay(day, windows);
}

function removeWindow(day: Day, idx: number): void {
  const windows = props.modelValue[day].filter((_, i) => i !== idx);
  setDay(day, windows);
}

function updateWindow(day: Day, idx: number, value: string): void {
  const windows = props.modelValue[day].map((w, i) => (i === idx ? value : w));
  setDay(day, windows);
}
</script>

<template>
  <div class="schedule">
    <label class="tz-row">
      <span class="lbl">Time zone</span>
      <input
        v-model="tz"
        type="text"
        class="tz-input"
        placeholder="America/Chicago"
        data-test="agent-schedule-tz"
      />
    </label>
    <div class="day-grid">
      <div v-for="[key, label] in DAYS" :key="key" class="day-row">
        <span class="day-label">{{ label }}</span>
        <div class="windows">
          <div
            v-for="(w, i) in props.modelValue[key]"
            :key="`${key}-${i}`"
            class="window-row"
          >
            <input
              :value="w"
              :class="['window-input', { bad: !isValidWindow(w) }]"
              type="text"
              placeholder="09:00-17:00"
              :data-test="`agent-schedule-${key}-${i}`"
              @input="updateWindow(key, i, ($event.target as HTMLInputElement).value)"
            />
            <button
              type="button"
              class="btn-remove"
              :aria-label="`Remove ${label} window ${i + 1}`"
              @click="removeWindow(key, i)"
            >
              −
            </button>
          </div>
          <button
            type="button"
            class="btn-add"
            :data-test="`agent-schedule-add-${key}`"
            @click="addWindow(key)"
          >
            + add window
          </button>
        </div>
      </div>
    </div>
    <p class="hint">
      24h format, e.g. <code>09:00-17:00</code>. Leave a day empty to disable scheduled work.
    </p>
  </div>
</template>

<style scoped>
.schedule {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tz-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lbl {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.tz-input,
.window-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid #334155;
  border-radius: 4px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.window-input.bad {
  border-color: #f87171;
}
.day-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.day-row {
  display: grid;
  grid-template-columns: 50px 1fr;
  gap: 8px;
  align-items: start;
}
.day-label {
  padding-top: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
}
.windows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.window-row {
  display: flex;
  gap: 4px;
}
.btn-add {
  align-self: flex-start;
  font-size: 11px;
  padding: 4px 8px;
  background: transparent;
  color: #60a5fa;
  border: 1px dashed #1e293b;
  border-radius: 4px;
  cursor: pointer;
}
.btn-add:hover {
  background: #1e293b;
}
.btn-remove {
  width: 28px;
  background: transparent;
  color: #94a3b8;
  border: 1px solid #1e293b;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.btn-remove:hover {
  color: #f87171;
  border-color: #f87171;
}
.hint {
  font-size: 11px;
  color: #64748b;
  margin: 0;
}
</style>
