import type { IssueListItem, List, ListType } from "../../types";
import { LIST_TYPE_LADDER } from "../../types";
import { deriveListTypeFromStatus } from "../../composables/derive-status";

/** Window for "Done (Recent)" filter when `showClosed` is off. */
export const RECENT_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Ladder index for a list type. Lower index = further left on the
 * board. Unknown types fall to the end (defensive — `lists.yaml`
 * validation pins the enum, but a stale browser cache could see an
 * unknown type briefly during a deploy).
 */
export function ladderIdx(type: ListType): number {
  const idx = LIST_TYPE_LADDER.indexOf(type as (typeof LIST_TYPE_LADDER)[number]);
  return idx < 0 ? LIST_TYPE_LADDER.length : idx;
}

/**
 * Order lists left → right by ladder position, then `order` within a
 * type, then `name` as a stable tie-breaker. When `showClosed` is
 * false, drop `cancelled`-type columns entirely (mirrors the
 * pre-DX-586 board behavior).
 */
export function orderColumns(lists: readonly List[], showClosed: boolean): List[] {
  const sorted = [...lists];
  sorted.sort((a, b) => {
    const la = ladderIdx(a.type);
    const lb = ladderIdx(b.type);
    if (la !== lb) return la - lb;
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
  if (!showClosed) {
    return sorted.filter((l) => l.type !== "cancelled");
  }
  return sorted;
}

/** Default list per type — column-grouping target for every card. */
export function buildDefaultByType(lists: readonly List[]): Map<ListType, List> {
  const m = new Map<ListType, List>();
  for (const l of lists) {
    if (l.is_default_for_type) m.set(l.type, l);
  }
  return m;
}

/**
 * Resolve a card's column purely from its server-derived semantic
 * status. The raw `list_name` field is intentionally ignored — drift
 * in that denormalized cache (the DX-624 failure mode) cannot leak
 * into column grouping when grouping reads only the derivation.
 */
export function listForIssue(
  issue: IssueListItem,
  defaultByType: Map<ListType, List>,
): List | null {
  const type = deriveListTypeFromStatus(issue.status);
  return defaultByType.get(type) ?? null;
}

/** Is this `completed`-type card within the recent-24h window? */
export function isCompletedRecent(
  updatedAtSeconds: number,
  nowMs: number,
  windowMs: number = RECENT_DONE_WINDOW_MS,
): boolean {
  return updatedAtSeconds * 1000 >= nowMs - windowMs;
}

/**
 * Bucket cards into columns by derived list. Cards landing in a
 * `cancelled` column (when `!showClosed`) or in a `completed` column
 * older than the recent-24h window (when `!showClosed`) are dropped.
 * Uncategorized cards (no default for the projected type) are
 * silently dropped; the lists-routes guarantees ≥1 default per type
 * so this is unreachable in practice.
 *
 * The returned record is keyed by column NAME (not id) to match the
 * board template's existing lookups. Empty arrays are pre-seeded for
 * every column so the template's `grouped[col.name]?.length ?? 0`
 * pattern stays cheap.
 */
export function groupIssuesByColumns(
  issues: readonly IssueListItem[],
  columns: readonly List[],
  defaultByType: Map<ListType, List>,
  showClosed: boolean,
  nowMs: number,
): Record<string, IssueListItem[]> {
  const result: Record<string, IssueListItem[]> = {};
  for (const col of columns) result[col.name] = [];
  for (const issue of issues) {
    const dest = listForIssue(issue, defaultByType);
    if (!dest) continue;
    if (!showClosed) {
      if (dest.type === "cancelled") continue;
      if (dest.type === "completed" && !isCompletedRecent(issue.updated_at, nowMs)) continue;
    }
    if (!result[dest.name]) result[dest.name] = [];
    result[dest.name].push(issue);
  }
  return result;
}

/** Stable per-column test id (kebab-case, alphanumeric only). */
export function testIdFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Render-row shape for a column: alternating drop-slots and cards.
 * Slots carry the (`before`, `after`) neighbor pair the drag binding
 * needs to compute drop semantics; cards carry the issue itself.
 *
 * Card keys (`card:<id>`) are stable across re-renders so Vue's
 * TransitionGroup tracks each card and animates `move` as a reorder
 * lands.
 *
 * Slot keys (`slot:<colId>:<beforeId>:<afterId>`) are intentionally
 * unstable-by-neighbor — when a reorder shifts cards around, the slot
 * between cards N and N+1 effectively becomes "between Nx and Nx+1"
 * with a new key. TransitionGroup fires enter/leave on those instead
 * of move. Visible effect is nil (slots are 6px transparent strips)
 * so this is the cheapest correct encoding of "slot identity ≡ its
 * neighbor pair".
 */
export type ColumnRow =
  | { kind: "slot"; key: string; before: IssueListItem | null; after: IssueListItem | null }
  | { kind: "card"; key: string; issue: IssueListItem };

export function buildColumnRows(
  colKey: string,
  list: readonly IssueListItem[],
): ColumnRow[] {
  const rows: ColumnRow[] = [];
  rows.push({
    kind: "slot",
    key: `slot:${colKey}:head:${list[0]?.id ?? "tail"}`,
    before: null,
    after: list[0] ?? null,
  });
  for (let i = 0; i < list.length; i++) {
    const issue = list[i];
    rows.push({ kind: "card", key: `card:${issue.id}`, issue });
    const next = list[i + 1] ?? null;
    rows.push({
      kind: "slot",
      key: `slot:${colKey}:${issue.id}:${next?.id ?? "tail"}`,
      before: issue,
      after: next,
    });
  }
  return rows;
}
