/**
 * DX-540 — Shared SFC (Single File Component) deps provisioning.
 *
 * Each consumer repo (e.g. gpt-manager) publishes a `shared_deps_lock.json`
 * declaring the exact versions of runtime deps it provides to per-template
 * Vue modules built by the DX-539 `/api/template-build` endpoint. The
 * danxbot host materializes one `node_modules/` per `shell_version` under
 * `/srv/sfc-deps/<shell_version>/node_modules/` so the build endpoint can
 * symlink the matching deps in without paying `npm install` per build.
 *
 * Schema is intentionally minimal — flat `name -> version` map plus a
 * `shell_version` identifier — so consumers can publish it from any build
 * tool and so the provisioner can run `npm install` against a generated
 * `package.json` with no further translation.
 */

export interface SharedDepsManifest {
  /**
   * Identifier the consumer chose to tag this dependency set. Used as
   * the directory name under `/srv/sfc-deps/`. Free-form but constrained
   * to safe-path chars (regex `^[A-Za-z0-9._-]+$`) so the provisioner
   * never writes outside its base dir.
   */
  shell_version: string;

  /**
   * Flat npm package name -> exact version. Versions MUST be exact
   * (not ranges) because the build endpoint's caller assumes a
   * deterministic deps set per `shell_version`. The provisioner does
   * NOT enforce exactness — that is the consumer's contract.
   */
  deps: Record<string, string>;

  /**
   * Optional ISO 8601 timestamp the consumer stamped when publishing.
   * Surfaces in logs + the `provisioned_at` snapshot the provisioner
   * writes alongside `node_modules/`. Not required.
   */
  generated_at?: string;
}

/**
 * Loose-shaped entry returned by a `ManifestSource.list()`. Carries
 * enough info for the provisioner to fetch the manifest body without
 * leaking the source's transport details (S3 key vs local path).
 */
export interface ManifestEntry {
  shell_version: string;
  /**
   * Opaque source-specific locator. The S3 source uses an `s3://...`
   * URL; the local source uses an absolute filesystem path. The
   * provisioner passes it back to `source.fetch(entry)` verbatim.
   */
  locator: string;
}

export interface ManifestSource {
  /**
   * Enumerate every active manifest visible to this source. Returns
   * one entry per `shell_version`. Implementations are free to filter
   * by prefix internally; the provisioner does not constrain it.
   */
  list(): Promise<ManifestEntry[]>;
  /**
   * Fetch the manifest body for a previously-listed entry. The source
   * is responsible for parsing JSON + validating shape.
   */
  fetch(entry: ManifestEntry): Promise<SharedDepsManifest>;
}

export interface ProvisionLogLineSuccess {
  readonly kind: "provisioned" | "skipped-up-to-date" | "skipped-malformed";
  readonly shell_version: string;
  readonly target_dir: string;
  readonly duration_ms?: number;
  readonly reason?: string;
}

export interface ProvisionLogLineError {
  readonly kind: "error";
  readonly shell_version: string;
  readonly target_dir: string;
  readonly error: string;
}

export type ProvisionLogLine =
  | ProvisionLogLineSuccess
  | ProvisionLogLineError;

export interface ProvisionResult {
  readonly provisioned: string[];
  readonly skipped: string[];
  readonly failed: Array<{ shell_version: string; error: string }>;
}

export interface PruneLogLineSuccess {
  readonly kind: "pruned" | "skipped-active" | "skipped-fresh";
  readonly shell_version: string;
  readonly target_dir: string;
  readonly reason?: string;
}

export interface PruneLogLineError {
  readonly kind: "error";
  readonly shell_version: string;
  readonly target_dir: string;
  readonly error: string;
}

export type PruneLogLine = PruneLogLineSuccess | PruneLogLineError;

export interface PruneResult {
  readonly pruned: string[];
  readonly kept: string[];
  readonly failed: Array<{ shell_version: string; error: string }>;
}

/**
 * Regex the provisioner + prune use to gate any path segment that
 * lands under the base dir. Mirrors the DX-539 `validateBody`
 * `safeId` regex so a manifest cannot escape `/srv/sfc-deps/`.
 */
export const SHELL_VERSION_REGEX = /^[A-Za-z0-9._-]+$/;

/**
 * Filename the provisioner writes inside each provisioned dir to
 * record the manifest it materialized against. Used by:
 *   - the provisioner's idempotence check (skip if existing snapshot
 *     hash matches the new manifest)
 *   - the prune job's "active vs stale" decision (active = listed by
 *     the manifest source on this tick).
 */
export const SNAPSHOT_FILENAME = "shared_deps_lock.json";

export function isValidShellVersion(v: string): boolean {
  return SHELL_VERSION_REGEX.test(v);
}

/**
 * Type guard for a parsed `shared_deps_lock.json` body. Used at every
 * source-of-truth boundary (S3 fetch, local fetch, snapshot read) so
 * downstream code can trust the shape.
 */
export function isSharedDepsManifest(x: unknown): x is SharedDepsManifest {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (typeof obj.shell_version !== "string") return false;
  if (typeof obj.deps !== "object" || obj.deps === null) return false;
  for (const v of Object.values(obj.deps as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}
