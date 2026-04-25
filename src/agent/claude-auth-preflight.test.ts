/**
 * Unit tests for the spawn-time claude-auth preflight (Trello 3l2d7i46).
 *
 * Three claude-auth misconfigurations all surface as the SAME silent timeout:
 *   1. RO bind on .claude.json or .claude/.credentials.json (the workers got
 *      this wrong in PHevzRil — claude -p exits 0 with empty stdout)
 *   2. Expired OAuth token (snapshot dir that never rotated)
 *   3. Missing files (half-configured layout)
 *
 * The preflight rejects each loudly so the dispatch fails at launch instead
 * of timing out after N seconds with a useless "Agent timed out after N
 * seconds of inactivity" summary.
 *
 * Tests use real temp files + chmod, not fs mocks. The real semantics of
 * fs.access(W_OK) on a chmod 0o444 file is exactly what production
 * preflight checks. The file-mode test is skipped under root (uid=0)
 * because root bypasses standard write checks; CI / dev shells run
 * non-root and exercise the path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightClaudeAuth } from "./claude-auth-preflight.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = 1_777_000_000_000;

let tmpRoot: string;
let claudeJsonPath: string;
let credsDir: string;
let credsPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "claude-auth-preflight-"));
  claudeJsonPath = join(tmpRoot, ".claude.json");
  credsDir = join(tmpRoot, ".claude");
  credsPath = join(credsDir, ".credentials.json");
  mkdirSync(credsDir, { recursive: true });
});

afterEach(() => {
  // Restore mode so rmSync can recurse — chmod 0o444 directories block
  // unlink in some sandboxes.
  try {
    chmodSync(claudeJsonPath, 0o644);
  } catch {
    // missing file: fine
  }
  try {
    chmodSync(credsPath, 0o644);
  } catch {
    // missing file: fine
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeValidCreds(expiresAtMs: number): void {
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-fake",
        refreshToken: "rt-fake",
        expiresAt: expiresAtMs,
      },
    }),
  );
}

function writeValidClaudeJson(): void {
  writeFileSync(claudeJsonPath, '{"firstStartTime":"2026-01-01T00:00:00Z"}');
}

const isRoot = process.getuid?.() === 0;

describe("preflightClaudeAuth", () => {
  it("returns ok when both files are writable and the OAuth token is in the future", async () => {
    writeValidClaudeJson();
    writeValidCreds(FIXED_NOW + ONE_HOUR_MS);

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(true);
  });

  it("fails with reason=missing when .claude.json does not exist", async () => {
    // Don't write claudeJsonPath. credsPath is fine — proves preflight checks
    // each file independently and reports the FIRST missing one rather than
    // collapsing both into a generic "missing" message.
    writeValidCreds(FIXED_NOW + ONE_HOUR_MS);

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.summary).toMatch(/\.claude\.json/);
  });

  it("fails with reason=missing when .credentials.json does not exist", async () => {
    writeValidClaudeJson();
    // Don't write credsPath.

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.summary).toMatch(/credentials/);
  });

  it.skipIf(isRoot)(
    "fails with reason=readonly when .claude.json is not writable",
    async () => {
      writeValidClaudeJson();
      writeValidCreds(FIXED_NOW + ONE_HOUR_MS);
      chmodSync(claudeJsonPath, 0o444);

      const result = await preflightClaudeAuth({
        claudeJsonPath,
        credentialsPath: credsPath,
        now: () => FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("readonly");
      expect(result.summary).toMatch(/read-only/i);
      expect(result.summary).toMatch(/\.claude\.json/);
    },
  );

  it.skipIf(isRoot)(
    "fails with reason=readonly when .credentials.json is not writable",
    async () => {
      writeValidClaudeJson();
      writeValidCreds(FIXED_NOW + ONE_HOUR_MS);
      chmodSync(credsPath, 0o444);

      const result = await preflightClaudeAuth({
        claudeJsonPath,
        credentialsPath: credsPath,
        now: () => FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("readonly");
      expect(result.summary).toMatch(/read-only/i);
      expect(result.summary).toMatch(/credentials/);
    },
  );

  it("fails with reason=expired when claudeAiOauth.expiresAt is in the past", async () => {
    writeValidClaudeJson();
    const expiredAtMs = FIXED_NOW - ONE_HOUR_MS;
    writeValidCreds(expiredAtMs);

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired");
    // ISO-formatted timestamp gives the operator the exact "this is how far
    // gone the snapshot is" — far more useful than "token is expired."
    expect(result.summary).toMatch(/expired/i);
    expect(result.summary).toContain(new Date(expiredAtMs).toISOString());
  });

  it("fails with reason=malformed when .credentials.json is not valid JSON", async () => {
    writeValidClaudeJson();
    writeFileSync(credsPath, "{not-valid-json");

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
    expect(result.summary).toMatch(/credentials/);
  });

  it("fails with reason=malformed when claudeAiOauth.expiresAt is missing", async () => {
    writeValidClaudeJson();
    writeFileSync(
      credsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "x" } }),
    );

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
    expect(result.summary).toMatch(/expiresAt/);
  });

  it("fails with reason=malformed when claudeAiOauth.expiresAt is not a number", async () => {
    writeValidClaudeJson();
    writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "x", expiresAt: "not-a-number" },
      }),
    );

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
    expect(result.summary).toMatch(/expiresAt/);
  });

  it("fails with reason=malformed when expiresAt is non-finite (NaN / Infinity)", async () => {
    // JSON has no NaN/Infinity literals — they parse as null. Write a value
    // that survives JSON.parse as a non-finite number using string mutation.
    writeValidClaudeJson();
    writeFileSync(
      credsPath,
      // Non-standard but parseable in many environments: write the literal.
      // If JSON.parse rejects it, that's malformed too — same outcome.
      '{"claudeAiOauth":{"accessToken":"x","expiresAt":null}}',
    );

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("fails with reason=malformed when claudeAiOauth field is missing entirely", async () => {
    writeValidClaudeJson();
    writeFileSync(credsPath, JSON.stringify({ otherField: "x" }));

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("fails with reason=malformed when claudeAiOauth is not an object", async () => {
    writeValidClaudeJson();
    writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: "not-an-object" }));

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("fails with reason=malformed when the parsed credentials root is not an object", async () => {
    // JSON.parse("null") returns null — a valid JSON value but not the
    // shape extractExpiresAt expects. Same applies to arrays and primitives.
    writeValidClaudeJson();
    writeFileSync(credsPath, "null");

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("returns ok when expiresAt equals now() — boundary is strict less-than", async () => {
    // Lock the < vs <= choice. A future tweak to <= flips this test red and
    // forces the author to confirm the behavior change is intentional.
    writeValidClaudeJson();
    writeValidCreds(FIXED_NOW);

    const result = await preflightClaudeAuth({
      claudeJsonPath,
      credentialsPath: credsPath,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(true);
  });

  it.skipIf(isRoot)(
    "follows symlinks for the writability check (production layout uses bind-mount symlinks)",
    async () => {
      // Real production layout: ~/.claude.json is a symlink pointing at
      // $CLAUDE_AUTH_DIR/.claude.json under the bind. fs.access(W_OK)
      // follows symlinks and checks W_OK on the TARGET. RO bind →
      // chmod 0o444 on target → access on symlink → EACCES → readonly.
      const realClaudeJson = join(tmpRoot, "real.claude.json");
      const symlinkPath = join(tmpRoot, "link.claude.json");
      writeFileSync(realClaudeJson, "{}");
      symlinkSync(realClaudeJson, symlinkPath);
      chmodSync(realClaudeJson, 0o444);
      writeValidCreds(FIXED_NOW + ONE_HOUR_MS);

      const result = await preflightClaudeAuth({
        claudeJsonPath: symlinkPath,
        credentialsPath: credsPath,
        now: () => FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("readonly");
    },
  );
});
