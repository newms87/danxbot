/**
 * DX-559 — Verify retro.commits[] shas are reachable from `origin/main`.
 *
 * Background: dispatched agents commit work to their own per-agent branch
 * (`dani`, `murphy`, `phil`) inside a worktree at
 * `<repo>/.danxbot/worktrees/<agent>/`. The `agent-finalize.sh` helper
 * squashes + rebases + pushes the agent branch's HEAD to `refs/heads/main`
 * on origin so `origin/main` ends up carrying the squash sha. When agents
 * skip finalize (or finalize fails silently), the sha they record in
 * `retro.commits[]` lives only on the agent branch — the card reports
 * Done but the runtime image never gains the code.
 *
 * This helper answers ONE question, with no I/O beyond `git`: for a given
 * set of shas, is each one an ancestor of `origin/main`?
 *
 * The caller (worker stop handlers) is responsible for fetching origin
 * first — verification reads whatever `refs/remotes/origin/main` currently
 * points at and does NOT trigger network I/O on its own.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface VerifyCommitsShippedInput {
  /** Repo containing the .git dir to query. Per-worktree paths share the same .git, so any worktree path under the connected repo also works. */
  repoLocalPath: string;
  /** Candidate shas (full or short — git resolves both). Empty list ⇒ trivially ok. */
  shas: string[];
  /** Ref to verify ancestry against. Defaults to `origin/main`. */
  gitRef?: string;
}

export interface VerifyCommitsShippedResult {
  ok: boolean;
  /** Shas the caller passed that are NOT reachable from `gitRef`. Empty when ok. */
  missing: string[];
  /** Shas the caller passed that git could not resolve at all (typo, never existed locally). Subset of `missing`. */
  unresolved: string[];
}

/**
 * Best-effort `git fetch origin --quiet` against the named repo. Swallows
 * failures (network blip, no remote configured in a test repo) — callers
 * pass `swallowFetchFailure: true` when they want enforcement to keep
 * running against the existing local `origin/main` ref. The unit suite
 * uses `swallowFetchFailure: false` to keep "no remote configured" loud
 * for tests that mean to exercise the fetch path.
 */
export async function fetchOriginQuiet(
  repoLocalPath: string,
  opts: { swallowFetchFailure: boolean; timeoutMs?: number } = {
    swallowFetchFailure: true,
  },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileP("git", ["fetch", "origin", "--quiet"], {
      cwd: repoLocalPath,
      timeout: opts.timeoutMs ?? 15_000,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.swallowFetchFailure) return { ok: false, error: message };
    throw err;
  }
}

export async function verifyCommitsShipped(
  input: VerifyCommitsShippedInput,
): Promise<VerifyCommitsShippedResult> {
  const gitRef = input.gitRef ?? "origin/main";
  const missing: string[] = [];
  const unresolved: string[] = [];

  for (const sha of input.shas) {
    if (!sha || typeof sha !== "string") continue;

    // `git merge-base --is-ancestor <sha> <ref>` exit codes:
    //   0   → sha IS an ancestor of ref (shipped)
    //   1   → sha is NOT an ancestor (missing)
    //   128 → sha unresolvable (typo, dropped, never existed locally)
    // Anything else is genuinely unexpected; treat as missing so we fail
    // closed — the operator will see the sha in the Blocked reason.
    try {
      await execFileP(
        "git",
        ["merge-base", "--is-ancestor", sha, gitRef],
        {
          cwd: input.repoLocalPath,
          timeout: 5_000,
        },
      );
    } catch (err) {
      // child_process exec rejection: `.code` is the EXIT CODE (number)
      // when the process exited non-zero, OR a string like 'ETIMEDOUT'
      // when the runtime aborted. Accept both `128` (number) and `"128"`
      // (defensive) for the unresolved-sha case.
      const code = (err as { code?: unknown }).code;
      missing.push(sha);
      if (code === 128 || code === "128") unresolved.push(sha);
    }
  }

  return { ok: missing.length === 0, missing, unresolved };
}
