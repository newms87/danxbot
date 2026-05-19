import type { RepairErrorWithAttempts, SystemError } from "../types";
import { fetchWithAuth, labelRequest } from "./_request";

/** DX-134 — ephemeral in-memory event ring (powers the banner). */
export async function fetchSystemErrors(opts: {
  repo?: string;
  limit?: number;
} = {}): Promise<SystemError[]> {
  const params = new URLSearchParams();
  if (opts.repo) params.set("repo", opts.repo);
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetchWithAuth(`/api/system-errors${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`fetchSystemErrors failed: ${res.status}`);
  const body = (await res.json()) as { events: SystemError[] };
  return body.events;
}

/**
 * DX-565 — persistent `system_errors` table + per-attempt repair history
 * for the Self-Repair tab. Distinct from `fetchSystemErrors` (DX-134).
 */
export async function fetchRepairErrors(opts: {
  repo?: string;
  limit?: number;
} = {}): Promise<RepairErrorWithAttempts[]> {
  const params = new URLSearchParams();
  if (opts.repo) params.set("repo", opts.repo);
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetchWithAuth(
    `/api/self-repair/errors${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) throw new Error(`fetchRepairErrors failed: ${res.status}`);
  const body = (await res.json()) as { errors: RepairErrorWithAttempts[] };
  return body.errors;
}

export async function fetchRepairErrorDetail(
  id: number,
): Promise<RepairErrorWithAttempts> {
  return labelRequest(
    "fetchRepairErrorDetail",
    "GET",
    `/api/self-repair/errors/${encodeURIComponent(String(id))}`,
  );
}

export async function resetRepairErrorById(
  id: number,
): Promise<{ row: RepairErrorWithAttempts["error"] }> {
  return labelRequest(
    "resetRepairError",
    "POST",
    `/api/self-repair/errors/${encodeURIComponent(String(id))}/reset`,
  );
}

export async function markRepairErrorUnfixable(
  id: number,
): Promise<{ row: RepairErrorWithAttempts["error"] }> {
  return labelRequest(
    "markUnfixable",
    "POST",
    `/api/self-repair/errors/${encodeURIComponent(String(id))}/unfixable`,
  );
}
