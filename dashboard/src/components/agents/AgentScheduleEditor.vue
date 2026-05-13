<script setup lang="ts">
/**
 * AgentScheduleEditor (DX-251) — DanxToggle + DanxRangeSlider impl.
 *
 * Renders the agent schedule with a 24/7 master toggle and per-day on/off
 * + window controls. The 24/7 toggle binds to `schedule.always_on`;
 * toggling it does NOT clear per-day arrays — the data is preserved on
 * disk so flipping 24/7 back off restores the exact prior windows.
 *
 * Per-day model:
 *   - `enabled`  ↔ `windows.length > 0` (single-window UI)
 *   - `window`   ↔ `windows[0]` parsed as `HH:MM-HH:MM`
 *   - Toggling a day OFF caches the prior window in memory so toggling
 *     back ON restores it; on remount or save the canonical state is
 *     the on-disk array. The cache hydrates from the model via a
 *     `watchEffect`, never as a side-effect inside a computed getter.
 *
 * Time of day is encoded as minutes-of-day in `[0, 1440]` so the dual
 * range slider can step in 15-minute increments without floating-point
 * drift. `minutesToHHMM` clamps display to `23:59` so the persisted
 * value matches the backend's `SCHEDULE_WINDOW_SHAPE` regex.
 */
import { computed, reactive, watchEffect } from "vue";
import {
  DanxRangeSlider,
  DanxToggle,
  type RangeSliderModel,
} from "@thehammer/danx-ui";
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

const STEP_MIN = 15;
const MIN_OF_DAY = 0;
const MAX_OF_DAY = 1440;
const DEFAULT_START = 540; // 09:00
const DEFAULT_END = 1020; // 17:00
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function minutesToHHMM(n: number): string {
  // Cap display at 23:59 so the persisted shape passes the backend regex
  // (`SCHEDULE_WINDOW_SHAPE` rejects `24:00`). The slider can still
  // report 1440 internally; we clamp at format time.
  const clamped = Math.min(Math.max(Math.round(n), 0), 1439);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function windowToTuple(window: string): [number, number] | null {
  const m = WINDOW_RE.exec(window);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  return [startMin, endMin];
}

function tupleToWindow([startMin, endMin]: [number, number]): string {
  return `${minutesToHHMM(startMin)}-${minutesToHHMM(endMin)}`;
}

// Per-day in-memory cache of the last edited window. Lets toggling a day
// OFF then back ON restore the operator's working values instead of
// snapping to the 9-5 default. Hydrated from `modelValue` via watchEffect.
const windowCache = reactive<Record<Day, [number, number]>>({
  mon: [DEFAULT_START, DEFAULT_END],
  tue: [DEFAULT_START, DEFAULT_END],
  wed: [DEFAULT_START, DEFAULT_END],
  thu: [DEFAULT_START, DEFAULT_END],
  fri: [DEFAULT_START, DEFAULT_END],
  sat: [DEFAULT_START, DEFAULT_END],
  sun: [DEFAULT_START, DEFAULT_END],
});

watchEffect(() => {
  for (const [key] of DAYS) {
    const tuple = windowToTuple(props.modelValue[key][0] ?? "");
    if (tuple) {
      windowCache[key] = tuple;
    }
  }
});

const dayState = computed(() => {
  return DAYS.reduce(
    (acc, [key]) => {
      const tuple = windowToTuple(props.modelValue[key][0] ?? "");
      acc[key] = {
        enabled: props.modelValue[key].length > 0,
        window: tuple ?? windowCache[key],
      };
      return acc;
    },
    {} as Record<Day, { enabled: boolean; window: [number, number] }>,
  );
});

const alwaysOn = computed({
  get: () => props.modelValue.always_on,
  set: (v: boolean) =>
    emit("update:modelValue", { ...props.modelValue, always_on: v }),
});

const tz = computed({
  get: () => props.modelValue.tz,
  set: (v: string) =>
    emit("update:modelValue", { ...props.modelValue, tz: v }),
});

function setDay(day: Day, windows: string[]): void {
  emit("update:modelValue", { ...props.modelValue, [day]: windows });
}

function setDayEnabled(day: Day, enabled: boolean): void {
  if (enabled) {
    setDay(day, [tupleToWindow(windowCache[day])]);
  } else {
    setDay(day, []);
  }
}

function setDayWindow(day: Day, next: RangeSliderModel): void {
  // Tuple mode (dual-handle) emits `[min, max]`. Single-mode emits a bare
  // number — defensive ignore (we always render the dual-handle slider, so
  // a number emit would mean an upstream contract change we should not
  // silently absorb).
  if (!Array.isArray(next)) return;
  const safe: [number, number] = [next[0], next[1]];
  windowCache[day] = safe;
  setDay(day, [tupleToWindow(safe)]);
}
</script>

<template>
  <div class="schedule">
    <div class="row-toggle" data-test="agent-schedule-always-on-row">
      <DanxToggle
        v-model="alwaysOn"
        size="md"
        aria-label="Always on (24/7)"
        data-test="agent-schedule-always-on"
      />
      <div class="row-toggle-text">
        <span class="row-toggle-title">Always on (24/7)</span>
        <span class="row-toggle-sub">
          {{ alwaysOn
              ? "Agent runs at every poll tick, ignoring per-day windows."
              : "Use the per-day controls below to limit working hours." }}
        </span>
      </div>
    </div>

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

    <div :class="['day-grid', { dim: alwaysOn }]" :aria-disabled="alwaysOn">
      <div
        v-for="[key, label] in DAYS"
        :key="key"
        class="day-row"
        :data-test="`agent-schedule-day-${key}`"
      >
        <div class="day-toggle">
          <DanxToggle
            :model-value="dayState[key].enabled"
            :disabled="alwaysOn"
            :aria-label="`${label} enabled`"
            :data-test="`agent-schedule-${key}-enabled`"
            @update:model-value="setDayEnabled(key, $event)"
          />
          <span class="day-label">{{ label }}</span>
        </div>
        <div
          v-if="dayState[key].enabled && !alwaysOn"
          class="window-block"
          :data-test="`agent-schedule-${key}-window`"
        >
          <DanxRangeSlider
            :model-value="dayState[key].window"
            :min="MIN_OF_DAY"
            :max="MAX_OF_DAY"
            :step="STEP_MIN"
            :aria-label="`${label} window`"
            @update:model-value="setDayWindow(key, $event)"
          >
            <template #value="{ value }">{{ minutesToHHMM(value) }}</template>
          </DanxRangeSlider>
        </div>
        <div
          v-else
          class="window-block window-block-off"
          :data-test="`agent-schedule-${key}-off`"
        >
          <span class="off-text">{{ alwaysOn ? "—" : "Off" }}</span>
        </div>
      </div>
    </div>

    <p class="hint">
      24/7 master toggle wins over per-day. Per-day windows are saved on
      disk even when 24/7 is on, so flipping it back off restores them.
    </p>
  </div>
</template>

<style scoped>
.schedule {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.row-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 6px;
}
.row-toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row-toggle-title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}
.row-toggle-sub {
  font-size: 11px;
  color: #94a3b8;
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
.tz-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid #334155;
  border-radius: 4px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.day-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: opacity 0.15s ease;
}
.day-grid.dim {
  opacity: 0.45;
  pointer-events: none;
}
.day-row {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 12px;
  align-items: center;
  padding: 6px 4px;
}
.day-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.day-label {
  font-size: 12px;
  font-weight: 600;
  color: #cbd5e1;
}
.window-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.window-block-off {
  align-items: flex-start;
  justify-content: center;
  min-height: 38px;
}
.off-text {
  font-size: 12px;
  color: #64748b;
  font-style: italic;
}
.hint {
  font-size: 11px;
  color: #64748b;
  margin: 0;
}
</style>
