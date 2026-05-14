<script setup lang="ts">
import { computed } from "vue";
import { MarkdownEditor } from "@thehammer/danx-ui";
import type { IssueDetail, IssueTriageHistoryEntry } from "../../types";
import { ageBuckets, relativeTime } from "../../utils/relativeTime";
import IceBadge from "./IceBadge.vue";
import { ICE_TIER_META, type IceTierId } from "./issuePalette";

const props = withDefaults(
  defineProps<{
    issue: IssueDetail;
    /**
     * DX-518 — true while the operator's Triage button dispatch is in
     * flight against this card (set by `IssuesPage.onTriageDispatched`,
     * cleared by `IssuesPage.onUpdateIssue` when a fresh `triage.history[]`
     * entry arrives via the SSE bus). Renders an inline pulse badge in
     * the header so the operator knows the agent is reasoning.
     */
    inFlight?: boolean;
  }>(),
  { inFlight: false },
);

const triage = computed(() => props.issue.triage);

// AC #3 — only Keep / Approve carry the ICE breakdown. Cancel / Demote /
// Confirm-Block / Unblock are decisions where ICE is either irrelevant
// (Cancel kills the card outright) or already known-zero (Confirm-Block
// pegs total to a sentinel low value). Suppressing keeps the header
// uncluttered for terminal-ish decisions.
const STATUSES_WITH_ICE = new Set(["Keep", "Approve"]);
const showIce = computed(() => STATUSES_WITH_ICE.has(triage.value.last_status));

// AC #5 — `reassess_hint` is the action-shaped sentence the next triage
// agent reads to decide whether to bump the card to a different lane.
// On Keep / Demote / Unblock the decision is settled and the hint is
// noise; the agent stamps it anyway because the schema field is shared.
const STATUSES_SUPPRESSING_HINT = new Set(["Keep", "Demote", "Unblock"]);
const showHint = computed(
  () =>
    triage.value.reassess_hint !== "" &&
    !STATUSES_SUPPRESSING_HINT.has(triage.value.last_status),
);

interface FormattedExpiry {
  text: string;
  past: boolean;
}

const UNIT_SUFFIX: Record<"min" | "hour" | "day", string> = {
  min: "m",
  hour: "h",
  day: "d",
};

function formatExpiry(iso: string, now: number = Date.now()): FormattedExpiry | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const diff = ms - now;
  const past = diff < 0;
  const b = ageBuckets(Math.abs(diff));
  if (b.unit === "now") {
    return { text: past ? "expired just now" : "expires now", past };
  }
  const suffix = UNIT_SUFFIX[b.unit];
  return {
    text: past ? `expired ${b.count}${suffix} ago` : `expires in ${b.count}${suffix}`,
    past,
  };
}

const expiry = computed(() => formatExpiry(triage.value.expires_at));

interface RenderedHistoryEntry {
  key: string;
  iso: string;
  tsLabel: string;
  status: string;
  explain: string;
  iceTotal: number;
}

const sortedHistory = computed<RenderedHistoryEntry[]>(() => {
  const now = Date.now();
  const src: IssueTriageHistoryEntry[] = triage.value.history ?? [];
  const indexed = src.map((entry, i) => {
    const parsed = Date.parse(entry.timestamp);
    const ms = Number.isNaN(parsed) ? 0 : parsed;
    return { entry, ms, i, valid: !Number.isNaN(parsed) };
  });
  indexed.sort((a, b) => b.ms - a.ms);
  return indexed.slice(0, 10).map(({ entry, ms, i, valid }) => ({
    key: `${entry.timestamp}|${i}`,
    iso: entry.timestamp,
    tsLabel: valid ? relativeTime(ms, now) : entry.timestamp || "(no timestamp)",
    status: entry.status,
    explain: entry.explain,
    iceTotal: entry.ice.total,
  }));
});

interface StatusPillStyle {
  fg: string;
  bg: string;
  border: string;
}

const STATUS_PILL: Record<string, StatusPillStyle> = {
  Keep:            { fg: "#6ee7b7", bg: "rgb(16 185 129 / 0.18)", border: "rgb(16 185 129 / 0.40)" },
  Approve:         { fg: "#86efac", bg: "rgb(34 197 94 / 0.18)",  border: "rgb(34 197 94 / 0.40)" },
  Unblock:         { fg: "#86efac", bg: "rgb(34 197 94 / 0.18)",  border: "rgb(34 197 94 / 0.40)" },
  Cancel:          { fg: "#fca5a5", bg: "rgb(239 68 68 / 0.18)",  border: "rgb(239 68 68 / 0.40)" },
  "Confirm-Block": { fg: "#fca5a5", bg: "rgb(239 68 68 / 0.18)",  border: "rgb(239 68 68 / 0.40)" },
  Demote:          { fg: "#fcd34d", bg: "rgb(245 158 11 / 0.18)", border: "rgb(245 158 11 / 0.40)" },
};
const MUTED_PILL: StatusPillStyle = {
  fg: "#cbd5e1",
  bg: "rgb(51 65 85 / 0.40)",
  border: "rgb(100 116 139 / 0.45)",
};

function pillStyle(status: string): Record<string, string> {
  const meta = STATUS_PILL[status] ?? MUTED_PILL;
  return { color: meta.fg, background: meta.bg, borderColor: meta.border };
}

// Axis-row palette reuses the IceBadge tier palette so axes read as
// siblings of the total badge. Thresholds are per-axis (max axis = 5),
// not rescaled into the total range.
function axisStyle(score: number): Record<string, string> {
  const tier: IceTierId = score >= 4 ? "high" : score >= 2 ? "mid" : "low";
  const meta = ICE_TIER_META[tier];
  return { color: meta.fg, borderColor: meta.border };
}
</script>

<template>
  <div class="triage-tab" data-test="triage-tab">
    <header class="header">
      <span
        class="status-badge"
        :style="pillStyle(triage.last_status)"
        data-test="triage-status-badge"
      >{{ triage.last_status }}</span>
      <span
        v-if="expiry"
        class="expiry"
        :class="{ 'expiry-past': expiry.past }"
        :title="triage.expires_at"
        data-test="triage-expires"
      >{{ expiry.text }}</span>
      <span
        v-if="props.inFlight"
        class="in-flight"
        data-test="triage-in-flight"
        title="Triage agent is running on this card — header refreshes when the new decision lands"
      >
        <span class="pulse-dot" />
        Triage in flight…
      </span>
    </header>

    <section v-if="showIce" class="ice-section" data-test="triage-ice">
      <div class="section-label">ICE Score</div>
      <div class="ice-grid">
        <div class="ice-row" data-test="triage-ice-i">
          <span class="ice-axis">Impact</span>
          <span class="ice-axis-score" :style="axisStyle(triage.ice.i)">{{ triage.ice.i }}</span>
        </div>
        <div class="ice-row" data-test="triage-ice-c">
          <span class="ice-axis">Confidence</span>
          <span class="ice-axis-score" :style="axisStyle(triage.ice.c)">{{ triage.ice.c }}</span>
        </div>
        <div class="ice-row" data-test="triage-ice-e">
          <span class="ice-axis">Effort</span>
          <span class="ice-axis-score" :style="axisStyle(triage.ice.e)">{{ triage.ice.e }}</span>
        </div>
        <div class="ice-total-row" data-test="triage-ice-total">
          <span class="ice-axis">I × C × E</span>
          <span class="ice-total-eq">{{ triage.ice.i }} × {{ triage.ice.c }} × {{ triage.ice.e }} =</span>
          <IceBadge :total="triage.ice.total" />
        </div>
      </div>
    </section>

    <section v-if="triage.last_explain" class="explain-section">
      <div class="section-label">Latest Decision</div>
      <MarkdownEditor
        :model-value="triage.last_explain"
        readonly
        hide-footer
        class="explain-body"
      />
    </section>

    <section
      v-if="showHint"
      class="hint-section"
      data-test="triage-hint"
    >
      <div class="section-label">Reassess Hint</div>
      <div class="hint-body">{{ triage.reassess_hint }}</div>
    </section>

    <section class="history-section">
      <div class="section-label">History · {{ sortedHistory.length }}</div>
      <div class="history-timeline">
        <div
          v-for="entry in sortedHistory"
          :key="entry.key"
          class="history-row"
          data-test="triage-history-row"
        >
          <div class="history-head">
            <span class="history-ts" :title="entry.iso">{{ entry.tsLabel }}</span>
            <span
              class="history-status"
              :style="pillStyle(entry.status)"
            >{{ entry.status }}</span>
            <IceBadge :total="entry.iceTotal" />
          </div>
          <div v-if="entry.explain" class="history-explain">{{ entry.explain }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.triage-tab {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 20px;
}
.header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.status-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.expiry {
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}
.expiry-past {
  color: #fca5a5;
}
.in-flight {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #fcd34d;
  background: rgb(245 158 11 / 0.10);
  border: 1px solid rgb(245 158 11 / 0.35);
  padding: 3px 8px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}
.pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fcd34d;
  animation: triage-pulse 1.2s ease-in-out infinite;
}
@keyframes triage-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.section-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 8px;
}
.ice-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 10px 12px;
}
.ice-row,
.ice-total-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.ice-axis {
  flex: 1;
  color: #94a3b8;
}
.ice-axis-score {
  font-family: ui-monospace, "Fira Mono", "Roboto Mono", monospace;
  font-weight: 600;
  padding: 1px 8px;
  border: 1px solid;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}
.ice-total-row {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid #1e293b;
}
.ice-total-eq {
  font-family: ui-monospace, "Fira Mono", "Roboto Mono", monospace;
  font-size: 11px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.explain-body {
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  border-radius: 6px;
}
.hint-section {
  /* Muted background + monospace shape to read as "system note", per
     the card's solution shape — the hint is machine-authored advice
     for the next triage pass, not human prose. */
  background: rgb(245 158 11 / 0.06);
  border: 1px solid rgb(245 158 11 / 0.25);
  border-radius: 6px;
  padding: 10px 12px;
}
.hint-section .section-label {
  color: #fcd34d;
  margin-bottom: 6px;
}
.hint-body {
  font-family: ui-monospace, "Fira Mono", "Roboto Mono", monospace;
  font-size: 12px;
  color: #fde68a;
  line-height: 1.5;
}
.history-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.history-row {
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 8px 10px;
}
.history-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.history-ts {
  font-size: 11px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.history-status {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.history-explain {
  margin-top: 6px;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.4;
  white-space: pre-wrap;
}
</style>
