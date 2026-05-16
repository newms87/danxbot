/**
 * Per-worktree host-port allocator.
 *
 * Worktree compose stacks are independent compose projects that all reuse the
 * same docker-compose.yml from the consumer repo. The compose file already
 * declares every host-port mapping via `${VAR:-default}` env interpolation
 * (APP_PORT, FORWARD_DB_PORT, FORWARD_REDIS_PORT, FORWARD_MAILPIT_PORT,
 * FORWARD_MAILPIT_DASHBOARD_PORT, VITE_PORT). Without per-worktree overrides,
 * two worktrees racing `docker compose up` collide on the host port — the
 * first wins and the rest fail with "Bind for 0.0.0.0:<port> failed".
 *
 * This module owns the per-worktree offset allocation and the offset-to-port
 * derivation. It is the single source of truth for which host port maps to
 * which worktree on this host.
 *
 * Design:
 *   - Persistent registry at `<repo>/.danxbot/worktree-ports.json` maps
 *     worktree-name → offset (1..MAX_OFFSET). The file survives reruns so a
 *     worktree's ports never change once allocated.
 *   - The root repo's existing .env (which the operator authored) is the
 *     reserved baseline — its ports are NEVER reallocated. Worktree port
 *     ranges are picked to be disjoint from typical root values.
 *   - `allocateOffset` returns the existing offset for a known worktree, or
 *     the smallest unused offset for a new one (mutates the registry).
 *   - `derivePortOverrides` maps an offset to the env-var values that get
 *     merged into the worktree's .env at provision time.
 *
 * Range allocation (offset N in 1..98 — fits inside the 100-slot block we
 * picked for each port family):
 *   APP_PORT                       = 28000 + N   (28001..28098)
 *   FORWARD_DB_PORT                = 25400 + N   (25401..25498)
 *   FORWARD_REDIS_PORT             = 26300 + N   (26301..26398)
 *   FORWARD_MAILPIT_PORT           = 21000 + N   (21001..21098)
 *   FORWARD_MAILPIT_DASHBOARD_PORT = 28100 + N   (28101..28198)
 *   VITE_PORT                      = 25100 + N   (25101..25198)
 *
 * All ranges sit above the operator's typical root values (8080/5444/6399/
 * 1099/8099/5173) so a worktree port can never collide with the root repo's
 * compose stack.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PORT_REGISTRY_RELATIVE = ".danxbot/worktree-ports.json";

export const MAX_OFFSET = 98;

/**
 * Env-var bases. Worktree port = base + offset.
 * Keep this object exported — tests assert the derivation and the bash
 * one-shot migration script reads the same bases.
 */
export const PORT_BASES: Record<string, number> = {
  APP_PORT: 28000,
  FORWARD_DB_PORT: 25400,
  FORWARD_REDIS_PORT: 26300,
  FORWARD_MAILPIT_PORT: 21000,
  FORWARD_MAILPIT_DASHBOARD_PORT: 28100,
  VITE_PORT: 25100,
};

export interface PortRegistry {
  /** Map of worktree-name → offset (1..MAX_OFFSET). */
  offsets: Record<string, number>;
}

export class WorktreePortError extends Error {}

export function registryPath(repoRoot: string): string {
  return join(repoRoot, PORT_REGISTRY_RELATIVE);
}

export function readRegistry(repoRoot: string): PortRegistry {
  const path = registryPath(repoRoot);
  if (!existsSync(path)) {
    return { offsets: {} };
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorktreePortError(
      `worktree-ports registry at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("offsets" in parsed) ||
    typeof (parsed as { offsets: unknown }).offsets !== "object" ||
    (parsed as { offsets: unknown }).offsets === null
  ) {
    throw new WorktreePortError(
      `worktree-ports registry at ${path} is missing the 'offsets' object`,
    );
  }
  const offsets: Record<string, number> = {};
  for (const [name, value] of Object.entries(
    (parsed as { offsets: Record<string, unknown> }).offsets,
  )) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_OFFSET
    ) {
      throw new WorktreePortError(
        `worktree-ports registry at ${path}: offset for '${name}' must be an integer in [1, ${MAX_OFFSET}], got ${JSON.stringify(value)}`,
      );
    }
    offsets[name] = value;
  }
  return { offsets };
}

export function writeRegistry(repoRoot: string, registry: PortRegistry): void {
  const path = registryPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const sorted: Record<string, number> = {};
  for (const name of Object.keys(registry.offsets).sort()) {
    sorted[name] = registry.offsets[name];
  }
  const payload = JSON.stringify({ offsets: sorted }, null, 2) + "\n";
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Return the offset for `worktreeName`. Reuses an existing assignment;
 * otherwise picks the smallest unused offset and mutates `registry.offsets`.
 * Caller is responsible for `writeRegistry` if a new offset was assigned.
 */
export function allocateOffset(
  registry: PortRegistry,
  worktreeName: string,
): number {
  const existing = registry.offsets[worktreeName];
  if (existing !== undefined) {
    return existing;
  }
  const taken = new Set(Object.values(registry.offsets));
  for (let candidate = 1; candidate <= MAX_OFFSET; candidate += 1) {
    if (!taken.has(candidate)) {
      registry.offsets[worktreeName] = candidate;
      return candidate;
    }
  }
  throw new WorktreePortError(
    `worktree-ports registry is full — all ${MAX_OFFSET} offsets are in use`,
  );
}

export function derivePortOverrides(offset: number): Record<string, string> {
  if (!Number.isInteger(offset) || offset < 1 || offset > MAX_OFFSET) {
    throw new WorktreePortError(
      `offset must be an integer in [1, ${MAX_OFFSET}], got ${offset}`,
    );
  }
  const overrides: Record<string, string> = {};
  for (const [key, base] of Object.entries(PORT_BASES)) {
    overrides[key] = String(base + offset);
  }
  return overrides;
}

/**
 * Convenience: allocate + derive in one call, persisting the registry on
 * first allocation. Returns the overrides to merge into the worktree .env.
 */
export function provisionWorktreePorts(
  repoRoot: string,
  worktreeName: string,
): Record<string, string> {
  const registry = readRegistry(repoRoot);
  const before = registry.offsets[worktreeName];
  const offset = allocateOffset(registry, worktreeName);
  if (before === undefined) {
    writeRegistry(repoRoot, registry);
  }
  return derivePortOverrides(offset);
}
