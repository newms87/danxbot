/**
 * Single source of truth for "which connected repos does this danxbot
 * environment serve."
 *
 * Pre-Phase-B this lived in two parallel CSV env vars in the local `.env`
 * (`REPOS=name:url,...` + `REPO_WORKER_PORTS=name:port,...`) plus an
 * optional `REPO_WORKER_HOSTS=name:host,...`. Production synthesized the
 * same env vars from the deploy YML (`deploy/secrets.ts#buildTargetOverrides`)
 * and pushed them to SSM. The two surfaces routinely desynced — a port
 * change in `<repo>/.danxbot/.env` would never reach the root `.env`'s
 * REPO_WORKER_PORTS, and the dashboard would silently 502 trying to proxy
 * to the wrong port.
 *
 * Phase B collapses both to a single per-target YML at
 * `deploy/targets/<TARGET>.yml`. The local dev environment uses the
 * `local` target (with `mode: local`); each AWS deploy uses its own
 * (`gpt`, `platform`, ...). The deploy CLI rejects `mode: local` so an
 * operator can't accidentally push their dev list to AWS.
 *
 * Active target name resolution:
 *   1. process.env.DANXBOT_TARGET when set (production compose injects
 *      this from the deploy YML's `name`).
 *   2. "local" otherwise — covers local dev, tests, ad-hoc CLI invocations.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RepoConfig } from "./types.js";
import { getReposBase } from "./poller/constants.js";

export type TargetMode = "local" | "deploy";

export interface ResolvedTarget {
  name: string;
  mode: TargetMode;
  repos: RepoConfig[];
}

/**
 * Read `deploy/targets/<targetName>.yml` from the danxbot product root,
 * walking up from `startDir` to find it. The YML is the SAME shape used
 * by the deploy CLI (`deploy/config.ts#loadConfig`) but this loader only
 * reads the runtime-relevant slice (`name`, `mode`, `repos`) — it does
 * NOT validate AWS-specific fields, so it can also load `local.yml`
 * which has placeholder values for those fields.
 *
 * Defaults `mode` to `"deploy"` when omitted (matches gpt.yml /
 * platform.yml's existing shape — they never had a `mode` field).
 *
 * Throws on:
 *   - Target file missing — operator hasn't created the target yet.
 *   - Malformed YAML — caller passes garbage.
 *   - `repos[]` entry missing required fields (name, url, worker_port).
 *
 * Does NOT throw on `repos: []` — an empty repo list is valid (a fresh
 * install before the operator wires up any connected repos).
 */
export function loadTarget(
  targetName: string = process.env["DANXBOT_TARGET"] ?? "local",
  startDir: string = process.cwd(),
): ResolvedTarget {
  const path = findTargetPath(targetName, startDir);
  const raw = readFileSync(path, "utf-8");
  const yaml = parseYaml(raw) as Record<string, unknown> | null;
  if (!yaml || typeof yaml !== "object" || Array.isArray(yaml)) {
    throw new Error(`Invalid YAML in ${path}: expected a mapping at the top level`);
  }

  // `name` is a human-readable deployment identifier (e.g. "danxbot-production"
  // for gpt.yml). No runtime consumer reads it for routing decisions — only
  // `repos[]` matters at runtime — so falling back to the target filename when
  // the field is omitted is a display-only convenience, not a silent
  // configuration fallback. The deploy CLI (`deploy/config.ts`) enforces a
  // stricter contract for AWS-bound targets.
  const name = typeof yaml["name"] === "string" ? yaml["name"] : targetName;
  const modeRaw = yaml["mode"];
  let mode: TargetMode = "deploy";
  if (modeRaw !== undefined && modeRaw !== null) {
    if (modeRaw !== "local" && modeRaw !== "deploy") {
      throw new Error(
        `Invalid \`mode\` in ${path}: expected "local" or "deploy" (got ${JSON.stringify(modeRaw)})`,
      );
    }
    mode = modeRaw;
  }

  const repos: RepoConfig[] = [];
  const reposRaw = yaml["repos"];
  if (reposRaw !== undefined && reposRaw !== null) {
    if (!Array.isArray(reposRaw)) {
      throw new Error(`Invalid \`repos\` in ${path}: expected an array`);
    }
    for (const entry of reposRaw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`Invalid repos[] entry in ${path}: each entry must be a mapping`);
      }
      const e = entry as Record<string, unknown>;
      const repoName = e["name"];
      const repoUrl = e["url"];
      const workerPort = e["worker_port"];
      const workerHost = e["worker_host"];
      if (typeof repoName !== "string" || repoName.trim() === "") {
        throw new Error(`Invalid repos[].name in ${path}: required non-empty string`);
      }
      if (typeof repoUrl !== "string" || repoUrl.trim() === "") {
        throw new Error(`Invalid repos[].url in ${path} (repo "${repoName}"): required non-empty string`);
      }
      if (
        typeof workerPort !== "number" ||
        !Number.isInteger(workerPort) ||
        workerPort < 1 ||
        workerPort > 65535
      ) {
        throw new Error(
          `Invalid repos[].worker_port in ${path} (repo "${repoName}"): required integer in [1, 65535]`,
        );
      }
      const repo: RepoConfig = {
        name: repoName.trim(),
        url: repoUrl.trim(),
        localPath: `${getReposBase()}/${repoName.trim()}`,
        workerPort,
      };
      if (workerHost !== undefined && workerHost !== null) {
        if (typeof workerHost !== "string" || workerHost.trim() === "" || /\s/.test(workerHost.trim())) {
          throw new Error(
            `Invalid repos[].worker_host in ${path} (repo "${repoName}"): required non-empty whitespace-free string`,
          );
        }
        repo.workerHost = workerHost.trim();
      }
      repos.push(repo);
    }
  }

  return { name, mode, repos };
}

/**
 * Walk up from `startDir` looking for `deploy/targets/<targetName>.yml`.
 * Throws with a clear, actionable message on miss — the operator either
 * needs to `cd` into the danxbot product root or create the target file.
 */
export function findTargetPath(targetName: string, startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  const root = resolve("/");
  while (dir !== root) {
    const candidate = resolve(dir, "deploy/targets", `${targetName}.yml`);
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, "..");
  }
  throw new Error(
    `No deploy/targets/${targetName}.yml found walking up from ${startDir}. ` +
      `Create it (start from deploy/targets/example.yml) or set DANXBOT_TARGET to an existing target.`,
  );
}
