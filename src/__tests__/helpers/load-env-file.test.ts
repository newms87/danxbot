/**
 * Unit tests for the .env loader used by both vitest setup files
 * (`<repoRoot>/vitest.setup.ts` and
 * `src/__tests__/validation/load-env.ts`). The parser must run on the
 * host's Node 18.x — `process.loadEnvFile` (Node 20.12+) is NOT
 * available there, so the helper hand-parses a small subset of the
 * dotenv format.
 *
 * Keep this suite hermetic: it must not touch the repo's real `.env`
 * (would mutate `process.env` for every other test in the file). All
 * fixtures are written into a per-test tmpdir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "./load-env-file.js";

const SENTINEL_KEYS = [
  "DXTEST_SIMPLE",
  "DXTEST_DOUBLE_QUOTED",
  "DXTEST_SINGLE_QUOTED",
  "DXTEST_EMPTY",
  "DXTEST_WITH_EQUALS",
  "DXTEST_TRIMMED",
  "DXTEST_PREEXISTING",
  "DXTEST_COMMENT_INLINE",
];

describe("loadEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "danxbot-load-env-"));
    for (const key of SENTINEL_KEYS) delete process.env[key];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of SENTINEL_KEYS) delete process.env[key];
  });

  function writeEnv(content: string): string {
    const path = join(dir, ".env");
    writeFileSync(path, content);
    return path;
  }

  it("loads simple KEY=VALUE pairs into process.env", () => {
    const path = writeEnv("DXTEST_SIMPLE=hello\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_SIMPLE).toBe("hello");
  });

  it("strips matching surrounding double quotes from values", () => {
    const path = writeEnv('DXTEST_DOUBLE_QUOTED="hello world"\n');
    loadEnvFile(path);
    expect(process.env.DXTEST_DOUBLE_QUOTED).toBe("hello world");
  });

  it("strips matching surrounding single quotes from values", () => {
    const path = writeEnv("DXTEST_SINGLE_QUOTED='hello world'\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_SINGLE_QUOTED).toBe("hello world");
  });

  it("supports empty values", () => {
    const path = writeEnv("DXTEST_EMPTY=\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_EMPTY).toBe("");
  });

  it("preserves '=' characters that appear inside the value", () => {
    const path = writeEnv("DXTEST_WITH_EQUALS=a=b=c\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_WITH_EQUALS).toBe("a=b=c");
  });

  it("trims whitespace around the key but preserves leading/trailing spaces inside quoted values", () => {
    const path = writeEnv('  DXTEST_TRIMMED   =   "  padded  "  \n');
    loadEnvFile(path);
    expect(process.env.DXTEST_TRIMMED).toBe("  padded  ");
  });

  it("ignores comment lines and blank lines", () => {
    const path = writeEnv(
      [
        "# this is a comment",
        "",
        "   # indented comment",
        "DXTEST_SIMPLE=ok",
        "",
      ].join("\n"),
    );
    loadEnvFile(path);
    expect(process.env.DXTEST_SIMPLE).toBe("ok");
  });

  it("does NOT override an existing process.env value (CI/operator overrides .env)", () => {
    process.env.DXTEST_PREEXISTING = "from-shell";
    const path = writeEnv("DXTEST_PREEXISTING=from-file\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_PREEXISTING).toBe("from-shell");
  });

  it("silently no-ops when the file does not exist", () => {
    expect(() => loadEnvFile(join(dir, "nope.env"))).not.toThrow();
  });

  it("treats inline `#` as part of the value (matches dotenv-cli + Node --env-file)", () => {
    // The dotenv ecosystem is split on inline-comment handling. Both
    // dotenv-cli and Node's native `--env-file` treat `#` as part of
    // the value unless the value is quoted. Match that behavior so
    // operators don't get surprised by silently-stripped suffixes
    // when copying values from shell-quoted strings.
    const path = writeEnv("DXTEST_COMMENT_INLINE=value # not-a-comment\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_COMMENT_INLINE).toBe("value # not-a-comment");
  });

  it("loads many keys in one call", () => {
    const path = writeEnv(
      ["DXTEST_SIMPLE=a", "DXTEST_DOUBLE_QUOTED=b", "DXTEST_EMPTY="].join("\n"),
    );
    loadEnvFile(path);
    expect(process.env.DXTEST_SIMPLE).toBe("a");
    expect(process.env.DXTEST_DOUBLE_QUOTED).toBe("b");
    expect(process.env.DXTEST_EMPTY).toBe("");
  });

  it("skips lines with no `=` (no key-value separator)", () => {
    const path = writeEnv("DXTEST_SIMPLE\nDXTEST_DOUBLE_QUOTED=ok\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_SIMPLE).toBeUndefined();
    expect(process.env.DXTEST_DOUBLE_QUOTED).toBe("ok");
  });

  it("skips lines with an empty key (`=value`)", () => {
    const path = writeEnv("=lonely\nDXTEST_SIMPLE=ok\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_SIMPLE).toBe("ok");
  });

  // The next three are explicit NON-support assertions. The helper's
  // docstring promises the dotenv-style features it does NOT support;
  // these tests lock that contract so a future "convenience" patch
  // doesn't silently add interpolation/escapes/multi-line and break
  // a downstream consumer.

  it("does NOT interpolate `${VAR}` references — value stays literal", () => {
    process.env.DXTEST_PREEXISTING = "from-shell";
    const path = writeEnv("DXTEST_SIMPLE=${DXTEST_PREEXISTING}/suffix\n");
    loadEnvFile(path);
    expect(process.env.DXTEST_SIMPLE).toBe("${DXTEST_PREEXISTING}/suffix");
  });

  it("does NOT decode `\\n` escape sequences — backslash-n stays literal", () => {
    const path = writeEnv('DXTEST_DOUBLE_QUOTED="line1\\nline2"\n');
    loadEnvFile(path);
    expect(process.env.DXTEST_DOUBLE_QUOTED).toBe("line1\\nline2");
  });

  it("does NOT support multi-line values — only the first physical line is the value", () => {
    // dotenv-cli would parse `KEY="line1\nline2"` (literal newline
    // inside the quoted string) as a multi-line value spanning two
    // physical lines. Our parser splits on `\n` first, so the second
    // physical line is interpreted as its own KEY=VALUE attempt
    // (which here is `line2"`, a no-`=` line, silently skipped) and
    // the first line's value becomes the unterminated `"line1`.
    const path = writeEnv('DXTEST_DOUBLE_QUOTED="line1\nline2"\n');
    loadEnvFile(path);
    expect(process.env.DXTEST_DOUBLE_QUOTED).toBe('"line1');
  });
});
