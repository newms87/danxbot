import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("danxbot-commit");

const __filename = fileURLToPath(import.meta.url);
const DANXBOT_ROOT = resolve(dirname(__filename), "../..");

let cachedCommit: string | null | undefined;

/**
 * Return the short commit SHA of the danxbot repo. Prefers a build-time
 * `DANXBOT_COMMIT` env var (baked into the Dockerfile via `ARG/ENV` and
 * also injected by `deploy/workers.ts`) so prod images carry the SHA they
 * were built from without needing a `.git` dir. Falls back to
 * `git rev-parse --short HEAD` against the source root for dev shells,
 * where the process is run from a real git checkout. Resolved once and
 * cached — the value does not change while the worker is running.
 */
export function getDanxbotCommit(): string | null {
  if (cachedCommit !== undefined) return cachedCommit;

  const fromEnv = process.env.DANXBOT_COMMIT?.trim();
  if (fromEnv) {
    cachedCommit = fromEnv;
    return cachedCommit;
  }

  try {
    const sha = execSync("git rev-parse --short HEAD", {
      cwd: DANXBOT_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 1_000,
    }).trim();
    cachedCommit = sha || null;
  } catch (err) {
    log.warn("Failed to read danxbot commit SHA", err);
    cachedCommit = null;
  }

  return cachedCommit;
}

/** Reset the cached value. For tests only. */
export function _resetDanxbotCommitCache(): void {
  cachedCommit = undefined;
}
