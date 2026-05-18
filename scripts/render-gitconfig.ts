#!/usr/bin/env -S tsx
/**
 * Worker entrypoint helper — DX-647 Phase 1.
 *
 * Validates `DANX_GITHUB_TOKEN`, renders `~/.gitconfig` (insteadOf URL
 * rewrites + [user] block) from env, and writes it atomically to one or
 * more target paths (default: `/root/.gitconfig` + `/home/danxbot/.gitconfig`).
 *
 * Writing happens INSIDE this script — never via shell stdout capture —
 * so the embedded PAT never lands in a bash variable a stray `set -x`
 * could echo to container logs.
 *
 * Failure modes (any → stderr + exit 1):
 *   - DANX_GITHUB_TOKEN missing / empty / malformed
 *   - DANXBOT_SSH_ALIASES malformed
 *
 * On token failure the script writes the per-repo
 * `.danxbot/CRITICAL_FAILURE` flag so the dashboard's existing
 * critical-failure surface lights up without UI work.
 *
 * Dashboard mode (no `DANXBOT_REPO_NAME`) is a silent no-op so the
 * entrypoint can invoke this unconditionally in BOTH modes — only one
 * mode-gate to keep in sync.
 *
 * Env overrides (test-only):
 *   - `DANXBOT_REPOS_DIR` — default `/danxbot/app/repos`
 *   - `DANXBOT_GITCONFIG_TARGETS` — comma-separated list of
 *     `<path>[:<owner-of-path>]`. `owner-of-path` (when present) is a
 *     directory whose uid:gid is reused to chown the rendered file —
 *     lets the danxbot user read its own `.gitconfig` without baking a
 *     hardcoded uid. Default:
 *     `/root/.gitconfig,/home/danxbot/.gitconfig:/home/danxbot`.
 */
import {
  chmodSync,
  chownSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { writeFlag } from "../src/critical-failure.js";
import {
  parseAliases,
  renderGitconfig,
  validateToken,
} from "../src/github-auth/gitconfig.js";

interface Target {
  path: string;
  /** When set, `chown` the rendered file to this dir's uid:gid. */
  ownerOf?: string;
}

function parseTargets(raw: string | undefined): Target[] {
  if (!raw) {
    return [
      { path: "/root/.gitconfig" },
      { path: "/home/danxbot/.gitconfig", ownerOf: "/home/danxbot" },
    ];
  }
  const out: Target[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [path, ownerOf] = trimmed.split(":", 2);
    if (!path) throw new Error(`DANXBOT_GITCONFIG_TARGETS entry "${trimmed}" malformed`);
    out.push(ownerOf ? { path, ownerOf } : { path });
  }
  return out;
}

const REPO_NAME = process.env.DANXBOT_REPO_NAME;
const TOKEN = process.env.DANX_GITHUB_TOKEN;
const EMAIL = process.env.DANXBOT_GIT_EMAIL || "danxbot@example.com";
const ALIASES_RAW = process.env.DANXBOT_SSH_ALIASES;
const REPOS_DIR = process.env.DANXBOT_REPOS_DIR || "/danxbot/app/repos";
const DASHBOARD_URL =
  process.env.DANXBOT_DASHBOARD_URL || "http://localhost:5566/agents";
const DASHBOARD_NOTE =
  "Settings > GitHub (lands in DX-649 — until then, edit the .env file directly).";

if (!REPO_NAME) {
  // Dashboard mode — no in-container git ops, nothing to render.
  process.exit(0);
}

const validation = validateToken(TOKEN);
if (!validation.ok) {
  const editPath = `<repo>/.danxbot/.env (this worker: ${REPO_NAME}/.danxbot/.env)`;
  const msg =
    `[render-gitconfig] FATAL: ${validation.error}\n` +
    `[render-gitconfig] Edit ${editPath} and set DANX_GITHUB_TOKEN to a valid GitHub PAT.\n` +
    `[render-gitconfig] Dashboard: ${DASHBOARD_URL} — ${DASHBOARD_NOTE}\n`;
  process.stderr.write(msg);

  const repoLocalPath = resolve(REPOS_DIR, REPO_NAME);
  try {
    writeFlag(repoLocalPath, {
      source: "entrypoint",
      dispatchId: "entrypoint",
      reason: validation.error,
      detail:
        `Worker entrypoint refused to start: DANX_GITHUB_TOKEN missing or ` +
        `malformed. Fix ${editPath} (or the SSM equivalent for prod) and ` +
        `restart the worker. Dashboard: ${DASHBOARD_URL}`,
    });
  } catch (err) {
    process.stderr.write(
      `[render-gitconfig] Failed to write CRITICAL_FAILURE flag: ${(err as Error).message}\n`,
    );
  }
  process.exit(1);
}

let aliases;
try {
  aliases = parseAliases(ALIASES_RAW);
} catch (err) {
  process.stderr.write(`[render-gitconfig] FATAL: ${(err as Error).message}\n`);
  process.exit(1);
}

let targets;
try {
  targets = parseTargets(process.env.DANXBOT_GITCONFIG_TARGETS);
} catch (err) {
  process.stderr.write(`[render-gitconfig] FATAL: ${(err as Error).message}\n`);
  process.exit(1);
}

const body = renderGitconfig({ token: validation.token, email: EMAIL, aliases });

for (const target of targets) {
  // mode 0o600 in the open() call so the file is never world-readable
  // even for the millisecond between create and chmod.
  writeFileSync(target.path, body, { mode: 0o600 });
  chmodSync(target.path, 0o600);
  if (target.ownerOf) {
    const st = statSync(target.ownerOf);
    chownSync(target.path, st.uid, st.gid);
  }
}

process.stderr.write(
  `[render-gitconfig] Wrote ${targets.map((t) => t.path).join(", ")} ` +
    `(aliases=${aliases.map((a) => a.alias).join(",")})\n`,
);
