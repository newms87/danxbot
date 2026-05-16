<script setup lang="ts">
/**
 * Pinned sub-header rendered between DrawerHeader and the tabs in
 * IssueDetailView. Surfaces every dispatch gate currently set on the
 * card — blocked (self-block), waiting_on (queued behind partner cards),
 * conflict_on (file-scope conflict), and requires_human (orthogonal
 * human-action flag).
 *
 * Hidden entirely when no gate is set. Each gate renders its own banner;
 * banners are collapsed to a 1-line summary by default and click-to-expand
 * to the full detail. Collapse state is local + per-banner — switching
 * cards resets every banner to collapsed.
 *
 * Replaces the inline "Dispatch gates" section that used to live inside
 * OverviewTab + the pinned RequiresHumanPanel that used to sit above the
 * tabs. Single source of truth for gate UX.
 */
import { computed, ref, watch } from "vue";
import {
  DanxButton,
  DanxIcon,
  chevronDownIcon,
  chevronRightIcon,
} from "@thehammer/danx-ui";
import type { ConflictOnEntry, Issue, IssueDetail, IssueStatus } from "../../types";
import { patchIssue } from "../../api";
import { relativeTime } from "../../utils/relativeTime";

type GateKey = "requires_human" | "blocked" | "waiting_on" | "conflict_on";

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  "jump-issue": [id: string];
  "update:issue": [issue: Issue];
  /** Operator clicked Edit on the requires_human banner. Parent owns the modal. */
  "open-rh-editor": [];
}>();

const requiresHuman = computed(() => props.issue.requires_human);
const selfBlocked = computed(() => props.issue.blocked);
const waitingOn = computed(() => props.issue.waiting_on);
const conflictForward = computed(() => props.issue.conflict_on ?? []);
const conflictReverse = computed(() => props.issue.conflict_on_reverse ?? []);
const partnerSummaries = computed(() => props.issue.conflict_on_partners ?? {});

const hasAnyGate = computed(
  () =>
    requiresHuman.value !== null ||
    selfBlocked.value !== null ||
    waitingOn.value !== null ||
    conflictForward.value.length > 0 ||
    conflictReverse.value.length > 0,
);

// Per-banner expand state. Each banner defaults to collapsed; the
// operator clicks to expand. State is reset on card switch so a
// previously-expanded banner doesn't follow into a fresh card.
const expanded = ref<Record<GateKey, boolean>>({
  requires_human: false,
  blocked: false,
  waiting_on: false,
  conflict_on: false,
});

watch(
  () => props.issue.id,
  () => {
    expanded.value = {
      requires_human: false,
      blocked: false,
      waiting_on: false,
      conflict_on: false,
    };
  },
);

function toggle(key: GateKey): void {
  expanded.value = { ...expanded.value, [key]: !expanded.value[key] };
}

// ── requires_human banner ──────────────────────────────────────────────
const rhBusy = ref(false);
const rhError = ref<string | null>(null);
const rhConfirmClear = ref(false);

const rhSetByLabel = computed(() => {
  const r = requiresHuman.value;
  if (!r) return "";
  const by = r.set_by === "agent" || r.set_by === "human" ? r.set_by : "unknown";
  if (!r.set_at) return `Set by ${by}`;
  const ms = Date.parse(r.set_at);
  if (Number.isNaN(ms)) return `Set by ${by}`;
  return `Set by ${by} ${relativeTime(ms)}`;
});

async function rhClear(): Promise<void> {
  rhBusy.value = true;
  rhError.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
      requires_human: null,
    });
    emit("update:issue", updated);
    rhConfirmClear.value = false;
  } catch (err) {
    rhError.value = err instanceof Error ? err.message : String(err);
  } finally {
    rhBusy.value = false;
  }
}

// ── blocked banner ─────────────────────────────────────────────────────
const blockedBusy = ref(false);
const blockedError = ref<string | null>(null);

async function clearBlocked(): Promise<void> {
  blockedBusy.value = true;
  blockedError.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
      blocked: null,
      status: "ToDo",
    });
    emit("update:issue", updated);
  } catch (err) {
    blockedError.value = err instanceof Error ? err.message : String(err);
  } finally {
    blockedBusy.value = false;
  }
}

// ── conflict_on banner ─────────────────────────────────────────────────
const conflictBusy = ref(false);
const conflictError = ref<string | null>(null);

function partnerStatus(id: string): IssueStatus | null {
  return partnerSummaries.value[id]?.status ?? null;
}
function partnerTitle(id: string): string | null {
  return partnerSummaries.value[id]?.title ?? null;
}

async function clearConflictEntry(entry: ConflictOnEntry): Promise<void> {
  conflictBusy.value = true;
  conflictError.value = null;
  try {
    const next = conflictForward.value.filter((e) => e.id !== entry.id);
    const updated = await patchIssue(props.repo, props.issue.id, {
      conflict_on: next,
    });
    emit("update:issue", updated);
  } catch (err) {
    conflictError.value = err instanceof Error ? err.message : String(err);
  } finally {
    conflictBusy.value = false;
  }
}

// ── summaries (collapsed 1-line) ───────────────────────────────────────
const rhSummary = computed(() => requiresHuman.value?.reason ?? "");
const blockedSummary = computed(() => selfBlocked.value?.reason ?? "");
const waitingSummary = computed(() => {
  const w = waitingOn.value;
  if (!w) return "";
  if (w.by.length === 0) return w.reason;
  return `${w.reason} · waiting on ${w.by.join(", ")}`;
});
const conflictSummary = computed(() => {
  const fwd = conflictForward.value.length;
  const rev = conflictReverse.value.length;
  const parts: string[] = [];
  if (fwd > 0) parts.push(`${fwd} active`);
  if (rev > 0) parts.push(`${rev} declared on partner`);
  return parts.join(" · ");
});
</script>

<template>
  <section
    v-if="hasAnyGate"
    class="gates-section"
    data-test="dispatch-gates-section"
  >
    <div class="gates-title">Dispatch Gates</div>

    <!-- requires_human ─────────────────────────────────────────────── -->
    <div
      v-if="requiresHuman"
      class="gate gate-rh"
      :class="{ expanded: expanded.requires_human }"
      data-test="gate-requires-human"
    >
      <button
        type="button"
        class="gate-bar"
        :aria-expanded="expanded.requires_human"
        :aria-label="`Requires human — ${rhSummary}`"
        data-test="gate-rh-toggle"
        @click="toggle('requires_human')"
      >
        <DanxIcon
          :icon="expanded.requires_human ? chevronDownIcon : chevronRightIcon"
          class="chev"
        />
        <span class="gate-glyph" aria-hidden="true">👤</span>
        <span class="gate-label">Requires Human</span>
        <span class="gate-summary">{{ rhSummary }}</span>
        <span class="gate-meta">{{ rhSetByLabel }}</span>
      </button>
      <div v-if="expanded.requires_human" class="gate-body" data-test="gate-rh-body">
        <p class="gate-reason">{{ requiresHuman.reason }}</p>
        <ol
          v-if="requiresHuman.steps.length > 0"
          class="rh-steps"
          data-test="gate-rh-steps"
        >
          <li v-for="(step, i) in requiresHuman.steps" :key="i">{{ step }}</li>
        </ol>
        <p v-else class="rh-empty-steps">(no steps provided)</p>
        <div v-if="!rhConfirmClear" class="gate-actions">
          <DanxButton
            size="sm"
            variant="warning"
            data-test="gate-rh-resolve"
            @click="rhConfirmClear = true"
          >Mark Resolved</DanxButton>
          <DanxButton
            size="sm"
            variant="muted"
            data-test="gate-rh-edit"
            @click="emit('open-rh-editor')"
          >Edit</DanxButton>
        </div>
        <div v-else class="gate-confirm" data-test="gate-rh-confirm">
          <span class="gate-confirm-prompt">Did you complete every step?</span>
          <DanxButton
            size="sm"
            variant="warning"
            :disabled="rhBusy"
            :loading="rhBusy"
            data-test="gate-rh-confirm-yes"
            @click="rhClear"
          >Yes, clear</DanxButton>
          <DanxButton
            size="sm"
            variant="muted"
            :disabled="rhBusy"
            data-test="gate-rh-confirm-cancel"
            @click="rhConfirmClear = false"
          >Cancel</DanxButton>
        </div>
        <p v-if="rhError" class="gate-error" data-test="gate-rh-error">{{ rhError }}</p>
      </div>
    </div>

    <!-- blocked ──────────────────────────────────────────────────────── -->
    <div
      v-if="selfBlocked"
      class="gate gate-blocked"
      :class="{ expanded: expanded.blocked }"
      data-test="gate-blocked"
    >
      <button
        type="button"
        class="gate-bar"
        :aria-expanded="expanded.blocked"
        data-test="gate-blocked-toggle"
        @click="toggle('blocked')"
      >
        <DanxIcon
          :icon="expanded.blocked ? chevronDownIcon : chevronRightIcon"
          class="chev"
        />
        <span class="gate-glyph" aria-hidden="true">🔒</span>
        <span class="gate-label">Blocked</span>
        <span class="gate-summary">{{ blockedSummary }}</span>
        <span class="gate-meta">{{ selfBlocked.at }}</span>
      </button>
      <div v-if="expanded.blocked" class="gate-body" data-test="gate-blocked-body">
        <p class="gate-reason">{{ selfBlocked.reason }}</p>
        <div class="gate-actions">
          <DanxButton
            size="sm"
            variant="muted"
            :disabled="blockedBusy"
            :loading="blockedBusy"
            data-test="gate-blocked-clear"
            @click="clearBlocked"
          >Clear (move to ToDo)</DanxButton>
        </div>
        <p v-if="blockedError" class="gate-error" data-test="gate-blocked-error">{{ blockedError }}</p>
      </div>
    </div>

    <!-- waiting_on ───────────────────────────────────────────────────── -->
    <div
      v-if="waitingOn"
      class="gate gate-waiting"
      :class="{ expanded: expanded.waiting_on }"
      data-test="gate-waiting"
    >
      <button
        type="button"
        class="gate-bar"
        :aria-expanded="expanded.waiting_on"
        data-test="gate-waiting-toggle"
        @click="toggle('waiting_on')"
      >
        <DanxIcon
          :icon="expanded.waiting_on ? chevronDownIcon : chevronRightIcon"
          class="chev"
        />
        <span class="gate-glyph" aria-hidden="true">⏳</span>
        <span class="gate-label">Waiting on</span>
        <span class="gate-summary">{{ waitingSummary }}</span>
        <span class="gate-meta">{{ waitingOn.timestamp }}</span>
      </button>
      <div v-if="expanded.waiting_on" class="gate-body" data-test="gate-waiting-body">
        <p class="gate-reason">{{ waitingOn.reason }}</p>
        <ul v-if="waitingOn.by.length > 0" class="partner-list">
          <li v-for="bid in waitingOn.by" :key="bid">
            <button
              type="button"
              class="partner-chip"
              :data-test="`gate-waiting-jump-${bid}`"
              @click="emit('jump-issue', bid)"
            >{{ bid }}</button>
            <span v-if="partnerStatus(bid)" class="partner-status">{{ partnerStatus(bid) }}</span>
            <span v-if="partnerTitle(bid)" class="partner-title">{{ partnerTitle(bid) }}</span>
          </li>
        </ul>
      </div>
    </div>

    <!-- conflict_on ──────────────────────────────────────────────────── -->
    <div
      v-if="conflictForward.length > 0 || conflictReverse.length > 0"
      class="gate gate-conflict"
      :class="{ expanded: expanded.conflict_on }"
      data-test="gate-conflict"
    >
      <button
        type="button"
        class="gate-bar"
        :aria-expanded="expanded.conflict_on"
        data-test="gate-conflict-toggle"
        @click="toggle('conflict_on')"
      >
        <DanxIcon
          :icon="expanded.conflict_on ? chevronDownIcon : chevronRightIcon"
          class="chev"
        />
        <span class="gate-glyph" aria-hidden="true">⚡</span>
        <span class="gate-label">Conflict on</span>
        <span class="gate-summary">{{ conflictSummary }}</span>
      </button>
      <div v-if="expanded.conflict_on" class="gate-body" data-test="gate-conflict-body">
        <ul v-if="conflictForward.length > 0" class="partner-list">
          <li v-for="entry in conflictForward" :key="`fwd-${entry.id}`">
            <button
              type="button"
              class="partner-chip"
              :data-test="`gate-conflict-jump-${entry.id}`"
              @click="emit('jump-issue', entry.id)"
            >{{ entry.id }}</button>
            <span v-if="partnerStatus(entry.id)" class="partner-status">{{ partnerStatus(entry.id) }}</span>
            <span class="conflict-reason">{{ entry.reason }}</span>
            <DanxButton
              size="xs"
              variant="muted"
              :disabled="conflictBusy"
              :data-test="`gate-conflict-clear-${entry.id}`"
              @click="clearConflictEntry(entry)"
            >Clear</DanxButton>
          </li>
        </ul>
        <ul v-if="conflictReverse.length > 0" class="partner-list reverse">
          <li v-for="entry in conflictReverse" :key="`rev-${entry.id}`">
            <span class="reverse-arrow" aria-hidden="true">↩</span>
            <button
              type="button"
              class="partner-chip"
              :data-test="`gate-conflict-rev-jump-${entry.id}`"
              @click="emit('jump-issue', entry.id)"
            >{{ entry.id }}</button>
            <span v-if="partnerStatus(entry.id)" class="partner-status">{{ partnerStatus(entry.id) }}</span>
            <span class="conflict-reason">{{ entry.reason }}</span>
            <span class="reverse-note">declared on partner</span>
          </li>
        </ul>
        <p v-if="conflictError" class="gate-error" data-test="gate-conflict-error">{{ conflictError }}</p>
      </div>
    </div>

  </section>
</template>

<style scoped>
.gates-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 20px 12px;
  border-bottom: 1px solid #1e293b;
  background: rgb(15 23 42 / 0.4);
}
.gates-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  margin-bottom: 2px;
}
.gate {
  border-radius: 6px;
  border: 1px solid transparent;
  overflow: hidden;
}
.gate-rh        { background: rgb(249 115 22 / 0.08); border-color: rgb(249 115 22 / 0.35); }
.gate-blocked   { background: rgb(239 68 68 / 0.08);  border-color: rgb(239 68 68 / 0.30); }
.gate-waiting   { background: rgb(245 158 11 / 0.08); border-color: rgb(245 158 11 / 0.30); }
.gate-conflict  { background: rgb(168 85 247 / 0.08); border-color: rgb(168 85 247 / 0.30); }

.gate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: 0;
  font-family: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.gate-bar:hover {
  background: rgb(255 255 255 / 0.03);
}
.chev {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: #94a3b8;
}
.gate-glyph {
  font-size: 12px;
  flex-shrink: 0;
}
.gate-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.gate-rh        .gate-label { color: #fdba74; }
.gate-blocked   .gate-label { color: #fca5a5; }
.gate-waiting   .gate-label { color: #fcd34d; }
.gate-conflict  .gate-label { color: #d8b4fe; }
.gate-summary {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #cbd5e1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gate-meta {
  font-size: 10px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.gate-body {
  padding: 4px 12px 12px 32px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: #cbd5e1;
}
.gate-reason {
  margin: 0;
  line-height: 1.5;
}
.gate-rh        .gate-reason { color: #fed7aa; }
.gate-blocked   .gate-reason { color: #fecaca; }
.gate-waiting   .gate-reason { color: #fde68a; }
.rh-steps {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #e2e8f0;
}
.rh-empty-steps {
  margin: 0;
  font-size: 12px;
  color: #64748b;
  font-style: italic;
}
.gate-actions,
.gate-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.gate-confirm-prompt {
  font-size: 12px;
  color: #fde68a;
}
.gate-error {
  margin: 0;
  font-size: 11px;
  color: #fca5a5;
}
.partner-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.partner-list > li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.partner-list.reverse > li {
  opacity: 0.8;
}
.partner-chip {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #e2e8f0;
  background: rgb(15 23 42 / 0.5);
  border: 1px solid #334155;
  cursor: pointer;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}
.partner-chip:hover {
  background: rgb(30 41 59 / 0.7);
}
.partner-status {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(15 23 42 / 0.4);
  border: 1px solid #1e293b;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.partner-title {
  font-size: 12px;
  color: #cbd5e1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-reason {
  font-size: 12px;
  color: #e9d5ff;
  flex: 1;
  min-width: 120px;
}
.reverse-arrow {
  font-size: 12px;
  color: #c4b5fd;
}
.reverse-note {
  font-size: 10px;
  font-style: italic;
  color: #94a3b8;
}
</style>
