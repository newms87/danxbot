import type {
  AgentRecordWithName,
  AgentRosterResponse,
  AgentRuntimeState,
  AgentSchedule,
  AgentSnapshot,
  EffortLevelMapping,
  EffortLevelName,
  Feature,
} from "../types";
import {
  fetchWithAuth,
  jsonRequest,
  labelRequest,
  readJsonError,
  toggleError,
} from "./_request";

// ── Read ────────────────────────────────────────────────────────────

/** Per-repo agent snapshots — see `src/dashboard/agents-list.ts`. */
export async function fetchAgents(): Promise<AgentSnapshot[]> {
  return labelRequest("fetchAgents", "GET", "/api/agents");
}

export async function fetchAgent(repo: string): Promise<AgentSnapshot> {
  return labelRequest(
    "fetchAgent",
    "GET",
    `/api/agents/${encodeURIComponent(repo)}`,
  );
}

/**
 * GET /api/agents/:repo/state — DX-684. Aggregates worker-owned runtime
 * files (CRITICAL_FAILURE, sync-root-state, settings-runtime) into one
 * payload so the SPA renders the per-repo panel without N round-trips.
 */
export async function fetchAgentRuntimeState(
  repo: string,
): Promise<AgentRuntimeState> {
  return labelRequest(
    "fetchAgentRuntimeState",
    "GET",
    `/api/agents/${encodeURIComponent(repo)}/state`,
  );
}

/**
 * GET /api/agents?repo=<name> — DX-159. Roster shape (distinct from the
 * snapshot returned by `/api/agents/:repo`). Same path, two response
 * shapes — see `agents-toggles.ts#handleGetRoster`.
 */
export async function fetchAgentRoster(
  repo: string,
): Promise<AgentRosterResponse> {
  return labelRequest(
    "fetchAgentRoster",
    "GET",
    `/api/agents?repo=${encodeURIComponent(repo)}`,
  );
}

// ── CRUD (DX-160) ───────────────────────────────────────────────────

export interface AgentCreateInput {
  name: string;
  bio: string;
  capabilities: string[];
  schedule: AgentSchedule;
  enabled: boolean;
  avatar_path?: string;
}

export type AgentUpdateInput = Partial<Omit<AgentCreateInput, "name">> & {
  /** DX-510 operator-tunable per-agent effort label. */
  effortLevel?: EffortLevelName;
};

export async function createAgent(
  repo: string,
  input: AgentCreateInput,
): Promise<AgentRecordWithName> {
  return jsonRequest(
    "POST",
    `/api/agents?repo=${encodeURIComponent(repo)}`,
    input,
  );
}

/** `name` is immutable server-side (400 on attempt). */
export async function updateAgent(
  repo: string,
  name: string,
  input: AgentUpdateInput,
): Promise<AgentRecordWithName> {
  return jsonRequest(
    "PATCH",
    `/api/agents/${encodeURIComponent(name)}?repo=${encodeURIComponent(repo)}`,
    input,
  );
}

/** 204 on success; 409 when a non-terminal dispatch is in flight. */
export async function deleteAgent(repo: string, name: string): Promise<void> {
  await jsonRequest<void>(
    "DELETE",
    `/api/agents/${encodeURIComponent(name)}?repo=${encodeURIComponent(repo)}`,
  );
}

// ── Broken/Unblock (DX-298, DX-363, DX-367) ─────────────────────────

/** DX-298 — Mark Resolved. PATCH `{broken: null}`; SET broken is worker-only. */
export async function clearAgentBroken(
  repo: string,
  name: string,
): Promise<AgentRecordWithName> {
  return jsonRequest(
    "PATCH",
    `/api/agents/${encodeURIComponent(name)}?repo=${encodeURIComponent(repo)}`,
    { broken: null },
  );
}

/**
 * DX-369 — Unblock + reset strikes. Clears `broken`, zeros `strikes.count`,
 * preserves `strikes.history` as audit. Watcher → SSE `agent:updated`.
 */
export async function postAgentUnblock(
  repo: string,
  name: string,
): Promise<{
  status: "cleared";
  repo: string;
  agent: string;
  cleared_strikes: { count: number; history: unknown[] } | null;
}> {
  return jsonRequest(
    "POST",
    `/api/agents/${encodeURIComponent(repo)}/unblock`,
    { name },
  );
}

/** DX-369 — flips `broken.evaluator_status` back to `"pending"`. */
export async function postAgentReRunEvaluator(
  repo: string,
  name: string,
): Promise<{ status: "queued"; repo: string; agent: string }> {
  return jsonRequest(
    "POST",
    `/api/agents/${encodeURIComponent(repo)}/re-run-evaluator`,
    { name },
  );
}

// ── Avatars ─────────────────────────────────────────────────────────

/**
 * POST avatar — raw bytes with file's MIME (no multipart). Server
 * validates MIME (png/jpeg/webp) + size (≤1 MB).
 */
export async function uploadAgentAvatar(
  repo: string,
  name: string,
  file: File,
): Promise<AgentRecordWithName> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}/avatar?repo=${encodeURIComponent(repo)}`,
    { method: "POST", headers: { "Content-Type": file.type }, body: file },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

/**
 * Authed avatar fetch returning a `blob:` URL. 404 → null. Caller MUST
 * `URL.revokeObjectURL` on unmount to free memory.
 */
export async function fetchAgentAvatarUrl(
  repo: string,
  name: string,
): Promise<string | null> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}/avatar?repo=${encodeURIComponent(repo)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return URL.createObjectURL(await res.blob());
}

// ── Critical failure + feature toggles ──────────────────────────────

export interface ClearCriticalFailureResult {
  cleared: boolean;
}

/** Clear per-repo CRITICAL_FAILURE flag. Idempotent. */
export async function clearCriticalFailure(
  repo: string,
): Promise<ClearCriticalFailureResult> {
  return jsonRequest(
    "DELETE",
    `/api/agents/${encodeURIComponent(repo)}/critical-failure`,
  );
}

/** `enabled: null` resets a feature back to the env default. */
export async function patchToggle(
  repo: string,
  feature: Feature,
  enabled: boolean | null,
): Promise<AgentSnapshot> {
  return jsonRequest(
    "PATCH",
    `/api/agents/${encodeURIComponent(repo)}/toggles`,
    { feature, enabled },
  );
}

// ── Effort settings (DX-510) ────────────────────────────────────────

export interface EffortSettingsPatch {
  effortLevels?: EffortLevelMapping[];
  effortAssignmentPrompt?: string;
}

export async function patchEffortSettings(
  repo: string,
  patch: EffortSettingsPatch,
): Promise<AgentSnapshot> {
  return jsonRequest(
    "PATCH",
    `/api/agents/${encodeURIComponent(repo)}/effort-settings`,
    patch,
  );
}
