<script setup lang="ts">
/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): right-side drawer showing
 * one `system_errors` row plus the full repair-attempt history. Two
 * operator actions exposed: Retry (POST .../reset) flips the row back
 * to `open` and clears attempts; Mark Unfixable (POST .../unfixable)
 * is the manual override.
 *
 * The drawer reads its data from the row prop the parent passes — the
 * SSE-driven composable keeps that prop in sync, so a successful
 * operator action's effect (status flip, attempts cleared) renders
 * instantly without a refetch.
 */
import { computed, ref } from "vue";
import {
  CodeViewer,
  DanxButton,
  DanxScroll,
  DanxTooltip,
  MarkdownEditor,
} from "@thehammer/danx-ui";
import {
  markRepairErrorUnfixable,
  resetRepairErrorById,
} from "../../api";
import type {
  RepairErrorWithAttempts,
  SystemErrorRepairRow,
} from "../../types";

const props = defineProps<{
  row: RepairErrorWithAttempts;
}>();

const emit = defineEmits<{
  close: [];
}>();

const acting = ref<"reset" | "unfixable" | null>(null);
const actionError = ref<string | null>(null);

const samplePayloadJson = computed<string>(() =>
  JSON.stringify(props.row.error.sample_payload, null, 2),
);

const isUnfixable = computed(() => props.row.error.status === "unfixable");
const isAtCap = computed(() => props.row.attempts.length >= 3);

async function runAction(
  kind: "reset" | "unfixable",
  fn: (id: number) => Promise<unknown>,
): Promise<void> {
  if (acting.value) return;
  acting.value = kind;
  actionError.value = null;
  try {
    await fn(props.row.error.id);
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    acting.value = null;
  }
}

function onReset(): Promise<void> {
  return runAction("reset", resetRepairErrorById);
}

function onMarkUnfixable(): Promise<void> {
  return runAction("unfixable", markRepairErrorUnfixable);
}

function attemptTitle(a: SystemErrorRepairRow): string {
  const parts = [`Attempt ${a.attempt_n}`];
  if (a.card_id) parts.push(a.card_id);
  if (a.verdict) parts.push(a.verdict);
  return parts.join(" · ");
}
</script>

<template>
  <div
    class="fixed top-0 right-0 h-screen w-full max-w-[640px] bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col"
    data-testid="self-repair-drawer"
  >
    <div class="border-b border-slate-800 p-4 flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-[11px] uppercase tracking-wider text-slate-500">
          {{ row.error.category_key }}
        </div>
        <div class="text-slate-200 font-medium break-words mt-1">
          {{ row.error.normalized_msg }}
        </div>
        <div class="mt-2 flex items-center gap-3 text-xs text-slate-400">
          <span>count: <span class="text-slate-200 font-mono">{{ row.error.count }}</span></span>
          <span>status:
            <span
              class="inline-block px-2 rounded-full font-semibold"
              :data-testid="`drawer-status-${row.error.status}`"
            >{{ row.error.status }}</span>
          </span>
          <span>repo: <span class="text-slate-200">{{ row.error.repo }}</span></span>
          <span>attempts: <span class="text-slate-200 font-mono">{{ row.attempts.length }}</span></span>
        </div>
      </div>
      <DanxTooltip tooltip="Close">
        <template #trigger>
          <DanxButton size="sm" icon="cancel" aria-label="Close" @click="emit('close')" />
        </template>
      </DanxTooltip>
    </div>

    <DanxScroll class="flex-1 min-h-0 p-4 space-y-4">
      <section>
        <h3 class="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
          Sample payload
        </h3>
        <CodeViewer
          :model-value="samplePayloadJson"
          format="json"
          theme="dark"
          hide-footer
        />
      </section>

      <section>
        <h3 class="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
          Repair history
        </h3>
        <div v-if="row.attempts.length === 0" class="text-sm text-slate-500">
          No repair attempts logged yet.
        </div>
        <ul v-else class="space-y-3">
          <li
            v-for="a in row.attempts"
            :key="a.id"
            class="border border-slate-800 rounded-md p-3"
            data-testid="self-repair-attempt"
          >
            <div class="flex items-center gap-3 text-xs text-slate-400">
              <span class="text-slate-200 font-medium">{{ attemptTitle(a) }}</span>
              <span v-if="a.dispatch_id" class="font-mono">{{ a.dispatch_id.slice(0, 8) }}</span>
            </div>
            <div v-if="a.report_md" class="mt-2">
              <MarkdownEditor :model-value="a.report_md" readonly />
            </div>
          </li>
        </ul>
      </section>
    </DanxScroll>

    <div class="border-t border-slate-800 p-4 space-y-2">
      <div v-if="actionError" class="text-sm text-red-300">{{ actionError }}</div>
      <div class="flex items-center gap-2">
        <DanxTooltip
          :tooltip="isAtCap ? 'Cleared 3-attempt history; pipeline will retry on next tick.' : 'Clears repair history and flips status back to open.'"
        >
          <template #trigger>
            <DanxButton
              size="sm"
              variant="primary"
              icon="refresh"
              :disabled="acting !== null"
              :class="{ 'opacity-70': acting === 'reset' }"
              data-testid="self-repair-retry"
              @click="onReset"
            >
              Retry
            </DanxButton>
          </template>
        </DanxTooltip>
        <DanxTooltip
          :tooltip="isUnfixable ? 'Already marked unfixable.' : 'Mark this signature as unfixable; pipeline will skip it.'"
        >
          <template #trigger>
            <DanxButton
              size="sm"
              variant="danger"
              icon="cancel"
              :disabled="acting !== null || isUnfixable"
              data-testid="self-repair-unfixable"
              @click="onMarkUnfixable"
            >
              Mark unfixable
            </DanxButton>
          </template>
        </DanxTooltip>
      </div>
    </div>
  </div>
</template>
