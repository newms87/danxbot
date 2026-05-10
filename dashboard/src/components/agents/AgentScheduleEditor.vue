<script setup lang="ts">
/**
 * AgentScheduleEditor — DX-247 temp impl.
 *
 * Renders the agent schedule with a 24/7 master toggle and per-day
 * on/off + window controls. The 24/7 toggle binds to
 * `schedule.always_on`; toggling it does NOT clear per-day arrays — the
 * data is preserved on disk so flipping 24/7 back off restores the
 * exact prior windows.
 *
 * Per-day model:
 *   - `enabled`  ↔ `windows.length > 0` (single-window UI)
 *   - `startMin` / `endMin`  ↔ `windows[0]` parsed as `HH:MM-HH:MM`
 *   - When `enabled` is toggled OFF we cache the prior window in a
 *     local map so toggling back ON restores it instead of jumping to
 *     a default. This caching is in-memory only; on remount or save
 *     the canonical state is the on-disk array.
 *
 * Multi-window legacy data: this UI authors only single-window arrays.
 * A schedule with two or more windows for a day still round-trips
 * correctly (we only edit `windows[0]` and leave the rest untouched)
 * but the extra entries are not visible — operators with such
 * configurations will see them disappear if they edit and save the
 * day. Acceptable for the temp UI; the swap to `DanxRangeSlider`
 * (DX-251) keeps the same single-window assumption.
 *
 * Time of day is encoded as minutes-of-day [0, 1440] so the dual
 * range can step in 15-minute increments without floating-point
 * drift. `1440` displays as `24:00` even though the regex caps at
 * `23:59`; on save we clamp the end to `23:59` so the persisted
 * value matches `SCHEDULE_WINDOW_SHAPE`.
 */
import { computed, reactive } from "vue";
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
const MAX_OF_DAY = 1440; // 24:00 sentinel for slider; clamped to 23:59 on save.
const DEFAULT_START = 540; // 09:00
const DEFAULT_END = 1020; // 17:00
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function clampHour(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_START;
  if (n < MIN_OF_DAY) return MIN_OF_DAY;
  if (n > MAX_OF_DAY) return MAX_OF_DAY;
  return Math.round(n / STEP_MIN) * STEP_MIN;
}

function minutesToHHMM(n: number): string {
  // Cap display at 23:59 so the formatted persisted shape passes the
  // backend regex (`SCHEDULE_WINDOW_SHAPE` rejects `24:00`). The slider
  // can still report 1440 internally; we clamp at format time.
  const clamped = Math.min(Math.max(Math.round(n), 0), 1439);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface ParsedWindow {
  startMin: number;
  endMin: number;
}

function parseFirstWindow(windows: string[]): ParsedWindow | null {
  const w = windows[0];
  if (!w) return null;
  const m = WINDOW_RE.exec(w);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  return { startMin, endMin };
}

// Per-day in-memory cache of the last edited window. Used so toggling a
// day OFF then back ON restores the operator's working values instead
// of snapping to the 9-5 default. Keyed by day; populated lazily.
const windowCache = reactive<Record<Day, ParsedWindow>>({
  mon: { startMin: DEFAULT_START, endMin: DEFAULT_END },
  tue: { startMin: DEFAULT_START, endMin: DEFAULT_END },
  wed: { startMin: DEFAULT_START, endMin: DEFAULT_END },
  thu: { startMin: DEFAULT_START, endMin: DEFAULT_END },
  fri: { startMin: DEFAULT_START, endMin: DEFAULT_END },
  sat: { startMin: DEFAULT_START, endMin: DEFAULT_END },
  sun: { startMin: DEFAULT_START, endMin: DEFAULT_END },
});

// Hydrate cache from current model on first read so an existing
// disabled-day with cached windows shows the right starting values
// when re-enabled. Runs once per render via computed.
const dayState = computed(() => {
  return DAYS.reduce(
    (acc, [key]) => {
      const parsed = parseFirstWindow(props.modelValue[key]);
      if (parsed) {
        windowCache[key] = parsed;
      }
      acc[key] = {
        enabled: props.modelValue[key].length > 0,
        window: parsed ?? windowCache[key],
      };
      return acc;
    },
    {} as Record<Day, { enabled: boolean; window: ParsedWindow }>,
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

function formatWindowString(startMin: number, endMin: number): string {
  return `${minutesToHHMM(startMin)}-${minutesToHHMM(endMin)}`;
}

function setDay(day: Day, windows: string[]): void {
  emit("update:modelValue", { ...props.modelValue, [day]: windows });
}

function toggleDay(day: Day, enabled: boolean): void {
  if (enabled) {
    const cached = windowCache[day];
    setDay(day, [formatWindowString(cached.startMin, cached.endMin)]);
  } else {
    setDay(day, []);
  }
}

function updateStart(day: Day, raw: string): void {
  const v = clampHour(Number(raw));
  const cur = dayState.value[day].window;
  // Don't let start cross past end. Bump end up by one step if it would.
  const startMin = Math.min(v, cur.endMin - STEP_MIN);
  const safeStart = Math.max(MIN_OF_DAY, startMin);
  const next: ParsedWindow = { startMin: safeStart, endMin: cur.endMin };
  windowCache[day] = next;
  setDay(day, [formatWindowString(next.startMin, next.endMin)]);
}

function updateEnd(day: Day, raw: string): void {
  const v = clampHour(Number(raw));
  const cur = dayState.value[day].window;
  const endMin = Math.max(v, cur.startMin + STEP_MIN);
  const safeEnd = Math.min(MAX_OF_DAY, endMin);
  const next: ParsedWindow = { startMin: cur.startMin, endMin: safeEnd };
  windowCache[day] = next;
  setDay(day, [formatWindowString(next.startMin, next.endMin)]);
}

function fillPercent(day: Day): { left: string; width: string } {
  const w = dayState.value[day].window;
  const left = (w.startMin / MAX_OF_DAY) * 100;
  const width = ((w.endMin - w.startMin) / MAX_OF_DAY) * 100;
  return { left: `${left}%`, width: `${width}%` };
}
</script>

<template>
  <div class="schedule">
    <label class="row-toggle" data-test="agent-schedule-always-on-row">
      <input
        v-model="alwaysOn"
        type="checkbox"
        class="cb cb-master"
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
    </label>

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
        <label class="day-toggle">
          <input
            type="checkbox"
            class="cb"
            :checked="dayState[key].enabled"
            :disabled="alwaysOn"
            :data-test="`agent-schedule-${key}-enabled`"
            @change="toggleDay(key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="day-label">{{ label }}</span>
        </label>
        <div
          v-if="dayState[key].enabled && !alwaysOn"
          class="window-block"
        >
          <div class="window-label">
            <span class="hh">{{ minutesToHHMM(dayState[key].window.startMin) }}</span>
            <span class="dash">—</span>
            <span class="hh">{{ minutesToHHMM(dayState[key].window.endMin) }}</span>
          </div>
          <div class="slider-stack">
            <div class="track">
              <div class="track-fill" :style="fillPercent(key)"></div>
            </div>
            <input
              type="range"
              :min="MIN_OF_DAY"
              :max="MAX_OF_DAY"
              :step="STEP_MIN"
              :value="dayState[key].window.startMin"
              class="range range-start"
              :aria-label="`${label} start`"
              :data-test="`agent-schedule-${key}-start`"
              @input="updateStart(key, ($event.target as HTMLInputElement).value)"
            />
            <input
              type="range"
              :min="MIN_OF_DAY"
              :max="MAX_OF_DAY"
              :step="STEP_MIN"
              :value="dayState[key].window.endMin"
              class="range range-end"
              :aria-label="`${label} end`"
              :data-test="`agent-schedule-${key}-end`"
              @input="updateEnd(key, ($event.target as HTMLInputElement).value)"
            />
          </div>
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
      24/7 master toggle wins over per-day. Per-day windows are saved on disk even when 24/7 is on, so flipping it back off restores them.
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
  cursor: pointer;
}
.row-toggle:hover {
  border-color: #334155;
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
.cb {
  accent-color: #60a5fa;
  margin-top: 2px;
  cursor: pointer;
}
.cb-master {
  width: 16px;
  height: 16px;
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
  cursor: pointer;
}
.day-toggle:has(input:disabled) {
  cursor: not-allowed;
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
.window-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #93c5fd;
}
.dash {
  color: #475569;
}
.slider-stack {
  position: relative;
  height: 28px;
}
.track {
  position: absolute;
  top: 12px;
  left: 0;
  right: 0;
  height: 4px;
  background: #1e293b;
  border-radius: 2px;
}
.track-fill {
  position: absolute;
  top: 0;
  height: 100%;
  background: #2563eb;
  border-radius: 2px;
}
.range {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  width: 100%;
  appearance: none;
  background: transparent;
  pointer-events: none;
  margin: 0;
  height: 28px;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  pointer-events: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f1f5f9;
  border: 2px solid #2563eb;
  cursor: grab;
}
.range::-webkit-slider-thumb:active {
  cursor: grabbing;
}
.range::-moz-range-thumb {
  pointer-events: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f1f5f9;
  border: 2px solid #2563eb;
  cursor: grab;
}
.range::-webkit-slider-runnable-track {
  background: transparent;
}
.range::-moz-range-track {
  background: transparent;
}
.range:focus {
  outline: none;
}
.range:focus::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.4);
}
.hint {
  font-size: 11px;
  color: #64748b;
  margin: 0;
}
</style>
