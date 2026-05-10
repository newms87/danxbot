import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseIssue, serializeIssue } from "../../issue-tracker/yaml.js";
import {
  runMigration,
  rewriteIdFields,
  rewriteFreeText,
  setConfigPrefix,
} from "../../../scripts/migrate-issue-prefix.js";

interface RepoLayout {
  root: string;
  configPath: string;
  openDir: string;
  closedDir: string;
}

function setupRepo(opts: { initialPrefix: string | null }): RepoLayout {
  const root = mkdtempSync(join(tmpdir(), "migrate-prefix-test-"));
  const configDir = join(root, ".danxbot/config");
  const openDir = join(root, ".danxbot/issues/open");
  const closedDir = join(root, ".danxbot/issues/closed");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  const configPath = join(configDir, "config.yml");
  const lines = ["name: fixture", "url: https://example.com/fixture.git"];
  if (opts.initialPrefix !== null) {
    lines.push(`issue_prefix: ${opts.initialPrefix}`);
  }
  lines.push("git_mode: main", "");
  writeFileSync(configPath, lines.join("\n"));
  return { root, configPath, openDir, closedDir };
}

function writeIssue(
  dir: string,
  issue: {
    id: string;
    parent_id?: string | null;
    children?: string[];
    title?: string;
    description?: string;
    blocked_by?: string[] | null;
    action_item_ids?: string[];
    comments?: Array<{ author: string; timestamp: string; text: string }>;
    retro_commits?: string[];
    status?: "ToDo" | "In Progress" | "Done" | "Cancelled" | "Review" | "Blocked";
  },
): string {
  const path = join(dir, `${issue.id}.yml`);
  const lines: string[] = [
    "schema_version: 3",
    "tracker: trello",
    `id: ${issue.id}`,
    'external_id: ""',
    `parent_id: ${issue.parent_id ?? "null"}`,
    "children:",
    ...(issue.children ?? []).map((c) => `  - ${c}`),
    ...(issue.children === undefined || issue.children.length === 0 ? ["children: []"] : []),
    "dispatch: null",
    `status: ${issue.status ?? "ToDo"}`,
    "type: Feature",
    `title: ${JSON.stringify(issue.title ?? "fixture")}`,
    `description: ${JSON.stringify(issue.description ?? "body")}`,
    "triage:",
    '  expires_at: ""',
    '  reassess_hint: ""',
    '  last_status: ""',
    '  last_explain: ""',
    "  ice:",
    "    total: 0",
    "    i: 0",
    "    c: 0",
    "    e: 0",
    "  history: []",
    "ac: []",
  ];
  // Comments
  if (issue.comments && issue.comments.length > 0) {
    lines.push("comments:");
    for (const c of issue.comments) {
      lines.push(`  - author: ${JSON.stringify(c.author)}`);
      lines.push(`    timestamp: ${JSON.stringify(c.timestamp)}`);
      lines.push(`    text: ${JSON.stringify(c.text)}`);
    }
  } else {
    lines.push("comments: []");
  }
  // Retro
  lines.push("retro:");
  lines.push('  good: ""');
  lines.push('  bad: ""');
  if (issue.action_item_ids && issue.action_item_ids.length > 0) {
    lines.push("  action_item_ids:");
    for (const id of issue.action_item_ids) lines.push(`    - ${id}`);
  } else {
    lines.push("  action_item_ids: []");
  }
  if (issue.retro_commits && issue.retro_commits.length > 0) {
    lines.push("  commits:");
    for (const c of issue.retro_commits) lines.push(`    - ${JSON.stringify(c)}`);
  } else {
    lines.push("  commits: []");
  }
  // Blocked
  if (issue.blocked_by && issue.blocked_by.length > 0) {
    lines.push("blocked:");
    lines.push('  reason: "test reason"');
    lines.push('  timestamp: "2026-01-01T00:00:00Z"');
    lines.push("  by:");
    for (const id of issue.blocked_by) lines.push(`    - ${id}`);
  } else {
    lines.push("blocked: null");
  }
  // Build cleaned (drop the duplicate "children: []" insertion path)
  // The lines array above accidentally produces the children: list followed by
  // an extra "children: []" — so re-build via parseIssue + serializeIssue for
  // a guaranteed-canonical fixture.
  let raw = lines.join("\n") + "\n";
  // Remove duplicate `children:` blocks if any
  raw = raw.replace(/^children:\s*\nchildren: \[\]/m, "children: []");
  const issueObj = parseIssue(raw, { expectedPrefix: idPrefix(issue.id) });
  writeFileSync(path, serializeIssue(issueObj));
  return path;
}

function idPrefix(id: string): string {
  const m = /^([A-Z]{2,4})-/.exec(id);
  return m === null ? "ISS" : m[1];
}

describe("rewriteFreeText", () => {
  it("rewrites bare references with word boundaries", () => {
    expect(rewriteFreeText("see ISS-12 and ISS-99", "ISS", "DX")).toBe(
      "see DX-12 and DX-99",
    );
  });
  it("does not match ISSUE or ISSED (different word)", () => {
    expect(rewriteFreeText("ISSUE in flight, ISSED-1", "ISS", "DX")).toBe(
      "ISSUE in flight, ISSED-1",
    );
  });
  it("matches inside parenthesised / punctuated text", () => {
    expect(rewriteFreeText("(ISS-7) and ISS-8.", "ISS", "DX")).toBe(
      "(DX-7) and DX-8.",
    );
  });
  it("leaves non-matching prefixes alone", () => {
    expect(rewriteFreeText("see SG-12 too", "ISS", "DX")).toBe("see SG-12 too");
  });
});

describe("rewriteIdFields", () => {
  it("rewrites id, parent_id, children, waiting_on.by, action_item_ids", () => {
    const issue = parseIssue(
      serializeIssue({
        schema_version: 6,
        tracker: "memory",
        id: "ISS-7",
        external_id: "",
        parent_id: "ISS-1",
        children: ["ISS-8", "ISS-9"],
        dispatch: null,
        status: "ToDo",
        type: "Feature",
        title: "fix ISS-7",
        description: "see ISS-1 and ISS-9.",
        priority: 3.0,
        triage: {
          expires_at: "",
          reassess_hint: "",
          last_status: "",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
          history: [],
        },
        ac: [],
        comments: [
          {
            id: "abc",
            author: "danxbot",
            timestamp: "2026-01-01T00:00:00Z",
            text: "ref ISS-2",
          },
        ],
        retro: {
          good: "ISS-7 good",
          bad: "ISS-7 bad",
          action_item_ids: ["ISS-30"],
          commits: ["abc1234 [ISS-7] subject"],
        },
        blocked: null,
        requires_human: null,
        assigned_agent: null,
        waiting_on: {
          reason: "test",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-2"],
        },
        history: [],
      }),
      { expectedPrefix: "ISS" },
    );
    const out = rewriteIdFields(issue, "ISS", "DX");
    expect(out.id).toBe("DX-7");
    expect(out.parent_id).toBe("DX-1");
    expect(out.children).toEqual(["DX-8", "DX-9"]);
    expect(out.waiting_on?.by).toEqual(["DX-2"]);
    expect(out.retro.action_item_ids).toEqual(["DX-30"]);
    expect(out.retro.commits).toEqual(["abc1234 [DX-7] subject"]);
    expect(out.title).toBe("fix DX-7");
    expect(out.description).toBe("see DX-1 and DX-9.");
    expect(out.comments[0].text).toBe("ref DX-2");
    expect(out.retro.good).toBe("DX-7 good");
    expect(out.retro.bad).toBe("DX-7 bad");
  });
  it("leaves cross-prefix refs untouched (defensive)", () => {
    const issue = parseIssue(
      serializeIssue({
        schema_version: 6,
        tracker: "memory",
        id: "ISS-7",
        external_id: "",
        parent_id: null,
        children: [],
        dispatch: null,
        status: "ToDo",
        type: "Feature",
        title: "t",
        description: "see SG-3 in other repo",
        priority: 3.0,
        triage: {
          expires_at: "",
          reassess_hint: "",
          last_status: "",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
          history: [],
        },
        ac: [],
        comments: [],
        retro: { good: "", bad: "", action_item_ids: [], commits: [] },
        blocked: null,
        requires_human: null,
        assigned_agent: null,
        waiting_on: null,
        history: [],
      }),
      { expectedPrefix: "ISS" },
    );
    const out = rewriteIdFields(issue, "ISS", "DX");
    expect(out.description).toBe("see SG-3 in other repo");
  });
});

describe("setConfigPrefix", () => {
  it("updates an existing issue_prefix line in place", () => {
    const original = "name: foo\nissue_prefix: ISS\ngit_mode: main\n";
    expect(setConfigPrefix(original, "DX")).toBe(
      "name: foo\nissue_prefix: DX\ngit_mode: main\n",
    );
  });
  it("inserts issue_prefix after name when absent", () => {
    const original = "name: foo\nurl: x\ngit_mode: main\n";
    expect(setConfigPrefix(original, "DX")).toBe(
      "name: foo\nissue_prefix: DX\nurl: x\ngit_mode: main\n",
    );
  });
  it("idempotent — returns input unchanged when prefix already matches", () => {
    const original = "name: foo\nissue_prefix: DX\ngit_mode: main\n";
    expect(setConfigPrefix(original, "DX")).toBe(original);
  });
  it("preserves quoted values and trailing comments", () => {
    const original = 'name: foo\nissue_prefix: "ISS"  # legacy\n';
    expect(setConfigPrefix(original, "DX")).toBe(
      'name: foo\nissue_prefix: DX\n',
    );
  });
  it("strips single-quoted value and trailing comment", () => {
    const original = "name: foo\nissue_prefix: 'ISS'  # legacy\n";
    expect(setConfigPrefix(original, "DX")).toBe(
      "name: foo\nissue_prefix: DX\n",
    );
  });
  it("prepends issue_prefix when neither name nor issue_prefix is present", () => {
    const original = "url: x\ngit_mode: main\n";
    expect(setConfigPrefix(original, "DX")).toBe(
      "issue_prefix: DX\nurl: x\ngit_mode: main\n",
    );
  });
  it("throws on prefix shape violation", () => {
    expect(() => setConfigPrefix("name: foo\n", "lower")).toThrow(
      /invalid newPrefix/,
    );
    expect(() => setConfigPrefix("name: foo\n", "X")).toThrow(
      /invalid newPrefix/,
    );
    expect(() => setConfigPrefix("name: foo\n", "")).toThrow(
      /invalid newPrefix/,
    );
    expect(() => setConfigPrefix("name: foo\n", "TOOLONG")).toThrow(
      /invalid newPrefix/,
    );
  });
});

describe("runMigration — happy path", () => {
  let repo: RepoLayout;
  beforeEach(() => {
    repo = setupRepo({ initialPrefix: "ISS" });
  });
  it("renames every YAML, rewrites refs, and updates config.yml last", () => {
    writeIssue(repo.openDir, { id: "ISS-1", title: "epic" });
    writeIssue(repo.openDir, {
      id: "ISS-2",
      parent_id: "ISS-1",
      blocked_by: ["ISS-3"],
      description: "see ISS-1 and ISS-3",
    });
    writeIssue(repo.closedDir, { id: "ISS-3", parent_id: "ISS-1" });

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(0);
    expect(result.perRepo).toHaveLength(1);
    const r = result.perRepo[0];
    expect(r.errors).toEqual([]);
    expect(r.rolledBack).toBe(false);
    expect(r.filesRenamed).toBe(3);
    expect(r.configUpdated).toBe(true);

    // Filenames
    expect(existsSync(join(repo.openDir, "ISS-1.yml"))).toBe(false);
    expect(existsSync(join(repo.openDir, "DX-1.yml"))).toBe(true);
    expect(existsSync(join(repo.openDir, "DX-2.yml"))).toBe(true);
    expect(existsSync(join(repo.closedDir, "DX-3.yml"))).toBe(true);

    // Cross-refs rewritten
    const dx2 = parseIssue(
      readFileSync(join(repo.openDir, "DX-2.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(dx2.id).toBe("DX-2");
    expect(dx2.parent_id).toBe("DX-1");
    expect(dx2.waiting_on?.by).toEqual(["DX-3"]);
    expect(dx2.description).toBe("see DX-1 and DX-3");

    // Config updated
    expect(readFileSync(repo.configPath, "utf-8")).toContain(
      "issue_prefix: DX",
    );
  });
});

describe("runMigration — idempotent re-run", () => {
  it("no-ops when filenames already match the new prefix and config carries it", () => {
    const repo = setupRepo({ initialPrefix: "DX" });
    writeIssue(repo.openDir, { id: "DX-1", title: "epic" });

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(0);
    const r = result.perRepo[0];
    expect(r.filesRenamed).toBe(0);
    expect(r.filesRewritten).toBe(0);
    expect(r.configUpdated).toBe(false);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
  it("running migration twice in a row produces the same on-disk state", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1" });
    writeIssue(repo.openDir, { id: "ISS-2", parent_id: "ISS-1" });

    runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });
    const stateAfterFirst = {
      dx1: readFileSync(join(repo.openDir, "DX-1.yml"), "utf-8"),
      dx2: readFileSync(join(repo.openDir, "DX-2.yml"), "utf-8"),
      config: readFileSync(repo.configPath, "utf-8"),
    };

    const second = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });
    expect(second.totalErrors).toBe(0);
    expect(second.perRepo[0].filesRenamed).toBe(0);
    expect(second.perRepo[0].filesRewritten).toBe(0);

    expect(readFileSync(join(repo.openDir, "DX-1.yml"), "utf-8")).toBe(
      stateAfterFirst.dx1,
    );
    expect(readFileSync(join(repo.openDir, "DX-2.yml"), "utf-8")).toBe(
      stateAfterFirst.dx2,
    );
    expect(readFileSync(repo.configPath, "utf-8")).toBe(stateAfterFirst.config);
  });
});

describe("runMigration — rollback on failure", () => {
  it("rolls back every file and config when one YAML fails to parse mid-flight", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1" });
    writeIssue(repo.openDir, { id: "ISS-2" });
    // Inject a malformed YAML — wrong schema_version so parseIssue fails
    writeFileSync(
      join(repo.openDir, "ISS-3.yml"),
      "schema_version: 99\nid: ISS-3\n",
    );

    const before = {
      iss1: readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8"),
      iss2: readFileSync(join(repo.openDir, "ISS-2.yml"), "utf-8"),
      iss3: readFileSync(join(repo.openDir, "ISS-3.yml"), "utf-8"),
      config: readFileSync(repo.configPath, "utf-8"),
    };

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBeGreaterThan(0);
    expect(result.perRepo[0].rolledBack).toBe(true);

    // Every old file restored
    expect(existsSync(join(repo.openDir, "ISS-1.yml"))).toBe(true);
    expect(existsSync(join(repo.openDir, "ISS-2.yml"))).toBe(true);
    expect(existsSync(join(repo.openDir, "ISS-3.yml"))).toBe(true);
    // No new-prefix files leaked
    expect(existsSync(join(repo.openDir, "DX-1.yml"))).toBe(false);
    expect(existsSync(join(repo.openDir, "DX-2.yml"))).toBe(false);
    // Original content preserved byte-for-byte
    expect(readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8")).toBe(
      before.iss1,
    );
    expect(readFileSync(join(repo.openDir, "ISS-2.yml"), "utf-8")).toBe(
      before.iss2,
    );
    // Config NOT flipped (config.yml is updated last + rolled back first)
    expect(readFileSync(repo.configPath, "utf-8")).toBe(before.config);
  });
});

describe("runMigration — empty repo / no issues dir", () => {
  it("still updates config.yml when no YAML files exist", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-prefix-empty-"));
    const configDir = join(root, ".danxbot/config");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yml");
    writeFileSync(configPath, "name: empty\ngit_mode: main\n");

    const result = runMigration({
      repos: [{ repoRoot: root, oldPrefix: "ISS", newPrefix: "FD" }],
    });

    expect(result.totalErrors).toBe(0);
    expect(result.perRepo[0].configUpdated).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("issue_prefix: FD");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("runMigration — leaves draft slug filenames alone", () => {
  it("ignores files whose stem doesn't match <oldPrefix>-N", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1" });
    // Draft slug
    writeFileSync(join(repo.openDir, "draft-feature.yml"), "anything");

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(0);
    expect(existsSync(join(repo.openDir, "DX-1.yml"))).toBe(true);
    expect(existsSync(join(repo.openDir, "draft-feature.yml"))).toBe(true);
    expect(readFileSync(join(repo.openDir, "draft-feature.yml"), "utf-8")).toBe(
      "anything",
    );
  });
});

describe("runMigration — fail-loud guards", () => {
  it("returns prefix-shape errors early without touching the FS", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1" });
    const before = readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8");

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "iss", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(1);
    expect(result.perRepo[0].errors[0]).toMatch(/Invalid prefix/);
    expect(result.perRepo[0].rolledBack).toBe(false);
    // FS unchanged
    expect(existsSync(join(repo.openDir, "ISS-1.yml"))).toBe(true);
    expect(readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8")).toBe(
      before,
    );
  });

  it("throws fail-loud when destination filename already exists (collision)", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1", title: "real" });
    // Operator-created stub or stale partial-migration leftover
    writeIssue(repo.openDir, { id: "DX-1", title: "stale stub" });
    const stubBefore = readFileSync(join(repo.openDir, "DX-1.yml"), "utf-8");
    const realBefore = readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8");

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBeGreaterThan(0);
    expect(result.perRepo[0].errors[0]).toMatch(/\[collision\]/);
    expect(result.perRepo[0].rolledBack).toBe(true);
    // Both files preserved byte-for-byte
    expect(readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8")).toBe(
      realBefore,
    );
    expect(readFileSync(join(repo.openDir, "DX-1.yml"), "utf-8")).toBe(
      stubBefore,
    );
  });

  it("throws fail-loud when config.yml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-prefix-noconfig-"));
    mkdirSync(join(root, ".danxbot/issues/open"), { recursive: true });
    // No config.yml at all

    const result = runMigration({
      repos: [{ repoRoot: root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(1);
    expect(result.perRepo[0].errors[0]).toMatch(/\[config\] Missing/);
    expect(result.perRepo[0].configUpdated).toBe(false);
    expect(
      existsSync(join(root, ".danxbot/config/config.yml")),
    ).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("runMigration — partial-state recovery", () => {
  it("mixed-prefix dir: rewrites old, skips already-migrated", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1", title: "needs migration" });
    writeIssue(repo.openDir, { id: "DX-2", title: "already migrated" });

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(0);
    const r = result.perRepo[0];
    expect(r.filesRenamed).toBe(1);
    expect(r.filesRewritten).toBe(1);
    expect(r.skipped).toBe(1);
    expect(existsSync(join(repo.openDir, "DX-1.yml"))).toBe(true);
    expect(existsSync(join(repo.openDir, "DX-2.yml"))).toBe(true);
    expect(existsSync(join(repo.openDir, "ISS-1.yml"))).toBe(false);
  });

  it("oldPrefix === newPrefix: no-op across the board", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.openDir, { id: "ISS-1" });
    writeIssue(repo.openDir, { id: "ISS-2", parent_id: "ISS-1" });
    const before1 = readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8");
    const before2 = readFileSync(join(repo.openDir, "ISS-2.yml"), "utf-8");
    const beforeConfig = readFileSync(repo.configPath, "utf-8");

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "ISS" }],
    });

    expect(result.totalErrors).toBe(0);
    expect(result.perRepo[0].filesRenamed).toBe(0);
    expect(result.perRepo[0].filesRewritten).toBe(2);
    expect(result.perRepo[0].configUpdated).toBe(false);
    // Files renamed-in-place (oldPath === newPath, no rename) but content
    // round-tripped through serialize/parse — verify byte-for-byte stable.
    expect(readFileSync(join(repo.openDir, "ISS-1.yml"), "utf-8")).toBe(
      before1,
    );
    expect(readFileSync(join(repo.openDir, "ISS-2.yml"), "utf-8")).toBe(
      before2,
    );
    expect(readFileSync(repo.configPath, "utf-8")).toBe(beforeConfig);
  });

  it("only closed/ has YAMLs (open is empty)", () => {
    const repo = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repo.closedDir, { id: "ISS-1" });

    const result = runMigration({
      repos: [{ repoRoot: repo.root, oldPrefix: "ISS", newPrefix: "DX" }],
    });

    expect(result.totalErrors).toBe(0);
    expect(existsSync(join(repo.closedDir, "DX-1.yml"))).toBe(true);
    expect(existsSync(join(repo.closedDir, "ISS-1.yml"))).toBe(false);
  });
});

describe("runMigration — multi-repo independence", () => {
  it("rollback in one repo does not affect another", () => {
    const repoA = setupRepo({ initialPrefix: "ISS" });
    const repoB = setupRepo({ initialPrefix: "ISS" });
    writeIssue(repoA.openDir, { id: "ISS-1" });
    writeIssue(repoB.openDir, { id: "ISS-1" });
    // Inject failure only in repoA
    writeFileSync(
      join(repoA.openDir, "ISS-2.yml"),
      "schema_version: 99\nid: ISS-2\n",
    );

    const result = runMigration({
      repos: [
        { repoRoot: repoA.root, oldPrefix: "ISS", newPrefix: "DX" },
        { repoRoot: repoB.root, oldPrefix: "ISS", newPrefix: "SG" },
      ],
    });

    expect(result.perRepo[0].rolledBack).toBe(true);
    expect(result.perRepo[1].rolledBack).toBe(false);
    expect(existsSync(join(repoA.openDir, "ISS-1.yml"))).toBe(true);
    expect(existsSync(join(repoA.openDir, "DX-1.yml"))).toBe(false);
    expect(existsSync(join(repoB.openDir, "SG-1.yml"))).toBe(true);
    expect(existsSync(join(repoB.openDir, "ISS-1.yml"))).toBe(false);
  });
});
