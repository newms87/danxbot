/**
 * Per-card chat session storage (DX-348 Phase 3 / DX-351).
 *
 * One JSON file per `<PREFIX>-N` at
 * `<repoRoot>/.danxbot/chat-sessions/<id>.json`:
 *
 *     {
 *       "dispatch_id": "<latest dispatch id for this card's chat>",
 *       "updated_at":  "<ISO 8601 of last write>"
 *     }
 *
 * The chat route reads the record on every `POST /api/chat`: absent →
 * dispatch fresh; present → look up the dispatch's Claude session uuid and
 * resume. The record is rewritten with the new dispatch id every turn so
 * the next call always resumes the leaf of the chain.
 *
 * Plain disk state: no DB column, no migration. Survives worker restart by
 * construction. Discarded (per file) when the operator wants to forget the
 * conversation — just delete the JSON. The directory itself is gitignored
 * (part of `.danxbot/` runtime state).
 *
 * Atomic write: temp-then-rename so a partial / crashed write never leaves
 * a half-baked JSON the next read would silently mis-parse.
 */

import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

const ISSUE_ID_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export interface ChatSessionRecord {
  dispatch_id: string;
  updated_at: string;
}

function assertIssueId(issueId: string): void {
  if (!ISSUE_ID_PATTERN.test(issueId)) {
    throw new Error(
      `Invalid issue id "${issueId}" — must match <PREFIX>-N (e.g. DX-351)`,
    );
  }
}

/**
 * Resolve the on-disk path for an issue's chat session record.
 * Throws if the id is not in `<PREFIX>-N` shape — defense-in-depth against a
 * caller that bypassed the route's regex (the route already enforces the
 * shape, but this module is reachable from tests + future callers that may
 * pass a value through).
 */
export function chatSessionPath(repoLocalPath: string, issueId: string): string {
  assertIssueId(issueId);
  return resolve(repoLocalPath, ".danxbot", "chat-sessions", `${issueId}.json`);
}

/**
 * Read the chat session record for an issue. Returns `null` on every
 * non-success outcome — file missing, malformed JSON, missing required
 * field. The chat route treats a `null` return as "dispatch fresh," so
 * corrupted state self-heals on the next turn: the next write replaces
 * the bad file with a valid record. This keeps the route's branch table
 * simple — there is no "the record exists but is broken" branch.
 */
export async function readChatSession(
  repoLocalPath: string,
  issueId: string,
): Promise<ChatSessionRecord | null> {
  const path = chatSessionPath(repoLocalPath, issueId);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isChatSessionRecord(parsed)) return null;
  return parsed;
}

/**
 * Write the chat session record for an issue. Atomic temp+rename so a
 * partial write never lands on disk. Creates the chat-sessions dir on
 * first write (idempotent — `mkdir({recursive: true})` is a no-op when the
 * dir already exists).
 *
 * Stamps `updated_at: now` server-side; callers cannot inject a backdated
 * timestamp.
 */
export async function writeChatSession(
  repoLocalPath: string,
  issueId: string,
  dispatchId: string,
): Promise<void> {
  const path = chatSessionPath(repoLocalPath, issueId);
  if (typeof dispatchId !== "string" || dispatchId.trim() === "") {
    throw new Error("Invalid dispatch_id — must be a non-empty string");
  }
  const record: ChatSessionRecord = {
    dispatch_id: dispatchId,
    updated_at: new Date().toISOString(),
  };
  const dir = resolve(path, "..");
  await mkdir(dir, { recursive: true });
  // Include a random suffix on the temp file so two concurrent writes to
  // the same issue id never trip the `rename` atomicity guarantee (each
  // gets its own temp; the last rename wins, which is the desired
  // last-writer semantics).
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf-8");
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup if rename failed — leave nothing on disk.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function isChatSessionRecord(value: unknown): value is ChatSessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.dispatch_id === "string" &&
    obj.dispatch_id.length > 0 &&
    typeof obj.updated_at === "string" &&
    obj.updated_at.length > 0
  );
}
