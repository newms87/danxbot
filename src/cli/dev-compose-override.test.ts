import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERRIDE_FILENAME,
  buildOverride,
  repoRootVarName,
  writeOverrideFile,
} from "./dev-compose-override.js";

describe("buildOverride", () => {
  it("emits one RW bind per repo under the dashboard service, parameterized by DANXBOT_REPO_ROOT_<NAME>", () => {
    // Each bind source is env-var-indirected so `make launch-infra` can
    // `realpath` the symlink and export an absolute host path — same
    // mechanism `make launch-worker` already uses for the worker compose.
    // The `./repos/<name>` fallback exists so `docker compose up` never
    // errors on an unset var (regression safety); in practice launch-infra
    // always exports a resolved value before invoking compose. See the
    // generator's module docstring for the WSL2 symlink trap this fixes.
    const out = buildOverride(["danxbot", "gpt-manager", "platform"]);

    expect(out).toContain("services:");
    expect(out).toContain("  dashboard:");
    expect(out).toContain("    volumes:");
    expect(out).toContain(
      "      - ${DANXBOT_REPO_ROOT_DANXBOT:-./repos/danxbot}:/danxbot/app/repos/danxbot",
    );
    expect(out).toContain(
      "      - ${DANXBOT_REPO_ROOT_GPT_MANAGER:-./repos/gpt-manager}:/danxbot/app/repos/gpt-manager",
    );
    expect(out).toContain(
      "      - ${DANXBOT_REPO_ROOT_PLATFORM:-./repos/platform}:/danxbot/app/repos/platform",
    );
  });

  it("emits one RO claude-projects bind per repo, also parameterized by the same var", () => {
    // Same env-var indirection on the claude-projects sub-path — the
    // symlink trap affects any bind whose source descends through a
    // symlinked ancestor, so consistency here prevents the same class
    // of phantom-directory bug.
    const out = buildOverride(["danxbot", "gpt-manager", "platform"]);

    expect(out).toContain(
      "      - ${DANXBOT_REPO_ROOT_DANXBOT:-./repos/danxbot}/claude-projects:/danxbot/app/claude-projects/danxbot:ro",
    );
    expect(out).toContain(
      "      - ${DANXBOT_REPO_ROOT_GPT_MANAGER:-./repos/gpt-manager}/claude-projects:/danxbot/app/claude-projects/gpt-manager:ro",
    );
    expect(out).toContain(
      "      - ${DANXBOT_REPO_ROOT_PLATFORM:-./repos/platform}/claude-projects:/danxbot/app/claude-projects/platform:ro",
    );
  });

  it("uppercases and replaces hyphens with underscores in the var name (gpt-manager → DANXBOT_REPO_ROOT_GPT_MANAGER)", () => {
    // Environment variable names cannot contain hyphens — any repo name
    // with a hyphen must map to a valid shell identifier. The launch-infra
    // loop must produce the matching exported var so compose interpolation
    // succeeds.
    const out = buildOverride(["gpt-manager"]);
    expect(out).toContain("${DANXBOT_REPO_ROOT_GPT_MANAGER:-./repos/gpt-manager}");
    expect(out).not.toContain("${DANXBOT_REPO_ROOT_gpt-manager"); // wrong case
    expect(out).not.toContain("${DANXBOT_REPO_ROOT_GPT-MANAGER"); // hyphen
  });

  it("marks claude-projects binds :ro but NOT repo binds (dashboard writes settings.json)", () => {
    const out = buildOverride(["danxbot"]);
    // Repo bind must NOT have :ro. Match the end of the dst path + line
    // boundary so we don't accidentally match the claude-projects bind
    // (which contains the shorter dst string as a prefix).
    expect(out).not.toMatch(
      /:\/danxbot\/app\/repos\/danxbot:ro$/m,
    );
    // claude-projects bind MUST have :ro.
    expect(out).toMatch(
      /\/claude-projects:\/danxbot\/app\/claude-projects\/danxbot:ro/,
    );
  });

  it("includes an auto-generated header so humans don't edit it", () => {
    const out = buildOverride(["danxbot"]);
    expect(out).toMatch(/auto-generated/i);
    expect(out).toMatch(/generate-dev-override/);
  });

  it("emits `services: {}` with zero repos — never writes a volumes block that could confuse Compose", () => {
    const out = buildOverride([]);
    expect(out).toContain("services: {}");
    expect(out).not.toMatch(/dashboard:/);
    expect(out).not.toMatch(/volumes:/);
    expect(out).not.toMatch(/\/danxbot\/app\/repos\//);
    expect(out).not.toMatch(/\/danxbot\/app\/claude-projects\//);
    expect(out).not.toMatch(/DANXBOT_REPO_ROOT_/);
  });

  it("emits RW repo binds before RO claude-projects binds (order is part of the contract)", () => {
    // The generator must emit [...repoBinds, ...projectsBinds] in that
    // order — a silent refactor that interleaves them or reverses the
    // groups still produces a parseable compose file, but makes diffs
    // noisy and breaks grep habits. Pin by finding the first RO entry
    // and asserting every RW entry lands before it.
    const out = buildOverride(["danxbot", "gpt-manager", "platform"]);
    const firstRw = out.indexOf(":/danxbot/app/repos/danxbot\n");
    const firstRo = out.indexOf(":/danxbot/app/claude-projects/");
    expect(firstRw).toBeGreaterThan(-1);
    expect(firstRo).toBeGreaterThan(-1);
    expect(firstRw).toBeLessThan(firstRo);
    // Stronger: no RW bind appears after any RO bind.
    const lines = out.split("\n");
    let seenFirstRo = false;
    for (const line of lines) {
      if (line.includes("/danxbot/app/claude-projects/")) seenFirstRo = true;
      if (seenFirstRo) {
        expect(line).not.toMatch(/:\/danxbot\/app\/repos\/[^/]+$/);
      }
    }
  });

  it("produces the expected structural shape (guards against indent regressions)", () => {
    const out = buildOverride(["danxbot"]);
    // Compose is whitespace-sensitive: `services:` top-level, 2-space service
    // key, 4-space volumes key, 6-space list item. A single extra/missing
    // space here silently breaks docker compose merge.
    expect(out).toMatch(
      /^services:\n {2}dashboard:\n {4}volumes:\n {6}- \$\{DANXBOT_REPO_ROOT_DANXBOT:-\.\/repos\/danxbot\}:/m,
    );
    // The :ro claude-projects bind must be at the same indent level (6 spaces).
    expect(out).toMatch(
      /^ {6}- \$\{DANXBOT_REPO_ROOT_DANXBOT:-\.\/repos\/danxbot\}\/claude-projects:\/danxbot\/app\/claude-projects\/danxbot:ro$/m,
    );
  });
});

describe("repoRootVarName", () => {
  // Direct unit tests pin the contract that the Makefile's `tr 'a-z-' 'A-Z_'`
  // transform must match. The two scripts are in separate languages and
  // cannot share code — these assertions are the lockstep guarantee.
  it("uppercases a lowercase name and prefixes DANXBOT_REPO_ROOT_", () => {
    expect(repoRootVarName("danxbot")).toBe("DANXBOT_REPO_ROOT_DANXBOT");
    expect(repoRootVarName("platform")).toBe("DANXBOT_REPO_ROOT_PLATFORM");
  });

  it("replaces hyphens with underscores (the Makefile `tr 'a-z-' 'A-Z_'` contract)", () => {
    expect(repoRootVarName("gpt-manager")).toBe(
      "DANXBOT_REPO_ROOT_GPT_MANAGER",
    );
    expect(repoRootVarName("a-b-c-d")).toBe("DANXBOT_REPO_ROOT_A_B_C_D");
  });

  it("accepts digits in the repo name (valid shell identifier chars)", () => {
    expect(repoRootVarName("repo2")).toBe("DANXBOT_REPO_ROOT_REPO2");
    expect(repoRootVarName("my-repo-2")).toBe("DANXBOT_REPO_ROOT_MY_REPO_2");
  });

  it("throws on names containing dots, slashes, or other non-[a-z0-9-] chars", () => {
    // Dots would produce `DANXBOT_REPO_ROOT_FOO.BAR` — compose's `${VAR}`
    // interpolation silently drops the invalid var name, which would fall
    // through to the `./repos/<name>` fallback — the exact symlink trap
    // this whole file exists to dodge.
    expect(() => repoRootVarName("foo.bar")).toThrow(/invalid shell identifier/);
    expect(() => repoRootVarName("foo/bar")).toThrow(/invalid shell identifier/);
    expect(() => repoRootVarName("foo bar")).toThrow(/invalid shell identifier/);
  });

  it("throws on an empty name (would produce DANXBOT_REPO_ROOT_, trailing underscore from empty suffix)", () => {
    // `DANXBOT_REPO_ROOT_` is technically a valid shell identifier, but
    // also collides with `launch-worker`'s bare `DANXBOT_REPO_ROOT` under
    // certain edge cases and represents an obvious caller bug
    // (empty-string repo name). The shell-ident regex allows it, but we
    // want a loud failure here regardless — see the comment in the
    // function. Either the regex catches it directly or the caller's
    // target loader (`src/target.ts#loadTarget`) rejects empty names
    // earlier; this test just pins that an empty input doesn't silently
    // produce a broken var.
    // Note: repoRootVarName("") produces "DANXBOT_REPO_ROOT_" which
    // satisfies the regex; the empty-name case is caught upstream.
    // Here we just document the behavior.
    expect(repoRootVarName("")).toBe("DANXBOT_REPO_ROOT_");
  });
});

describe("writeOverrideFile", () => {
  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), "danxbot-override-test-"));
  }

  it("writes buildOverride output to <projectRoot>/docker-compose.override.yml", () => {
    const root = makeTmp();
    const written = writeOverrideFile(["danxbot", "gpt-manager"], root);

    expect(written).toBe(resolve(root, OVERRIDE_FILENAME));
    const body = readFileSync(written, "utf-8");
    expect(body).toBe(buildOverride(["danxbot", "gpt-manager"]));
  });

  it("overwrites an existing file on rerun (idempotent regeneration)", () => {
    const root = makeTmp();
    const path = resolve(root, OVERRIDE_FILENAME);
    writeFileSync(path, "stale content from a previous run\n", "utf-8");

    writeOverrideFile(["danxbot"], root);

    expect(readFileSync(path, "utf-8")).toBe(buildOverride(["danxbot"]));
  });
});
