<script setup lang="ts">
/**
 * DX-603 — Themed hex color input + native swatch picker. In-house
 * stopgap pending promotion to `@thehammer/danx-ui` as
 * `<DanxColorPicker>` (tracked as an Action Item — see retro on DX-603).
 *
 * Contract:
 * - `v-model` carries a non-empty hex string (`#abc` or `#aabbcc`).
 * - Emits `update:modelValue` only after the operator commits a valid
 *   hex (blur OR Enter). Invalid input leaves the parent state untouched
 *   and renders the validation message inline; the operator must fix the
 *   value or revert it (Escape).
 * - The native `<input type="color">` swatch sits next to the text input
 *   and emits its `input` event with a six-char hex; we propagate that
 *   straight through on every drag so the live preview matches what the
 *   text input shows.
 *
 * Accessibility:
 * - `aria-invalid` flips when the draft fails validation; the inline
 *   error renders below the row so screen readers announce the cause.
 * - The native color input carries an `aria-label` since it has no
 *   visible label inside the row.
 *
 * Dark-mode: every color class carries a `dark:` companion, matching the
 * EffortLevelsSection input convention used elsewhere on the Settings
 * page.
 */
import { computed, ref, watch } from "vue";

const props = defineProps<{
  /** Two-way bound hex color (`#abc` or `#aabbcc`). */
  modelValue: string;
  /** Optional inline label rendered to the LEFT of the swatch. */
  label?: string;
  /** Disables both the swatch and the text input. */
  disabled?: boolean;
  /** Test-id prefix — the swatch / input / error each get `<prefix>-{swatch,input,error}`. */
  testId?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isValidHex(v: string): boolean {
  return HEX_RE.test(v);
}

/**
 * Expand `#abc` → `#aabbcc` so the native `<input type="color">` (which
 * only accepts the long form) renders the right swatch even when the
 * operator typed the short form. Falls back to the input value on
 * unrecognized shape; the caller never sees this expansion.
 */
function normalizeForSwatch(v: string): string {
  if (!isValidHex(v)) return "#000000";
  if (v.length === 4) {
    return "#" + v.slice(1).split("").map((c) => c + c).join("");
  }
  return v.toLowerCase();
}

const draft = ref<string>(props.modelValue);
const isFocused = ref<boolean>(false);
watch(
  () => props.modelValue,
  (next) => {
    // Only re-seed when the operator isn't actively typing. Without
    // this gate, an SSE-driven `modelValue` patch landing mid-edit
    // would overwrite whatever the operator has half-typed in the
    // text input — a debounced color-picker drag on a sibling row,
    // or another browser tab editing the same list, all surface as a
    // modelValue change while the operator is still composing the
    // hex they want. The blur-commit cycle re-converges state once
    // the operator leaves the input.
    if (!isFocused.value) draft.value = next;
  },
);

const isInvalid = computed<boolean>(() => draft.value.length > 0 && !isValidHex(draft.value));

const swatchValue = computed<string>(() => normalizeForSwatch(draft.value));

function onTextInput(e: Event): void {
  draft.value = (e.target as HTMLInputElement).value;
}

function onTextFocus(): void {
  isFocused.value = true;
}

function onTextBlur(): void {
  isFocused.value = false;
  onTextCommit();
}

function onTextCommit(): void {
  if (isValidHex(draft.value) && draft.value !== props.modelValue) {
    emit("update:modelValue", draft.value);
  }
}

function onTextKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    onTextCommit();
    (e.target as HTMLInputElement).blur();
  } else if (e.key === "Escape") {
    draft.value = props.modelValue;
    (e.target as HTMLInputElement).blur();
  }
}

function onSwatchInput(e: Event): void {
  const next = (e.target as HTMLInputElement).value;
  draft.value = next;
  // The native picker emits final commits AND drag events through the
  // same handler; emit on every change so the parent's draft reflects
  // the live swatch.
  if (next !== props.modelValue) emit("update:modelValue", next);
}
</script>

<template>
  <div class="flex flex-col gap-1" :data-test="testId ? `${testId}-container` : undefined">
    <div class="flex items-center gap-2">
      <span
        v-if="label"
        class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        {{ label }}
      </span>
      <input
        type="color"
        class="h-7 w-7 cursor-pointer rounded border border-gray-300 dark:border-gray-600 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
        :value="swatchValue"
        :disabled="disabled"
        :aria-label="label ? `${label} — color swatch` : 'Color swatch'"
        :data-test="testId ? `${testId}-swatch` : undefined"
        @input="onSwatchInput"
      />
      <input
        type="text"
        class="w-28 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100 disabled:opacity-50"
        :class="{ 'border-red-500 dark:border-red-500': isInvalid }"
        :value="draft"
        :disabled="disabled"
        :aria-invalid="isInvalid || undefined"
        :data-test="testId ? `${testId}-input` : undefined"
        placeholder="#aabbcc"
        @input="onTextInput"
        @focus="onTextFocus"
        @blur="onTextBlur"
        @keydown="onTextKeydown"
      />
    </div>
    <p
      v-if="isInvalid"
      class="text-[11px] text-red-600 dark:text-red-300"
      :data-test="testId ? `${testId}-error` : undefined"
    >
      Must be a hex color like #abc or #aabbcc.
    </p>
  </div>
</template>
