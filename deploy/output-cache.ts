/**
 * Per-target Terraform outputs cache.
 *
 * Read-only deploy commands (`create-user`, `ssh`, `smoke`, etc.) only need
 * `publicIp` (and occasionally `ecrRepositoryUrl`) to do their work. Without
 * a cache they pay the full Terraform pre-flight cost on every invocation:
 *
 *   bootstrap (s3api head-bucket + dynamodb describe-table) ~2s
 *   terraform init -reconfigure                              ~5s
 *   terraform output -json                                   ~3s
 *   ─────────────────────────────────────────────────────────────
 *   ~10s of pure overhead before the SSH connect even starts.
 *
 * After every successful `deploy` (or any path that calls `terraformApply`)
 * we serialize the resolved outputs to `deploy/targets/.cache/<target>.json`.
 * Read-only commands that only need IP/ECR/etc. read this file first and skip
 * the entire Terraform chain on a hit. Cache miss falls back to the existing
 * Terraform path so the optimization is a pure speed-up — never a correctness
 * change.
 *
 * Cache lifecycle:
 *   - written by `deploy` (and any other path that runs `terraformApply`)
 *   - read by read-only commands that opt in (currently `create-user`)
 *   - cleared by `destroy` (handled in `cli.ts`'s destroy branch)
 *
 * The cache directory is gitignored. The cache is also re-validated structurally
 * on every read — corrupt JSON, missing fields, or empty strings all produce a
 * `null` so the caller falls back to Terraform without ever throwing.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { TerraformOutputs } from "./provision.js";

export interface CachedOutputs extends TerraformOutputs {
  cachedAt: string;
}

// Exhaustive — every CachedOutputs field is required. If `provision.ts` adds
// an output the cache should track, add it here too. A cache file missing any
// listed field is rejected (read returns null, caller falls back to terraform).
// The rigidity is intentional: a cache that lies by omission is worse than no
// cache.
const REQUIRED_FIELDS: readonly (keyof CachedOutputs)[] = [
  "publicIp",
  "instanceId",
  "domain",
  "ecrRepositoryUrl",
  "sshCommand",
  "securityGroupId",
  "dataVolumeId",
  "iamRoleArn",
  "cachedAt",
];

export function defaultCacheRoot(cwd: string = process.cwd()): string {
  return resolve(cwd, "deploy/targets/.cache");
}

export function cachePath(
  target: string,
  root: string = defaultCacheRoot(),
): string {
  return resolve(root, `${target}.json`);
}

export function readCachedOutputs(
  target: string,
  root: string = defaultCacheRoot(),
): CachedOutputs | null {
  const p = cachePath(target, root);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCachedOutputs(parsed)) return null;
  return parsed;
}

export function writeCachedOutputs(
  target: string,
  outputs: TerraformOutputs,
  root: string = defaultCacheRoot(),
): void {
  const p = cachePath(target, root);
  mkdirSync(dirname(p), { recursive: true });
  const payload: CachedOutputs = {
    ...outputs,
    cachedAt: new Date().toISOString(),
  };
  // Atomic-ish: write to a sibling tmp file then rename. Prevents readers
  // from observing a half-written JSON document if the process is killed
  // mid-write. If the rename fails (cross-device, EPERM, etc.) clean up the
  // tmp file so the directory doesn't accumulate orphans across retries.
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  try {
    renameSync(tmp, p);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function clearCachedOutputs(
  target: string,
  root: string = defaultCacheRoot(),
): void {
  const p = cachePath(target, root);
  if (existsSync(p)) rmSync(p, { force: true });
}

function isCachedOutputs(v: unknown): v is CachedOutputs {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  for (const k of REQUIRED_FIELDS) {
    const val = o[k];
    if (typeof val !== "string" || val.length === 0) return false;
  }
  return true;
}
