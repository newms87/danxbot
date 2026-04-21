import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERRIDE_FILENAME,
  buildOverride,
  writeOverrideFile,
} from "./dev-compose-override.js";

describe("buildOverride", () => {
  it("emits one RW bind per repo under the dashboard service", () => {
    const out = buildOverride(["danxbot", "gpt-manager", "platform"]);

    expect(out).toContain("services:");
    expect(out).toContain("  dashboard:");
    expect(out).toContain("    volumes:");
    expect(out).toContain("      - ./repos/danxbot:/danxbot/app/repos/danxbot");
    expect(out).toContain(
      "      - ./repos/gpt-manager:/danxbot/app/repos/gpt-manager",
    );
    expect(out).toContain(
      "      - ./repos/platform:/danxbot/app/repos/platform",
    );
  });

  it("does NOT mark binds :ro — dashboard needs to write settings.json", () => {
    const out = buildOverride(["danxbot"]);
    expect(out).not.toMatch(/:ro\s*$/m);
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
  });

  it("produces the expected structural shape (guards against indent regressions)", () => {
    const out = buildOverride(["danxbot"]);
    // Compose is whitespace-sensitive: `services:` top-level, 2-space service
    // key, 4-space volumes key, 6-space list item. A single extra/missing
    // space here silently breaks docker compose merge.
    expect(out).toMatch(
      /^services:\n {2}dashboard:\n {4}volumes:\n {6}- \.\/repos\/danxbot:/m,
    );
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
