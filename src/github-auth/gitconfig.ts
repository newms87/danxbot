/**
 * Pure helpers for the worker entrypoint's GitHub-token gitconfig render
 * (DX-647 Phase 1 of DX-646).
 *
 * The container has no SSH config; the host's repo remotes use SSH alias
 * URLs (`git@github-newms87:newms87/<repo>.git`) the container cannot
 * resolve. Instead of mounting SSH keys, the entrypoint writes a global
 * `~/.gitconfig` whose `insteadOf` rules transparently rewrite both
 * SSH-alias and bare-HTTPS URLs to `https://x-access-token:<PAT>@github.com/...`
 * at fetch/push time. Bind-mounted repo `.git/config` stays UNTOUCHED —
 * the host's interactive SSH workflow is unaffected.
 *
 * Split out of `scripts/render-gitconfig.ts` so the regex + render
 * output have direct vitest coverage without spinning up a container.
 */

export const TOKEN_PATTERN =
  /^(?:gh[ps]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)$/;

export type ValidateResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export function validateToken(raw: string | undefined | null): ValidateResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "DANX_GITHUB_TOKEN is missing or empty" };
  }
  if (!TOKEN_PATTERN.test(raw)) {
    return {
      ok: false,
      error:
        "DANX_GITHUB_TOKEN does not match expected GitHub PAT shape " +
        "(`^gh[ps]_[A-Za-z0-9_]+$` for classic PATs OR " +
        "`^github_pat_[A-Za-z0-9_]+$` for fine-grained)",
    };
  }
  return { ok: true, token: raw };
}

export interface SshAlias {
  alias: string;
  owner: string;
}

const DEFAULT_ALIASES: SshAlias[] = [
  { alias: "github-newms87", owner: "newms87" },
];

/**
 * Parse the `DANXBOT_SSH_ALIASES` env var into a normalized list. Format:
 * comma-separated `alias:owner` pairs (e.g. `github-newms87:newms87,github-acme:acme`).
 * Empty / unset → the documented starting state (`github-newms87:newms87`).
 * A malformed entry throws — the entrypoint surfaces the failure as a
 * fatal start error so the operator notices immediately rather than
 * silently dispatching against a missing alias rule.
 */
export function parseAliases(raw: string | undefined | null): SshAlias[] {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return [...DEFAULT_ALIASES];
  }
  const out: SshAlias[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0 || colon === trimmed.length - 1) {
      throw new Error(
        `DANXBOT_SSH_ALIASES entry "${trimmed}" is malformed — expected "alias:owner"`,
      );
    }
    out.push({
      alias: trimmed.slice(0, colon).trim(),
      owner: trimmed.slice(colon + 1).trim(),
    });
  }
  if (out.length === 0) return [...DEFAULT_ALIASES];
  return out;
}

export interface RenderInput {
  token: string;
  email: string;
  aliases: SshAlias[];
}

export function renderGitconfig({ token, email, aliases }: RenderInput): string {
  const lines: string[] = [];
  lines.push(`[url "https://x-access-token:${token}@github.com/"]`);
  lines.push(`\tinsteadOf = git@github.com:`);
  lines.push(`\tinsteadOf = https://github.com/`);
  for (const { alias, owner } of aliases) {
    lines.push(`[url "https://x-access-token:${token}@github.com/${owner}/"]`);
    lines.push(`\tinsteadOf = git@${alias}:${owner}/`);
  }
  lines.push(`[user]`);
  lines.push(`\temail = ${email}`);
  lines.push(`\tname = danxbot`);
  return lines.join("\n") + "\n";
}
