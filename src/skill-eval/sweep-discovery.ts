/**
 * Eval-set discovery for the `--all` sweep CLI.
 *
 * Single-level walk of an `<evalSetsDir>` directory tree, returning one
 * `DiscoveredEvalSet` per `<plugin>-<skill>` subdirectory that contains
 * an `eval-set.json` file. Directory name is parsed by splitting on
 * the FIRST hyphen so skill names with hyphens (e.g.
 * `issue-card-workflow`) round-trip correctly.
 *
 * Entries are sorted lexicographically by directory name so the sweep
 * order is deterministic across hosts / filesystems.
 *
 * Pure of network and side-effecting state — only `fs` reads. Suitable
 * for unit tests against a temp-dir tree.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredEvalSet {
  readonly pluginSkill: string;
  readonly evalSetDir: string;
  readonly evalSetPath: string;
}

export function discoverEvalSets(
  evalSetsDir: string,
): DiscoveredEvalSet[] {
  if (!existsSync(evalSetsDir)) return [];
  const entries = readdirSync(evalSetsDir).sort();
  const out: DiscoveredEvalSet[] = [];
  for (const name of entries) {
    const dir = join(evalSetsDir, name);
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const idx = name.indexOf("-");
    if (idx === -1) continue;
    const plugin = name.slice(0, idx);
    const skill = name.slice(idx + 1);
    if (plugin.length === 0 || skill.length === 0) continue;
    const evalSetPath = join(dir, "eval-set.json");
    if (!existsSync(evalSetPath)) continue;
    out.push({
      pluginSkill: `${plugin}:${skill}`,
      evalSetDir: dir,
      evalSetPath,
    });
  }
  return out;
}
