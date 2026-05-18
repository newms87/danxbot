/**
 * Pure type + constant surface for the per-repo list taxonomy.
 *
 * Split out from `lists-file.ts` so browser code (the dashboard SPA)
 * can import these types + the `LIST_TYPES` constant without pulling
 * in `lists-file.ts`'s top-level `node:fs` / `node:fs/promises` /
 * `node:crypto` imports. Vite externalizes `node:*` for browser
 * compatibility, and any runtime reach into them (even from a
 * module-level side-effect-free function) crashes the bundle on
 * load.
 *
 * Backend callers continue to import from `lists-file.ts` — that
 * module re-exports everything here, so existing import sites stay
 * working.
 */

/**
 * Semantic enum every list belongs to. DX-658 / Phase 2 of "Blocked
 * becomes a dispatch gate, not a status" retired the `"blocked"`
 * member — Blocked is no longer a column the workers map cards onto;
 * the `Issue.blocked` field is a pure dispatch gate read by the
 * picker. The boot migration at `src/lists-file-migrate-blocked.ts`
 * strips any legacy `type: "blocked"` entry from existing repos'
 * `lists.yaml` files.
 */
export type ListType =
  | "archived"
  | "review"
  | "ready"
  | "in_progress"
  | "completed"
  | "cancelled";

export const LIST_TYPES: readonly ListType[] = [
  "archived",
  "review",
  "ready",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export interface List {
  id: string;
  name: string;
  type: ListType;
  order: number;
  is_default_for_type: boolean;
  color: string;
}

export interface ListsFile {
  lists: List[];
  tombstone_ids: string[];
}

export interface CreateListInput {
  name: string;
  type: ListType;
  order?: number;
  is_default_for_type?: boolean;
  color?: string;
}

export interface UpdateListInput {
  name?: string;
  order?: number;
  is_default_for_type?: boolean;
  color?: string;
}
