import { describe, expect, it } from "vitest";
import {
  parseAliases,
  renderGitconfig,
  TOKEN_PATTERN,
  validateToken,
} from "./gitconfig.js";

describe("validateToken", () => {
  it("accepts classic PATs (ghp_, ghs_)", () => {
    expect(validateToken("ghp_abc123XYZdef_456").ok).toBe(true);
    expect(validateToken("ghs_xyz789ABC_underscores_ok").ok).toBe(true);
  });

  it("accepts fine-grained PATs (github_pat_)", () => {
    expect(
      validateToken("github_pat_11AAAA_some_payload_with_underscores").ok,
    ).toBe(true);
  });

  it("rejects missing / empty / nullish", () => {
    expect(validateToken(undefined)).toEqual({
      ok: false,
      error: "DANX_GITHUB_TOKEN is missing or empty",
    });
    expect(validateToken(null).ok).toBe(false);
    expect(validateToken("").ok).toBe(false);
  });

  it("rejects malformed shapes", () => {
    const cases = [
      "not-a-token",
      "ghp-dash-instead-of-underscore",
      "github_pat", // bare prefix, no payload
      "xxxghp_legit",
      "GHP_uppercase_prefix",
      "ghp_has space",
      "ghp_!special",
    ];
    for (const c of cases) {
      expect(validateToken(c).ok, `should reject "${c}"`).toBe(false);
    }
  });

  it("ok result carries the validated token", () => {
    const r = validateToken("ghp_payload");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe("ghp_payload");
  });

  it("regex pins the bare-prefix-no-payload rejection", () => {
    expect(TOKEN_PATTERN.test("ghp_")).toBe(false);
    expect(TOKEN_PATTERN.test("github_pat_")).toBe(false);
  });
});

describe("parseAliases", () => {
  it("defaults to github-newms87:newms87 when missing/empty", () => {
    const expected = [{ alias: "github-newms87", owner: "newms87" }];
    expect(parseAliases(undefined)).toEqual(expected);
    expect(parseAliases(null)).toEqual(expected);
    expect(parseAliases("")).toEqual(expected);
    expect(parseAliases("   ")).toEqual(expected);
  });

  it("parses comma-separated alias:owner pairs", () => {
    expect(parseAliases("github-foo:foo,github-bar:bar")).toEqual([
      { alias: "github-foo", owner: "foo" },
      { alias: "github-bar", owner: "bar" },
    ]);
  });

  it("trims whitespace inside and around entries", () => {
    expect(parseAliases(" github-foo : foo , github-bar:bar ")).toEqual([
      { alias: "github-foo", owner: "foo" },
      { alias: "github-bar", owner: "bar" },
    ]);
  });

  it("throws on malformed entry", () => {
    expect(() => parseAliases("missing-colon")).toThrow(/alias:owner/);
    expect(() => parseAliases(":no-alias")).toThrow(/alias:owner/);
    expect(() => parseAliases("no-owner:")).toThrow(/alias:owner/);
  });

  it("skips empty segments (trailing comma, double commas)", () => {
    expect(parseAliases("github-foo:foo,,")).toEqual([
      { alias: "github-foo", owner: "foo" },
    ]);
  });

  it("falls back to default when every segment is empty", () => {
    expect(parseAliases(",,,")).toEqual([
      { alias: "github-newms87", owner: "newms87" },
    ]);
  });
});

describe("renderGitconfig", () => {
  it("emits bare-domain block + per-alias block + user block (canonical env)", () => {
    const out = renderGitconfig({
      token: "ghp_TESTTOKEN",
      email: "danxbot@example.com",
      aliases: [{ alias: "github-newms87", owner: "newms87" }],
    });
    expect(out).toBe(
      [
        `[url "https://x-access-token:ghp_TESTTOKEN@github.com/"]`,
        `\tinsteadOf = git@github.com:`,
        `\tinsteadOf = https://github.com/`,
        `[url "https://x-access-token:ghp_TESTTOKEN@github.com/newms87/"]`,
        `\tinsteadOf = git@github-newms87:newms87/`,
        `[user]`,
        `\temail = danxbot@example.com`,
        `\tname = danxbot`,
        ``,
      ].join("\n"),
    );
  });

  it("emits one per-alias block per alias entry", () => {
    const out = renderGitconfig({
      token: "ghp_X",
      email: "x@y.z",
      aliases: [
        { alias: "github-foo", owner: "foo" },
        { alias: "github-bar", owner: "bar" },
      ],
    });
    expect(out).toContain(
      `[url "https://x-access-token:ghp_X@github.com/foo/"]\n\tinsteadOf = git@github-foo:foo/`,
    );
    expect(out).toContain(
      `[url "https://x-access-token:ghp_X@github.com/bar/"]\n\tinsteadOf = git@github-bar:bar/`,
    );
  });

  it("emits exact body with zero aliases (no per-alias block leaks)", () => {
    const out = renderGitconfig({
      token: "ghp_X",
      email: "x@y.z",
      aliases: [],
    });
    expect(out).toBe(
      [
        `[url "https://x-access-token:ghp_X@github.com/"]`,
        `\tinsteadOf = git@github.com:`,
        `\tinsteadOf = https://github.com/`,
        `[user]`,
        `\temail = x@y.z`,
        `\tname = danxbot`,
        ``,
      ].join("\n"),
    );
    // Defense: no `git@github-` per-alias block when none provided.
    expect(out).not.toMatch(/git@github-/);
  });
});
