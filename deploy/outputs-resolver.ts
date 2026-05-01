/**
 * One-stop resolver for Terraform outputs across read-only deploy commands.
 *
 * Before this helper existed, every read-only command (`status`, `ssh`,
 * `logs`, `create-user`, `ensure-root-user`) paid a ~10s pre-flight tax:
 *
 *   bootstrap (s3api head-bucket + dynamodb describe-table) ~2s
 *   terraform init -reconfigure                              ~5s
 *   terraform output -json                                   ~3s
 *
 * `output-cache.ts` introduced a per-target serialization of the resolved
 * outputs after every successful `terraformApply`. This module is the
 * read side: every read-only command goes through `resolveOutputs(target,
 * config)` which checks the cache, falls back to the full Terraform path
 * on miss, and writes the freshly-fetched outputs back into the cache so
 * the NEXT call hits.
 *
 * Why a dedicated helper instead of inlining `readCachedOutputs` everywhere:
 * the gating contract ("hit means skip terraform pre-flight, miss means
 * run it") used to live in `cli.ts` AND inside `defaultCreateUserDeps()`,
 * with an `if (!cached) ensureBackend(config)` bridge between them. A test
 * fake injecting custom deps could silently skip `ensureBackend` while
 * the cache miss path inside `resolveIp` then ran terraform without a
 * configured backend. This helper collapses the bridge: cli.ts gets
 * `TerraformOutputs` and never has to know about the cache or
 * `ensureBackend`.
 */

import type { DeployConfig } from "./config.js";
import {
  CachedOutputs,
  readCachedOutputs,
  writeCachedOutputs,
} from "./output-cache.js";
import { bootstrapBackend } from "./bootstrap.js";
import {
  getTerraformOutputs,
  terraformInit,
  TerraformOutputs,
} from "./provision.js";

export interface ResolveOutputsDeps {
  ensureBackend(config: DeployConfig): void;
  fetchOutputs(): TerraformOutputs;
  readCache(target: string): CachedOutputs | null;
  writeCache(target: string, outputs: TerraformOutputs): void;
}

export function defaultResolveOutputsDeps(): ResolveOutputsDeps {
  return {
    ensureBackend: (config) => {
      bootstrapBackend(config);
      terraformInit(config);
    },
    fetchOutputs: getTerraformOutputs,
    readCache: readCachedOutputs,
    writeCache: writeCachedOutputs,
  };
}

/**
 * Cache-first resolver. On hit, returns the stored outputs without touching
 * Terraform. On miss, runs `bootstrap → init → output -json`, writes the
 * result to the cache, and returns it.
 *
 * Idempotent: a hit is a pure read; a miss is the full Terraform path. The
 * cache write on miss is best-effort — a write failure is not silenced; the
 * caller sees the throw because a cache that can't be written is a real
 * configuration error worth surfacing (permissions, full disk, etc.).
 */
export function resolveOutputs(
  target: string,
  config: DeployConfig,
  deps: ResolveOutputsDeps = defaultResolveOutputsDeps(),
): TerraformOutputs {
  const cached = deps.readCache(target);
  if (cached) {
    const { cachedAt: _cachedAt, ...outputs } = cached;
    return outputs;
  }
  deps.ensureBackend(config);
  const outputs = deps.fetchOutputs();
  deps.writeCache(target, outputs);
  return outputs;
}
