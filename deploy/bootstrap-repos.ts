/**
 * Per-repo clone/pull + bootstrap.sh execution on the remote instance.
 *
 * syncRepos uses the DANX_GITHUB_TOKEN materialized into each repo's
 * /danxbot/repos/<name>/.danxbot/.env (Phase 4). The token is passed in
 * explicitly rather than read at runtime so the code remains deterministic
 * and testable.
 */

import type { DeployConfig, DeployRepo } from "./config.js";
import type { RemoteHost } from "./remote.js";
import { CONTAINER_REPOS_BASE } from "./constants.js";

export function buildCloneOrPullCommand(
  repo: Pick<DeployRepo, "name" | "url">,
  githubToken: string,
): string {
  const m = repo.url.match(/^https:\/\/github\.com\/(.+\.git)$/);
  if (!m) {
    throw new Error(
      `Unsupported repo URL (need https://github.com/...): ${repo.url}`,
    );
  }
  // Reject tokens with characters that would break single-quoted SSH wrapping
  // (the token ends up inside `ssh user@host '...<token>...'`). Github tokens
  // are [A-Za-z0-9_]+ in practice; anything else is a configuration bug.
  if (!/^[A-Za-z0-9_-]+$/.test(githubToken)) {
    throw new Error(
      `GitHub token for repo "${repo.name}" contains unsupported characters`,
    );
  }
  const authedUrl = `https://x-access-token:${githubToken}@github.com/${m[1]}`;
  const repoDir = `${CONTAINER_REPOS_BASE}/${repo.name}`;

  return [
    `if [ -d ${repoDir} ]; then`,
    `  git -C ${repoDir} fetch origin main && git -C ${repoDir} reset --hard origin/main;`,
    `else`,
    `  git clone ${authedUrl} ${repoDir};`,
    `fi`,
  ].join("\n");
}

export function syncRepos(
  remote: RemoteHost,
  config: DeployConfig,
  tokensPerRepo: Record<string, string>,
): void {
  for (const repo of config.repos) {
    const token = tokensPerRepo[repo.name];
    if (!token) {
      throw new Error(
        `No DANX_GITHUB_TOKEN found for repo "${repo.name}" (expected in SSM at repos/${repo.name}/DANX_GITHUB_TOKEN)`,
      );
    }
    console.log(`\n── Syncing ${repo.name} ──`);
    remote.sshRunStreaming(buildCloneOrPullCommand(repo, token));
  }
}

export function runBootstrapScripts(
  remote: RemoteHost,
  config: DeployConfig,
): void {
  for (const repo of config.repos) {
    const script = `${CONTAINER_REPOS_BASE}/${repo.name}/.danxbot/scripts/bootstrap.sh`;
    console.log(`\n── Running bootstrap for ${repo.name} ──`);
    // `test -f` not `test -x`: git preserves file mode only if the exec bit
    // was committed (`git update-index --chmod=+x`). We invoke via `bash
    // <path>` which doesn't need the exec bit, so gating on it causes
    // legitimate scripts to be silently skipped. Require only existence.
    remote.sshRunStreaming(`test -f ${script} && bash ${script}`);
  }
}
