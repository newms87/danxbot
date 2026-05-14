/**
 * Manifest sources — where the SFC-deps provisioner discovers + reads
 * `shared_deps_lock.json` files from.
 *
 *   - S3 — the production source. Shells out to `aws s3 ls` /
 *     `aws s3 cp - -` exactly like `deploy/secrets.ts` does, so the
 *     existing AWS credential chain (instance role, profile, env)
 *     applies with no extra config. Tests inject a fake `runCmd` to
 *     drive the lister + fetcher without a real `aws` binary.
 *   - Local — the dev / test source. Reads `<dir>/<version>/shared_deps_lock.json`
 *     from a host directory. Useful for `docker-compose.override.yml`
 *     setups and the integration test.
 *
 * `resolveManifestSourceFromEnv` picks one based on the danxbot
 * runtime env vars and is the single entry point both the cron job
 * and the CLI script call.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isValidShellVersion,
  isSharedDepsManifest,
  type ManifestEntry,
  type ManifestSource,
  type SharedDepsManifest,
} from "./types.js";

/**
 * Defense-in-depth cap on a single manifest body — `shared_deps_lock.json`
 * for a real consumer is under 8 KiB even with dozens of packages.
 * Anything bigger is almost certainly a misuse of the bucket prefix.
 */
const MAX_MANIFEST_BYTES = 256 * 1024;

const execFileAsync = promisify(execFile);

export type RunCmdFn = (cmd: string, args: string[]) => Promise<string>;

async function defaultRunCmd(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export interface S3ManifestSourceOptions {
  /** S3 bucket holding the manifests, e.g. `danxbot-template-shell`. */
  bucket: string;
  /** Prefix WITHIN the bucket, default `template-shell/`. Trailing slash optional. */
  prefix?: string;
  /** AWS profile, default `default`. */
  awsProfile?: string;
  /** AWS region, optional — defaults to whatever the profile / instance role resolves. */
  awsRegion?: string;
  /** Inject the command runner — tests pass a fake. */
  runCmd?: RunCmdFn;
}

function normalizePrefix(prefix: string): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function buildAwsArgs(
  opts: { awsProfile?: string; awsRegion?: string },
  extra: string[],
): string[] {
  const args: string[] = [];
  if (opts.awsProfile) args.push("--profile", opts.awsProfile);
  if (opts.awsRegion) args.push("--region", opts.awsRegion);
  return [...args, ...extra];
}

/**
 * Parse `aws s3 ls s3://bucket/prefix/` output. The aws CLI prints
 * subdirs as:
 *   "                           PRE <name>/"
 * and objects as
 *   "<date> <time> <bytes> <key>"
 * We only care about subdir entries — those map 1:1 to shell_versions.
 */
function parseS3LsPrefixes(stdout: string): string[] {
  const out: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    // Anchored: optional whitespace prefix, literal `PRE`, one or more
    // whitespace chars, then the prefix name (no embedded `/`) followed
    // by the trailing `/`. Rejects object-row lines whose text happens
    // to contain "PRE" inside a key.
    const m = /^\s+PRE\s+([^/\s][^/]*)\/\s*$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!isValidShellVersion(name)) continue;
    out.push(name);
  }
  return out;
}

function validateManifestBody(
  raw: string,
  expectedShellVersion: string,
): SharedDepsManifest {
  if (raw.length > MAX_MANIFEST_BYTES) {
    throw new Error(
      `manifest body exceeds ${MAX_MANIFEST_BYTES} bytes (${raw.length})`,
    );
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isSharedDepsManifest(parsed)) {
    throw new Error("manifest body shape mismatch");
  }
  if (parsed.shell_version !== expectedShellVersion) {
    throw new Error(
      `manifest shell_version "${parsed.shell_version}" does not match expected "${expectedShellVersion}"`,
    );
  }
  if (!isValidShellVersion(parsed.shell_version)) {
    throw new Error(
      `manifest shell_version "${parsed.shell_version}" contains unsafe chars`,
    );
  }
  return parsed;
}

export function createS3ManifestSource(
  opts: S3ManifestSourceOptions,
): ManifestSource & { kind: "s3" } {
  const prefix = normalizePrefix(opts.prefix ?? "template-shell/");
  const runCmd = opts.runCmd ?? defaultRunCmd;

  return {
    kind: "s3" as const,
    async list(): Promise<ManifestEntry[]> {
      const url = `s3://${opts.bucket}/${prefix}`;
      const stdout = await runCmd(
        "aws",
        buildAwsArgs(opts, ["s3", "ls", url]),
      );
      const names = parseS3LsPrefixes(stdout);
      return names.map((shell_version) => ({
        shell_version,
        locator: `s3://${opts.bucket}/${prefix}${shell_version}/shared_deps_lock.json`,
      }));
    },
    async fetch(entry: ManifestEntry): Promise<SharedDepsManifest> {
      const stdout = await runCmd(
        "aws",
        buildAwsArgs(opts, ["s3", "cp", entry.locator, "-"]),
      );
      return validateManifestBody(stdout, entry.shell_version);
    },
  };
}

export function createLocalManifestSource(
  dir: string,
): ManifestSource & { kind: "local"; dir: string } {
  return {
    kind: "local" as const,
    dir,
    async list(): Promise<ManifestEntry[]> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: ManifestEntry[] = [];
      for (const name of names) {
        if (!isValidShellVersion(name)) continue;
        const lockPath = join(dir, name, "shared_deps_lock.json");
        try {
          const st = await stat(lockPath);
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
        out.push({ shell_version: name, locator: lockPath });
      }
      return out;
    },
    async fetch(entry: ManifestEntry): Promise<SharedDepsManifest> {
      const text = await readFile(entry.locator, "utf8");
      return validateManifestBody(text, entry.shell_version);
    },
  };
}

export type ResolvedManifestSource =
  | (ManifestSource & { kind: "s3" })
  | (ManifestSource & { kind: "local"; dir: string });

export function resolveManifestSourceFromEnv(
  env: NodeJS.ProcessEnv,
): ResolvedManifestSource | null {
  const localDir = env.SFC_DEPS_LOCAL_MANIFEST_DIR;
  if (localDir) return createLocalManifestSource(localDir);
  const bucket = env.SFC_DEPS_S3_BUCKET;
  if (bucket)
    return createS3ManifestSource({
      bucket,
      prefix: env.SFC_DEPS_S3_PREFIX,
      awsProfile: env.SFC_DEPS_AWS_PROFILE ?? env.AWS_PROFILE,
      awsRegion: env.SFC_DEPS_AWS_REGION ?? env.AWS_REGION,
    });
  return null;
}
