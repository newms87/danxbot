/**
 * Per-repo clone/pull + bootstrap.sh execution on the remote instance.
 *
 * syncRepos uses the DANX_GITHUB_TOKEN materialized into each repo's
 * /danxbot/repos/<name>/.danxbot/.env (Phase 4). The token is passed in
 * explicitly rather than read at runtime so the code remains deterministic
 * and testable.
 */

import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";

export function buildCloneOrPullCommand(
  repo: { name: string; url: string },
  githubToken: string,
): string {
  const m = repo.url.match(/^https:\/\/github\.com\/(.+\.git)$/);
  if (!m) {
    throw new Error(
      `Unsupported repo URL (need https://github.com/...): ${repo.url}`,
    );
  }
  const authedUrl = `https://x-access-token:${githubToken}@github.com/${m[1]}`;
  const repoDir = `/danxbot/repos/${repo.name}`;

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
    const script = `/danxbot/repos/${repo.name}/.danxbot/scripts/bootstrap.sh`;
    console.log(`\n── Running bootstrap for ${repo.name} ──`);
    remote.sshRunStreaming(`test -x ${script} && bash ${script}`);
  }
}
