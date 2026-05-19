import type {
  CreateListInput,
  List,
  ListsFile,
  UpdateListInput,
} from "../types";
import { listsRequest } from "./_request";

// DX-602 routes / DX-603 consumer / DX-608 swap-order.
//
// All routes return validation failures as `{errors: string[]}` — handled
// uniformly via `listsRequest`.

/** Returns operator-owned per-repo list taxonomy (7 seeded + additions). */
export async function fetchLists(repo: string): Promise<ListsFile> {
  const body = await listsRequest<{ file: ListsFile }>(
    "GET",
    `/api/lists?repo=${encodeURIComponent(repo)}`,
  );
  return body.file;
}

/**
 * Append a new list. `is_default_for_type: true` promotes it to the
 * type's default (server demotes prior default in the same atomic write).
 */
export async function createList(
  repo: string,
  input: CreateListInput,
): Promise<{ list: List; file: ListsFile }> {
  return listsRequest(
    "POST",
    `/api/lists?repo=${encodeURIComponent(repo)}`,
    input,
  );
}

/** Rename / promote-default / recolor / reorder. `type` is not patchable. */
export async function patchList(
  repo: string,
  id: string,
  patch: UpdateListInput,
): Promise<{ list: List; file: ListsFile }> {
  return listsRequest(
    "PATCH",
    `/api/lists/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
    patch,
  );
}

/**
 * DX-608. Atomically swap two lists' `order` ints under the per-repo
 * lock — replaces the paired-PATCH dance whose transactional gap could
 * leave two lists sharing one `order` if the second PATCH raced.
 */
export async function swapListOrder(
  repo: string,
  aId: string,
  bId: string,
): Promise<ListsFile> {
  const body = await listsRequest<{ file: ListsFile }>(
    "POST",
    `/api/lists/swap-order?repo=${encodeURIComponent(repo)}`,
    { a_id: aId, b_id: bId },
  );
  return body.file;
}

export interface DeleteListResult {
  deleted: List;
  reassignTo: List;
  reassignedCount: number;
  file: ListsFile;
}

/** Server refuses last-of-type with 409. */
export async function deleteList(
  repo: string,
  id: string,
): Promise<DeleteListResult> {
  return listsRequest(
    "DELETE",
    `/api/lists/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
  );
}
