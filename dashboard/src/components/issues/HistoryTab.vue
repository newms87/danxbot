<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail, IssueHistoryEntry, IssueHistoryEvent, IssueStatus } from "../../types";
import { relativeTime } from "../../utils/relativeTime";
import { COLUMN_ACCENTS } from "./issuePalette";

const props = defineProps<{
  issue: IssueDetail;
}>();

interface ActorRender {
  kind: "dispatch" | "dashboard" | "worker" | "tracker" | "setup" | "unknown";
  label: string;
  href: string | null;
  fullActor: string;
}

interface RenderedEntry {
  key: string;
  icon: string;
  iso: string;
  ms: number;
  tsLabel: string;
  actor: ActorRender;
  event: IssueHistoryEvent;
  from?: IssueStatus;
  to?: IssueStatus;
  note?: string;
}

const EVENT_ICON: Record<IssueHistoryEvent, string> = {
  created: "＋",
  status_change: "⇄",
  blocked: "⛔",
  unblocked: "✅",
};

function parseActor(raw: string): ActorRender {
  if (raw === "setup") return { kind: "setup", label: "setup", href: null, fullActor: raw };
  if (raw === "unknown") return { kind: "unknown", label: "unknown", href: null, fullActor: raw };
  const colon = raw.indexOf(":");
  if (colon < 0) return { kind: "unknown", label: raw || "unknown", href: null, fullActor: raw };
  const source = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (source === "dispatch") {
    // No client-side router exists for dispatch detail; the dispatches tab
    // is opened via in-memory selection in App.vue. Link to the dispatches
    // tab; the full UUID lives in the title attribute for copy/paste.
    return {
      kind: "dispatch",
      label: `dispatch:${id.slice(0, 8)}`,
      href: `?tab=dispatches`,
      fullActor: raw,
    };
  }
  if (source === "dashboard") return { kind: "dashboard", label: id || "dashboard", href: null, fullActor: raw };
  if (source === "worker") return { kind: "worker", label: id || "worker", href: null, fullActor: raw };
  if (source === "tracker") {
    const name = id.charAt(0).toUpperCase() + id.slice(1);
    return { kind: "tracker", label: name || "Tracker", href: null, fullActor: raw };
  }
  return { kind: "unknown", label: raw, href: null, fullActor: raw };
}

function statusPill(s: IssueStatus): Record<string, string> {
  const a = COLUMN_ACCENTS[s];
  return {
    color: a.accent,
    borderColor: a.accent,
    background: "rgb(15 23 42 / 0.6)",
  };
}

const entries = computed<RenderedEntry[]>(() => {
  const src: IssueHistoryEntry[] = props.issue.history ?? [];
  return src
    .map((e) => {
      const ms = Date.parse(e.timestamp);
      const validMs = Number.isNaN(ms) ? 0 : ms;
      return {
        key: `${e.actor}|${e.event}|${e.timestamp}`,
        icon: EVENT_ICON[e.event],
        iso: e.timestamp,
        ms: validMs,
        tsLabel: Number.isNaN(ms) ? (e.timestamp || "(no timestamp)") : relativeTime(ms),
        actor: parseActor(e.actor || "unknown"),
        event: e.event,
        from: e.from,
        to: e.to,
        note: e.note,
      };
    })
    .sort((a, b) => b.ms - a.ms);
});
</script>

<template>
  <div v-if="entries.length === 0" class="empty">
    No history recorded for this card.
  </div>
  <div v-else class="history">
    <div v-for="e in entries" :key="e.key" class="row">
      <span class="icon" role="img" :aria-label="e.event" :title="e.event">{{ e.icon }}</span>
      <div class="content">
        <div class="head">
          <span class="ts" :title="e.iso">{{ e.tsLabel }}</span>
          <a
            v-if="e.actor.href"
            class="actor"
            :class="`actor-${e.actor.kind}`"
            :href="e.actor.href"
            :title="e.actor.fullActor"
          >{{ e.actor.label }}</a>
          <span
            v-else
            class="actor"
            :class="`actor-${e.actor.kind}`"
            :title="e.actor.fullActor"
          >
            <span v-if="e.actor.kind === 'worker'" class="bot-glyph" aria-hidden="true">🤖</span>{{ e.actor.label }}
          </span>
          <span class="diff">
            <template v-if="e.event === 'status_change' && e.from">
              <span class="status-pill" :style="statusPill(e.from)">{{ e.from }}</span>
              <span class="arrow">→</span>
              <span v-if="e.to" class="status-pill" :style="statusPill(e.to)">{{ e.to }}</span>
            </template>
            <template v-else-if="e.to">
              <span class="status-pill" :style="statusPill(e.to)">{{ e.to }}</span>
            </template>
          </span>
        </div>
        <div v-if="e.note" class="note">{{ e.note }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty {
  padding: 40px;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
.history {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
}
.icon {
  font-size: 14px;
  line-height: 1.4;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  color: #94a3b8;
}
.content {
  flex: 1;
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ts {
  font-size: 11px;
  color: #64748b;
}
.actor {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
}
a.actor:hover { filter: brightness(1.2); }
.actor-dispatch {
  color: #93c5fd;
  border-color: rgb(59 130 246 / 0.45);
  background: rgb(59 130 246 / 0.12);
}
.actor-dashboard {
  color: #86efac;
  border-color: rgb(16 185 129 / 0.45);
  background: rgb(16 185 129 / 0.12);
}
.actor-worker {
  color: #cbd5e1;
  border-color: rgb(100 116 139 / 0.45);
  background: rgb(51 65 85 / 0.30);
}
.actor-tracker {
  color: #c7d2fe;
  border-color: rgb(99 102 241 / 0.45);
  background: rgb(99 102 241 / 0.12);
}
.actor-setup {
  color: #fde68a;
  border-color: rgb(245 158 11 / 0.45);
  background: rgb(245 158 11 / 0.12);
}
.actor-unknown {
  color: #fca5a5;
  border-color: rgb(239 68 68 / 0.65);
  background: rgb(239 68 68 / 0.18);
  font-weight: 700;
}
.bot-glyph {
  font-size: 11px;
}
.diff {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.status-pill {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.arrow {
  font-size: 11px;
  color: #64748b;
}
.note {
  margin-top: 4px;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.4;
}
</style>
