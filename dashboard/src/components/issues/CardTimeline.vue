<script setup lang="ts">
/**
 * DX-587 — slim horizontal stepper at the top of the Overview tab.
 * Read-only consumer of v10 lifecycle timestamps (DX-591/DX-575); no
 * schema work. Renders a fixed left-to-right node order; greys nodes
 * the card never reached.
 *
 * Node colour comes from each ListType's `is_default_for_type` list via
 * `useListColors(repo)` — the same SSE-fed source the board columns and
 * gate banners use, so operator palette edits propagate live.
 *
 * The relative-time labels under each node refresh via `useNowTick`
 * (cosmetic-only, no server work). Tooltip carries the full ISO
 * timestamp via `DanxTooltip` (DanxUI mandate — no raw `title=`).
 */
import { computed, onBeforeUnmount, onMounted } from "vue";
import { DanxTooltip } from "@thehammer/danx-ui";
import type { IssueDetail, ListType } from "../../types";
import { useListColors } from "../../composables/useListColors";
import { useNowTick } from "../../composables/useNowTick";
import { relativeTime } from "../../utils/relativeTime";

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

/**
 * Timeline node "type" is the visual / color key — a superset of
 * `ListType` plus the special `"blocked"` self-block gate node
 * (DX-658 / Phase 2 retired `"blocked"` as a `ListType`, but the
 * timeline still renders the gate event when populated).
 */
type TimelineNodeType = ListType | "blocked";

interface TimelineNode {
  key: string;
  label: string;
  type: TimelineNodeType;
  /** True iff the card reached this lifecycle state. Decoupled from `timestamp`
   *  so a node can be "reached but timestamp unknown" — e.g. a completed card
   *  with no recorded In Progress transition. */
  reached: boolean;
  /** ISO 8601 timestamp, or null when the exact moment is not recorded. */
  timestamp: string | null;
}

const listsApi = useListColors(props.repo);
onMounted(() => listsApi.init());
onBeforeUnmount(() => listsApi.destroy());

const now = useNowTick();

/** Default-list colour for each semantic type; neutral fallback when the
 *  taxonomy has not hydrated yet or the operator deleted the default. */
const colorByType = computed<Record<ListType, string>>(() => {
  const out: Record<string, string> = {};
  for (const l of listsApi.lists.value) {
    if (l.is_default_for_type) out[l.type] = l.color;
  }
  return out as Record<ListType, string>;
});

const NEUTRAL_NODE_COLOR = "#475569" as const;
/** Self-block gate accent — kept inline because the post-DX-658
 *  `"blocked"` ListType no longer exists in the taxonomy, but the
 *  timeline still renders the gate node when populated. Matches the
 *  pre-DX-658 default-blocked-list red so historical screenshots
 *  remain visually consistent. */
const BLOCKED_GATE_COLOR = "#ef4444" as const;

function colorFor(type: TimelineNodeType): string {
  if (type === "blocked") return BLOCKED_GATE_COLOR;
  return colorByType.value[type] ?? NEUTRAL_NODE_COLOR;
}

/** First `created` history entry, or the IssueDetail's file mtime
 *  fallback. The schema does not carry a `created_at` field; we lean on
 *  `IssueDetail.created_at` (unix ms — file mtime), set by the server. */
const createdTimestamp = computed<string>(() => {
  const ev = props.issue.history.find((h) => h.event === "created");
  if (ev?.timestamp) return ev.timestamp;
  const ms = props.issue.created_at;
  return ms > 0 ? new Date(ms).toISOString() : "";
});

interface InProgressInfo {
  reached: boolean;
  timestamp: string | null;
}

const inProgress = computed<InProgressInfo>(() => {
  if (props.issue.dispatch?.started_at) {
    return { reached: true, timestamp: props.issue.dispatch.started_at };
  }
  const ev = props.issue.history.find(
    (h) => h.event === "status_change" && h.to === "In Progress",
  );
  if (ev?.timestamp) return { reached: true, timestamp: ev.timestamp };
  // Inferred from downstream terminal trigger — card must have passed through.
  if (props.issue.completed_at || props.issue.cancelled_at) {
    return { reached: true, timestamp: null };
  }
  return { reached: false, timestamp: null };
});

const nodes = computed<TimelineNode[]>(() => {
  const createdTs = createdTimestamp.value || null;
  const out: TimelineNode[] = [
    { key: "created", label: "Created", type: "review", reached: createdTs !== null, timestamp: createdTs },
  ];
  if (props.issue.archived_at) {
    out.push({ key: "archived", label: "Backlog", type: "archived", reached: true, timestamp: props.issue.archived_at });
  }
  if (props.issue.ready_at) {
    out.push({ key: "ready", label: "Ready", type: "ready", reached: true, timestamp: props.issue.ready_at });
  }
  if (props.issue.blocked) {
    out.push({ key: "blocked", label: "Blocked", type: "blocked", reached: true, timestamp: props.issue.blocked.at });
  }
  if (inProgress.value.reached) {
    out.push({
      key: "in_progress",
      label: "In Progress",
      type: "in_progress",
      reached: true,
      timestamp: inProgress.value.timestamp,
    });
  }
  if (props.issue.completed_at) {
    out.push({ key: "completed", label: "Done", type: "completed", reached: true, timestamp: props.issue.completed_at });
  } else if (props.issue.cancelled_at) {
    out.push({ key: "cancelled", label: "Cancelled", type: "cancelled", reached: true, timestamp: props.issue.cancelled_at });
  }
  return out;
});

function relLabel(ts: string | null): string {
  if (!ts) return "—";
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "—";
  return relativeTime(ms, now.value);
}

function tooltipFor(node: TimelineNode): string {
  if (!node.timestamp) return `${node.label} (time unknown)`;
  return `${node.label} · ${node.timestamp}`;
}
</script>

<template>
  <div class="card-timeline" data-test="card-timeline">
    <ol class="track">
      <li
        v-for="(node, i) in nodes"
        :key="node.key"
        class="step"
        :data-test="`timeline-node-${node.key}`"
        :data-greyed="node.reached ? 'false' : 'true'"
        :data-iso="node.timestamp ?? ''"
      >
        <DanxTooltip :tooltip="tooltipFor(node)">
          <template #trigger>
            <div class="cell">
              <span
                class="dot"
                :style="{ background: node.reached ? colorFor(node.type) : 'transparent', borderColor: colorFor(node.type) }"
                aria-hidden="true"
              />
              <span class="label">{{ node.label }}</span>
              <span class="rel">{{ relLabel(node.timestamp) }}</span>
            </div>
          </template>
        </DanxTooltip>
        <span v-if="i < nodes.length - 1" class="connector" aria-hidden="true" />
      </li>
    </ol>
  </div>
</template>

<style scoped>
.card-timeline {
  width: 100%;
  padding: 6px 4px;
  font-size: 11px;
}
.track {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-height: 36px;
}
.step {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
}
.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: help;
  min-width: 0;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid;
  flex-shrink: 0;
}
.label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #cbd5e1;
  white-space: nowrap;
}
.step[data-greyed="true"] .label {
  color: #64748b;
}
.rel {
  font-size: 9px;
  color: #64748b;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.connector {
  flex: 1 1 auto;
  height: 1px;
  background: #1e293b;
  margin: 0 6px;
  align-self: flex-start;
  margin-top: 5px;
  min-width: 8px;
}
</style>
