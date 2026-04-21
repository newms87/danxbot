/**
 * Canonical parser for the `REPOS` env var — "name:url,name:url".
 *
 * Lives in its own file so both runtime code (`config.ts`) and the dev-only
 * compose-override codegen can import the same tokenizer without pulling
 * in `config.ts`'s module-load side effects (`validateConfig` runs at
 * import time and requires DB env vars).
 */

export interface RepoEnvEntry {
  name: string;
  url: string;
}

export function parseReposEnv(envValue: string): RepoEnvEntry[] {
  const trimmed = envValue.trim();
  if (!trimmed) return [];
  const entries: RepoEnvEntry[] = [];
  for (const raw of trimmed.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const colonIndex = entry.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `Invalid REPOS entry "${raw}" — expected "name:url" format`,
      );
    }
    const name = entry.slice(0, colonIndex).trim();
    const url = entry.slice(colonIndex + 1).trim();
    if (!name || !url) {
      throw new Error(
        `Invalid REPOS entry "${raw}" — name and url must not be empty`,
      );
    }
    entries.push({ name, url });
  }
  return entries;
}
