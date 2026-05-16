# Handoff — `DanxEditableDiv` for `@thehammer/danx-ui`

Reference implementation lives at
`~/web/quasar-ui-danx/ui/src/components/ActionTable/Form/Fields/EditableDiv.vue`
(Quasar-era). This handoff ports it to danx-ui conventions and folds in
the features missing from the original.

## Goal

One inline-edit primitive the dashboard can drop in anywhere a string
field is rendered as text and made editable on focus — title rows, table
cells, sidebar labels — without forking a custom click-to-edit affordance
each time. Replaces the bespoke title-editor in
`dashboard/src/components/issues/DrawerHeader.vue` and equivalents.

## Public API

```ts
interface DanxEditableDivProps {
  /** Two-way bound value. Plain text, NOT html. */
  modelValue: string;

  /** Disable edit; component renders inert text. */
  readonly?: boolean;

  /** Shown when modelValue is empty AND not focused. */
  placeholder?: string;

  /** "single" disables Enter (commits on Enter). "multi" allows newlines. Default "single". */
  mode?: "single" | "multi";

  /** Max length in characters. UI clamps + emits "invalid" instead of update. */
  maxLength?: number;

  /** Min length. Empty values rejected when set ≥ 1. */
  minLength?: number;

  /** Sync custom validator. Return null = OK, string = error message. */
  validate?: (next: string) => string | null;

  /**
   * Commit strategy:
   *  - "blur"   (default): emit on blur + Enter (single) / Ctrl+Enter (multi)
   *  - "debounce": emit on every keystroke after `debounceMs` of quiet
   *  - "manual": never auto-emit — caller drives via exposed `commit()`
   */
  commit?: "blur" | "debounce" | "manual";

  /** Debounce delay when commit="debounce". Default 400. */
  debounceMs?: number;

  /** Show a spinner overlay (caller-controlled — set during PATCH). */
  saving?: boolean;

  /** Visual size. Default "md". */
  size?: "sm" | "md" | "lg";

  /** Inline (default) vs block layout. Block stretches to container width. */
  layout?: "inline" | "block";

  /** Element tag for the editable surface. Default "div". Useful for `h1`/`h2`. */
  as?: "div" | "span" | "h1" | "h2" | "h3" | "p";

  /** Extra class(es) merged onto the editable surface. */
  contentClass?: string | string[] | Record<string, boolean>;

  /** Test id for the editable surface. */
  dataTest?: string;
}

interface DanxEditableDivEmits {
  /** Fires on commit (per the strategy). NOT on every keystroke unless commit="debounce". */
  (e: "update:modelValue", value: string): void;

  /** Edit committed AND value actually changed (no-op edits suppressed). */
  (e: "change", value: string): void;

  /** Edit cancelled via Escape — value reverted, NO update emitted. */
  (e: "cancel"): void;

  /** Validation failed — message is the validator return OR a built-in (length, required). */
  (e: "invalid", message: string): void;

  /** Focus + blur passthrough. */
  (e: "focus"): void;
  (e: "blur"): void;
}

interface DanxEditableDivExpose {
  /** Programmatically focus the surface. selectAll defaults true. */
  focus(selectAll?: boolean): void;

  /** Force a commit with the current buffer (honors validate). */
  commit(): void;

  /** Cancel the in-flight edit, restore modelValue, blur. */
  cancel(): void;
}
```

## Behaviour spec

**Source of truth.** `modelValue` is the committed value. Internal
buffer tracks the in-flight edit so external `modelValue` updates
(SSE patch arrives mid-edit) do NOT clobber the user's typing — only
apply external updates when the surface is NOT focused.

**Commit triggers (commit="blur").**
- Blur → validate → emit `update:modelValue` + `change` (if changed).
- `Enter` in `mode="single"` → prevent newline, commit + blur.
- `Ctrl+Enter` / `Cmd+Enter` in `mode="multi"` → commit + blur.
- `Escape` → revert buffer to `modelValue`, blur, emit `cancel`.

**Commit triggers (commit="debounce").**
- Every keystroke schedules `debounceMs` timer. On fire → validate →
  emit. No blur required.
- Enter / Escape still fire commit + cancel respectively.

**Validation.** Order: required (minLength≥1) → maxLength → custom
`validate`. On invalid: do NOT emit `update:modelValue`, do emit
`invalid` with the message, render an error ring (red 1px outline)
+ leave buffer dirty so the user can fix without losing input.

**Single-line mode.** Strip pasted newlines on `paste` event before
they hit the DOM. Newline characters typed via IME → suppress.

**Saving state.** When `:saving="true"`, render a translucent overlay
+ spinner glyph (DanxIcon). Surface stays focused; keystrokes
accepted but commits queue until `saving` goes false (caller's PATCH
resolves → flips saving → next commit lands).

**Accessibility.**
- `role="textbox"`, `aria-multiline` matches `mode`.
- `aria-invalid` when validation fails.
- `aria-readonly` when `readonly`.
- Keyboard focusable via Tab; Enter/Space activate edit (see below).
- Screen reader announces placeholder when empty.

**Focus model.** The surface is `contenteditable` whenever
`!readonly`. Tabbing into it lands on the contenteditable surface;
no separate "enter edit mode" step. This is the critical departure
from the bespoke click-to-edit pattern — there is no hover-pencil,
no click-to-focus dance, just a focusable text region that happens
to be editable.

**Dark mode.** Use CSS custom properties from danx-ui's theme tokens
— surface bg/text/ring colors resolve via `--danx-color-*` vars so
the existing dark-mode toggle works without per-consumer Tailwind
safelisting. The Quasar original's `color`/`textColor` props and
`tailwind.config.js` safelist requirement are DROPPED.

**Empty-state UX.** When `modelValue` is empty and not focused,
render the placeholder in muted text inside the surface — never
absolutely-positioned overlay (the Quasar original's
`absolute-top-left` placeholder is a layout-fragility class we want
to avoid).

**Disabled vs readonly.**
- `readonly` → inert text, no cursor change, no edit affordance.
  Tab still focuses for screen-reader read.
- `disabled` (NOT in props — caller wraps via parent state) is not
  modeled separately; `readonly` is the only inert state.

## Visual

- Resting: text only, no border, no background.
- Hover (not readonly): subtle 1px ring + bg tint via `--danx-color-surface-hover`.
- Focus: 2px ring `--danx-color-primary`, bg `--danx-color-surface-elevated`.
- Invalid: 1px ring `--danx-color-danger`, even when blurred — until next valid commit.
- Saving: 50% opacity + centered spinner glyph.

## Test surface

The danx-ui repo's vitest harness should cover:

1. Commits on blur (default).
2. Enter commits in single mode; does NOT in multi mode.
3. Ctrl+Enter commits in multi mode.
4. Escape reverts buffer + emits `cancel`, no `update:modelValue`.
5. Paste with newlines in single mode strips them.
6. `validate` returning a string blocks commit + emits `invalid`.
7. External `modelValue` change applies when blurred, does NOT clobber while focused.
8. `:saving="true"` queues commits until cleared.
9. `focus(true)` selects all text.
10. `readonly` suppresses editing + hover affordance.

## Files to add / modify in danx-ui

- `src/components/editable-div/DanxEditableDiv.vue` — the component.
- `src/components/editable-div/index.ts` — re-export.
- `src/components/editable-div/DanxEditableDiv.test.ts` — vitest spec.
- `src/index.ts` — add `export { DanxEditableDiv } from "./components/editable-div";`.
- `src/styles/tokens.css` (or wherever danx-ui's CSS vars live) — confirm tokens used above exist; add any missing.

## Out of scope (consumers handle)

- Async validation (debounced API calls). Use sync `validate` + caller PATCH.
- Rich-text formatting. This is plain text; for markdown use `MarkdownEditor`.
- Auto-resize for `mode="multi"`. Caller sets a `max-height` + CSS overflow if needed; the component does not measure or animate height.

## Consumer migration (danxbot dashboard)

After publish:

```vue
<!-- before: bespoke click-to-edit in DrawerHeader.vue -->
<h2 v-if="!editing" @click="startEdit">{{ issue.title }}</h2>
<input v-else v-model="draft" @blur="commit" @keydown="onKeydown" />

<!-- after -->
<DanxEditableDiv
  :model-value="issue.title"
  :saving="titleSaving"
  as="h2"
  size="lg"
  mode="single"
  :min-length="1"
  data-test="drawer-title"
  @update:model-value="onTitleCommit"
/>
```

State management around `titleSaving` + the PATCH call stays in the
consumer; the component is presentational + interaction-only.
