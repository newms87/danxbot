<script setup lang="ts">
/**
 * DX-632 (Phase 6 of DX-626 — Priority cascade + epic-move cascade dialog).
 *
 * Operator-facing dialog for moving any card with `children.length > 0`.
 * The parent (`IssuesPage.onMove`) BFS-flattens the descendants + computes
 * the pre-view of per-descendant default actions, then opens this dialog.
 * The operator can override any row's action, must confirm clearing
 * blocks on blocked descendants, and (when dest is a blocked-type list)
 * must supply a reason. Submit emits the overrides + flags; the parent
 * builds the cascade PATCH body and calls
 * `useIssues.cascadeIssueList(epicId, body)`.
 *
 * DX-659 (Phase 3) — Blocked is now a dispatch gate, not a list type.
 * Cascade routing for blocked transitions retired; this dialog only
 * fires for children-bearing list moves. Single-card "Mark Blocked"
 * lives in `BlockedReasonDialog`, wired into `DrawerHeader`.
 *
 * DanxUI mandate: shell is `DanxDialog`, per-row dropdown is
 * `DanxSelect`. Layout is plain `<div>` / `<label>` (structural /
 * semantic HTML, not branded primitives).
 */
import { computed, ref, watch } from "vue";
import { DanxDialog, DanxSelect, DanxTooltip } from "@thehammer/danx-ui";
import type { CascadeAction } from "../../api";
import type { IssueListItem, List } from "../../types";
import { deriveListTypeFromStatus } from "../../composables/derive-status";

const props = defineProps<{
  /** Open / close (v-model). */
  modelValue: boolean;
  /** Card being moved — its `id` headlines the dialog. */
  parent: IssueListItem;
  /** Target list the operator dropped the parent onto. */
  destList: List;
  /** BFS-flattened descendants — caller's responsibility. */
  descendants: IssueListItem[];
  /**
   * Pre-computed default `CascadeAction` per descendant id. The dialog
   * displays "Apply default" pre-selected; the actual action behind
   * "default" is this map's value. Picking "Apply default" elides the
   * row from the emitted `overrides` so the server re-derives via the
   * cascade helper's spec table.
   */
  defaults: Record<string, CascadeAction>;
  /** Every per-repo list — used for the "Move to…" sub-options. */
  allLists: List[];
  /** Bubble parent's in-flight PATCH state so submit is gated. */
  busy?: boolean;
  /** Server error from the parent's last attempt. */
  error?: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  /**
   * Operator confirmed. Parent builds the cascade body, calls
   * `cascadeIssueList`. `overrides` carries ONLY the rows the operator
   * actively diverted from the spec default — the server's helper
   * supplies the default action for any descendant id NOT in this map.
   */
  confirm: [
    payload: {
      overrides: Record<string, CascadeAction>;
    },
  ];
  /** Operator cancelled — parent reverts any optimistic UI + closes. */
  cancel: [];
}>();

/** Per-row dropdown encoding. */
const ACTION_DEFAULT = "default";
const ACTION_STAY = "stay";
const ACTION_MOVE_PREFIX = "move:";

/** Operator's per-row selection. Initialised to "default" for every row. */
const selections = ref<Record<string, string>>(
  Object.fromEntries(props.descendants.map((d) => [d.id, ACTION_DEFAULT])),
);

/**
 * Re-seed `selections` if the descendants list changes while the
 * dialog is mounted (e.g. operator changes the destination then re-opens).
 * Preserves any rows whose ids carry over.
 */
watch(
  () => props.descendants,
  (next) => {
    const carry = selections.value;
    selections.value = Object.fromEntries(
      next.map((d) => [d.id, carry[d.id] ?? ACTION_DEFAULT]),
    );
  },
);

/** Reset state on every reopen. */
watch(
  () => props.modelValue,
  (next) => {
    if (next) {
      selections.value = Object.fromEntries(
        props.descendants.map((d) => [d.id, ACTION_DEFAULT]),
      );
    }
  },
);

const canSubmit = computed<boolean>(() => {
  if (props.busy) return false;
  return true;
});

interface DescendantGroup {
  parentId: string;
  rows: IssueListItem[];
}

/**
 * BFS-grouped rows keyed by direct `parent_id`. Group order = first-
 * appearance order in `descendants[]`. Within group, sort by
 * `priority` DESC (matching the board's column sort). Descendants
 * with `parent_id === null` (orphans — defensive) bucket under a
 * `"(orphan)"` group.
 */
const descendantGroups = computed<DescendantGroup[]>(() => {
  const groupsByParent = new Map<string, IssueListItem[]>();
  const order: string[] = [];
  for (const d of props.descendants) {
    const key = d.parent_id ?? "(orphan)";
    if (!groupsByParent.has(key)) {
      groupsByParent.set(key, []);
      order.push(key);
    }
    groupsByParent.get(key)!.push(d);
  }
  return order.map<DescendantGroup>((parentId) => {
    const rows = [...groupsByParent.get(parentId)!];
    rows.sort((a, b) => {
      const pa = typeof a.priority === "number" ? a.priority : 0;
      const pb = typeof b.priority === "number" ? b.priority : 0;
      return pb - pa;
    });
    return { parentId, rows };
  });
});

/** Affected card count = parent + descendants whose action is not "stay". */
const affectedCount = computed<number>(() => {
  let n = 1; // the parent itself
  for (const d of props.descendants) {
    const resolved = resolveAction(d.id);
    if (resolved.kind !== "stay") n += 1;
  }
  return n;
});

function resolveAction(id: string): CascadeAction {
  const sel = selections.value[id] ?? ACTION_DEFAULT;
  if (sel === ACTION_DEFAULT) return props.defaults[id] ?? { kind: "move_same_type" };
  if (sel === ACTION_STAY) return { kind: "stay" };
  if (sel.startsWith(ACTION_MOVE_PREFIX)) {
    const listId = sel.slice(ACTION_MOVE_PREFIX.length);
    const list = props.allLists.find((l) => l.id === listId);
    if (!list) return props.defaults[id] ?? { kind: "move_same_type" };
    return { kind: "move_to", listType: list.type, listName: list.name };
  }
  return { kind: "move_same_type" };
}

/**
 * Project the descendant's current list name from its derived status
 * (per DX-639 / the `no-raw-list-name` guard). Reading the raw
 * `list_name` field is forbidden — the denormalized field is a
 * tracker round-trip carrier, not a render source. IssueListItem
 * carries `status` directly, so map status → ListType → default
 * list of that type from the per-repo taxonomy.
 */
function currentListName(row: IssueListItem): string {
  const type = deriveListTypeFromStatus(row.status);
  const def = props.allLists.find((l) => l.is_default_for_type && l.type === type);
  return def?.name ?? "—";
}

/**
 * Single rendering of a `CascadeAction` to a human label. `fallbackName`
 * is what `move_same_type` displays (the parent's dest list name OR the
 * descendant's per-row dest preview). Used by both the row's right-most
 * dest column and the dropdown's "Apply default (…)" sub-label so the
 * mapping lives in one place.
 */
function formatAction(action: CascadeAction, fallbackName: string): string {
  if (action.kind === "stay") return "Stay";
  if (action.kind === "move_to") return action.listName;
  return `Move to ${fallbackName}`;
}

function destLabel(id: string): string {
  const a = resolveAction(id);
  // The row's right-most "→ X" cell. `formatAction` returns "Move to X"
  // for the move_same_type branch; the row already prints "→", so strip
  // the redundant verb for that cell.
  const label = formatAction(a, props.destList.name);
  return label.startsWith("Move to ") ? label.slice("Move to ".length) : label;
}

/** Options for a single row's `DanxSelect`. */
function actionOptions(id: string): Array<{ value: string; label: string }> {
  const def = props.defaults[id] ?? { kind: "move_same_type" };
  const defaultLabel = formatAction(def, props.destList.name);
  const opts: Array<{ value: string; label: string }> = [
    { value: ACTION_DEFAULT, label: `Apply default (${defaultLabel})` },
    { value: ACTION_STAY, label: "Stay" },
  ];
  for (const list of props.allLists) {
    opts.push({ value: `${ACTION_MOVE_PREFIX}${list.id}`, label: `Move to ${list.name}` });
  }
  return opts;
}

function onSubmit(): void {
  if (!canSubmit.value) return;
  const overrides: Record<string, CascadeAction> = {};
  for (const d of props.descendants) {
    const sel = selections.value[d.id] ?? ACTION_DEFAULT;
    if (sel === ACTION_DEFAULT) continue;
    overrides[d.id] = resolveAction(d.id);
  }
  emit("confirm", { overrides });
}

function onCancel(): void {
  emit("cancel");
  emit("update:modelValue", false);
}
</script>

<template>
  <DanxDialog
    :model-value="props.modelValue"
    :title="`Move ${props.parent.id} → ${props.destList.name}`"
    width="720px"
    :close-button="'Cancel'"
    :confirm-button="props.busy ? 'Saving…' : `Confirm cascade (${affectedCount} cards)`"
    :is-saving="props.busy"
    :disabled="!canSubmit"
    persistent
    @close="onCancel"
    @confirm="onSubmit"
    @update:model-value="(v: boolean) => { if (!v) onCancel(); }"
  >
    <div class="body" data-test="cascade-dialog-body">
      <p class="summary">
        Moving <strong>{{ props.parent.id }}</strong> — {{ props.parent.title }}
        to <strong>{{ props.destList.name }}</strong>. Review per-descendant
        actions below, then confirm.
      </p>

      <div
        v-for="group in descendantGroups"
        :key="group.parentId"
        class="group"
        data-test="cascade-group"
        :data-parent-id="group.parentId"
      >
        <div
          class="group-header"
          data-test="cascade-group-header"
        >
          Under {{ group.parentId }} — {{ group.rows.length }} descendant{{
            group.rows.length === 1 ? "" : "s"
          }}
        </div>
        <div
          v-for="row in group.rows"
          :key="row.id"
          class="row"
          data-test="cascade-row"
          :data-row-id="row.id"
        >
          <span class="id-chip">{{ row.id }}</span>
          <DanxTooltip :tooltip="row.title">
            <template #trigger>
              <span class="row-title">{{ row.title }}</span>
            </template>
          </DanxTooltip>
          <span class="current-list">
            {{ currentListName(row) }}
            <span class="list-tag">{{ row.status }}</span>
          </span>
          <span class="arrow">→</span>
          <DanxSelect
            :model-value="selections[row.id]"
            :options="actionOptions(row.id)"
            data-test="cascade-action-select"
            :data-row-id="row.id"
            @update:model-value="(v: string | number | (string | number)[] | null) => {
              if (typeof v === 'string') selections[row.id] = v;
            }"
          />
          <span class="dest-label" data-test="cascade-dest-label">
            {{ destLabel(row.id) }}
          </span>
        </div>
      </div>

      <p
        v-if="props.error"
        class="error"
        data-test="cascade-dialog-error"
      >{{ props.error }}</p>
    </div>
  </DanxDialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  color: #cbd5e1;
}
.summary {
  margin: 0;
  line-height: 1.4;
}
.banner {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
}
.banner-unblock {
  background: rgb(251 191 36 / 0.08);
  border: 1px solid rgb(251 191 36 / 0.32);
  color: #fde68a;
}
.banner-blocked-reason {
  background: rgb(239 68 68 / 0.08);
  border: 1px solid rgb(239 68 68 / 0.28);
  color: #fca5a5;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.banner-text {
  margin: 0 0 8px;
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.field-label {
  font-weight: 600;
  color: #fdba74;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid rgb(51 65 85 / 0.6);
}
.group:first-of-type {
  border-top: 0;
  padding-top: 0;
}
.group-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
  margin-bottom: 4px;
}
.row {
  display: grid;
  grid-template-columns: auto 1fr auto auto minmax(180px, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
}
.row:hover {
  background: rgb(30 41 59 / 0.4);
}
.id-chip {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  padding: 1px 5px;
  background: rgb(99 102 241 / 0.18);
  border-radius: 3px;
  color: #c7d2fe;
}
.row-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e2e8f0;
}
.current-list {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #94a3b8;
}
.list-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: rgb(51 65 85 / 0.6);
  color: #cbd5e1;
  font-size: 10px;
}
.arrow {
  color: #64748b;
}
.dest-label {
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
}
.error {
  margin: 0;
  padding: 6px 8px;
  font-size: 11px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.12);
  border: 1px solid rgb(239 68 68 / 0.3);
  border-radius: 4px;
}
</style>
