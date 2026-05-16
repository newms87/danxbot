<script setup lang="ts">
/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): operator-facing tab that
 * renders the persistent `system_errors` + `system_error_repairs`
 * tables. Live updates flow through `useSelfRepairErrors` (SSE topic
 * `system-repair-error:updated`); no `setInterval`, no polling.
 *
 * UX:
 *   - Top-of-tab red banner when any row is `unfixable` (count badge
 *     surfaces the cap-hit class so operators see it without scrolling).
 *   - Table ordered count DESC, last_seen DESC — same ranking the
 *     dispatcher uses; the top row is what the pipeline picks next.
 *   - Click a row to open the drawer (sample payload, attempts,
 *     verdicts, operator actions).
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { DanxButton, DanxScroll, DanxTooltip } from "@thehammer/danx-ui";
import { useNowTick } from "../../composables/useNowTick";
import { useSelfRepairErrors } from "../../composables/useSelfRepairErrors";
import type {
  RepairErrorWithAttempts,
  SystemErrorStatus,
} from "../../types";
import SelfRepairDrawer from "./SelfRepairDrawer.vue";

const props = defineProps<{
  selectedRepo: string;
}>();

const {
  errors,
  loading,
  error,
  selectedRepo,
  unfixableCount,
  init,
  destroy,
  refresh,
} = useSelfRepairErrors();

/**
 * DX-566 Phase 6 — distinguish the two "why unfixable" cases the
 * pipeline can produce:
 *   - Recurrence-based: the row's `recurrence_count >= 3` (the
 *     `recordError` ON CONFLICT path flipped it straight to unfixable
 *     because the agent kept claiming a fix and the producer kept
 *     re-emitting the signature).
 *   - Agent-declared / 3-attempt cap: `recurrence_count < 3` — either
 *     the agent self-declared `unfixable`, or `finalizeSelfRepair`
 *     applied the cap on the 3rd failed attempt.
 * The operator needs to tell these apart because the right next move
 * differs: recurrence-based wants a deeper look at why the fix didn't
 * stick; cap-based wants a manual repair attempt or a Mark Unfixable
 * confirmation.
 */
/**
 * Mirrors `REPAIR_CAP` in `src/system-repair/types.ts`. Kept as a local
 * literal because the SPA does not import backend runtime constants
 * (only types). If the backend cap moves, update this literal in the
 * same commit — there is no cross-process import to enforce lockstep.
 */
const RECURRENCE_CAP = 3;

function unfixableReason(row: RepairErrorWithAttempts): "recurrence" | "agent-or-cap" {
  return row.error.recurrence_count >= RECURRENCE_CAP ? "recurrence" : "agent-or-cap";
}

function unfixableBadgeTooltip(row: RepairErrorWithAttempts): string {
  return unfixableReason(row) === "recurrence"
    ? `Unfixable due to recurrence — agent claimed a fix but the producer re-emitted the signature ${row.error.recurrence_count} times.`
    : "Unfixable — agent self-declared OR 3 repair attempts exhausted without a fix.";
}

const unfixableBreakdown = computed<{ recurrence: number; agentOrCap: number }>(() => {
  let recurrence = 0;
  let agentOrCap = 0;
  for (const row of errors.value) {
    if (row.error.status !== "unfixable") continue;
    if (unfixableReason(row) === "recurrence") recurrence++;
    else agentOrCap++;
  }
  return { recurrence, agentOrCap };
});

const now = useNowTick();
const selectedId = ref<number | null>(null);

const selectedRow = computed<RepairErrorWithAttempts | null>(() => {
  if (selectedId.value === null) return null;
  return errors.value.find((e) => e.error.id === selectedId.value) ?? null;
});

onMounted(() => {
  selectedRepo.value = props.selectedRepo;
  init();
});

onUnmounted(() => {
  destroy();
});

watch(
  () => props.selectedRepo,
  (next) => {
    selectedRepo.value = next;
  },
);

const statusOrder: Record<SystemErrorStatus, number> = {
  unfixable: 0,
  repairing: 1,
  open: 2,
  fixed: 3,
};

const sortedErrors = computed<RepairErrorWithAttempts[]>(() => {
  // The composable already orders count DESC, last_seen DESC for new
  // events, but the initial REST snapshot enforces the same order on
  // the server side. Status sub-grouping (unfixable first) keeps the
  // cap-hit rows at the top of their count bucket so operators see
  // them without filtering — a soft signal that the banner alone is
  // not enough context.
  const copy = [...errors.value];
  copy.sort((a, b) => {
    const s = statusOrder[a.error.status] - statusOrder[b.error.status];
    if (s !== 0) return s;
    if (b.error.count !== a.error.count) return b.error.count - a.error.count;
    return (
      new Date(b.error.last_seen).getTime() -
      new Date(a.error.last_seen).getTime()
    );
  });
  return copy;
});

function statusClasses(status: SystemErrorStatus): string {
  switch (status) {
    case "open":
      return "bg-amber-500/20 text-amber-300";
    case "repairing":
      return "bg-blue-500/20 text-blue-300";
    case "fixed":
      return "bg-green-500/20 text-green-300";
    case "unfixable":
      return "bg-red-500/20 text-red-300";
  }
}

function lastSeenAgo(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  const secs = Math.max(0, Math.floor((now.value - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function open(row: RepairErrorWithAttempts): void {
  selectedId.value = row.error.id;
}

function close(): void {
  selectedId.value = null;
}
</script>

<template>
  <div class="self-repair-tab">
    <div
      v-if="unfixableCount > 0"
      class="rounded-md border border-red-500/40 bg-red-500/10 p-3 mb-3 flex items-start gap-3"
      data-testid="self-repair-unfixable-banner"
    >
      <span class="text-red-300 mt-0.5">●</span>
      <div class="text-sm">
        <div class="font-semibold text-red-300">
          {{ unfixableCount }} unfixable error{{ unfixableCount === 1 ? '' : 's' }}
        </div>
        <div class="text-red-200/80">
          <span v-if="unfixableBreakdown.recurrence > 0" data-testid="banner-recurrence-line">
            {{ unfixableBreakdown.recurrence }} due to recurrence (agent
            claimed a fix, producer re-emitted){{ unfixableBreakdown.agentOrCap > 0 ? ';' : '.' }}
          </span>
          <span v-if="unfixableBreakdown.agentOrCap > 0" data-testid="banner-agent-or-cap-line">
            {{ unfixableBreakdown.agentOrCap }} agent-declared or 3-attempt
            cap exhausted.
          </span>
          Operator must inspect, reset to retry, or fix manually.
        </div>
      </div>
    </div>

    <div v-if="error" class="text-sm text-red-300 mb-2 flex items-center gap-2">
      <span>Failed to load: {{ error }}</span>
      <DanxButton size="sm" @click="refresh">Retry</DanxButton>
    </div>

    <DanxScroll class="border border-slate-800 rounded-lg">
      <table class="w-full text-[12.5px] border-collapse">
        <thead>
          <tr class="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
            <th class="p-3 whitespace-nowrap">Count</th>
            <th class="p-3 whitespace-nowrap">Category</th>
            <th class="p-3 whitespace-nowrap">Component</th>
            <th class="p-3">Message</th>
            <th class="p-3 whitespace-nowrap">Last seen</th>
            <th class="p-3 whitespace-nowrap">Status</th>
            <th class="p-3 text-right whitespace-nowrap">
              <DanxTooltip tooltip="Repair attempts logged for this signature (capped at 3 in Phase 3)">
                <template #trigger>
                  <span>Attempts</span>
                </template>
              </DanxTooltip>
            </th>
            <th class="p-3 whitespace-nowrap">Latest verdict</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && sortedErrors.length === 0" class="text-slate-500">
            <td class="p-6 text-center" colspan="8">Loading…</td>
          </tr>
          <tr v-else-if="sortedErrors.length === 0" class="text-slate-500">
            <td class="p-6 text-center" colspan="8">
              No system errors recorded yet — clean.
            </td>
          </tr>
          <tr
            v-for="row in sortedErrors"
            :key="row.error.id"
            class="border-b border-slate-800/50 hover:bg-slate-800/20 cursor-pointer"
            :class="{ 'bg-slate-800/30': selectedId === row.error.id }"
            data-testid="self-repair-row"
            @click="open(row)"
          >
            <td class="p-3 font-mono text-slate-300">{{ row.error.count }}</td>
            <td class="p-3 font-mono text-slate-300 whitespace-nowrap">
              {{ row.error.category_key }}
            </td>
            <td class="p-3 text-slate-400 whitespace-nowrap">{{ row.error.component }}</td>
            <td class="p-3 text-slate-200 line-clamp-2 max-w-md">
              {{ row.error.normalized_msg }}
            </td>
            <td class="p-3 text-slate-400 whitespace-nowrap">
              <DanxTooltip :tooltip="String(row.error.last_seen)">
                <template #trigger>
                  <span>{{ lastSeenAgo(row.error.last_seen) }}</span>
                </template>
              </DanxTooltip>
            </td>
            <td class="p-3">
              <DanxTooltip
                v-if="row.error.status === 'unfixable'"
                :tooltip="unfixableBadgeTooltip(row)"
              >
                <template #trigger>
                  <span
                    class="inline-block px-2 rounded-full text-[11.5px] font-semibold"
                    :class="statusClasses(row.error.status)"
                    :data-testid="`status-badge-unfixable-${unfixableReason(row)}`"
                  >
                    {{ row.error.status }}
                    <span class="ml-1 text-[10px] opacity-80">
                      {{ unfixableReason(row) === 'recurrence' ? '↻' : '✗' }}
                    </span>
                  </span>
                </template>
              </DanxTooltip>
              <span
                v-else
                class="inline-block px-2 rounded-full text-[11.5px] font-semibold"
                :class="statusClasses(row.error.status)"
                :data-testid="`status-badge-${row.error.status}`"
              >
                {{ row.error.status }}
              </span>
            </td>
            <td class="p-3 text-right font-mono text-slate-300">
              {{ row.attempts.length }}
            </td>
            <td class="p-3 text-slate-400">
              <template v-if="row.attempts.length === 0">—</template>
              <template v-else>
                {{ row.attempts[row.attempts.length - 1].verdict ?? "in-flight" }}
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </DanxScroll>

    <SelfRepairDrawer
      v-if="selectedRow"
      :row="selectedRow"
      @close="close"
    />
  </div>
</template>

<style scoped>
.self-repair-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
