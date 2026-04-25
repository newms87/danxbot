/**
 * Regression test for Trello PHevzRil — local worker `claude -p` silently
 * exits when the claude-auth bind mounts are read-only.
 *
 * Claude Code's `-p` headless mode rewrites `.claude.json` (session
 * metadata) on most runs and rotates `.credentials.json` periodically by
 * atomic-write + rename(). When the bind is mounted `:ro`, those writes
 * fail and the agent silently exits 0 with empty stdout — no JSONL, no
 * dispatch completion, no error message. The fix is to leave both binds
 * read-write (the default) so claude-in-container can update its config
 * and rotate tokens through to the host file.
 *
 * This test parses the worker compose.yml's `volumes:` block and asserts
 * the claude-auth binds:
 *   1. Carry no read-only option (in any of Docker's accepted forms).
 *   2. Reference the correct host-side env var — guards against the
 *      `CLAUDE_CREDS_FILE` vs `CLAUDE_CREDS_DIR` typo class.
 *   3. Never re-introduce the file-bind shape on `.credentials.json`
 *      (Trello 9ZurZCK2 / 0bjFD0a2 — the file-bind pins the host inode
 *      and breaks atomic-rename rotation).
 *
 * If a future change reintroduces any of those regressions, this test
 * fails before the bad config reaches a worker.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPOSE_PATH = join(process.cwd(), ".danxbot/config/compose.yml");

const CLAUDE_JSON_DEST = "/danxbot/app/claude-auth/.claude.json";
const CLAUDE_DIR_DEST = "/danxbot/app/claude-auth/.claude";
const CREDENTIALS_FILE_DEST = "/danxbot/app/claude-auth/.claude/.credentials.json";

// Matches `:ro` as a standalone option (or first/middle/last entry in a
// comma-separated option list). Catches `:ro`, `:ro,Z`, `:cached,ro`,
// `:ro,cached,z`, etc.
const READONLY_OPTION = /(?:^|,)(?:ro|readonly)(?:,|$)/;

interface Volume {
  raw: string;
  source: string;
  destination: string;
  options: string[];
}

function parseVolume(line: string): Volume | null {
  const trimmed = line.replace(/^\s*-\s*/, "").trim();
  if (!trimmed.startsWith("$") && !trimmed.startsWith("/") && !trimmed.startsWith(".")) {
    return null;
  }
  // Compose entries are `source:destination[:options]`. Source may contain
  // `:` inside a `${VAR:-default}` expansion, so we walk the string and
  // ignore colons inside `${...}` braces. After the source's terminating
  // colon, the destination is everything up to the next colon at brace
  // depth 0; remaining text is comma-separated options.
  const positions: number[] = [];
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ":" && depth === 0) positions.push(i);
  }
  if (positions.length === 0) return null;
  const source = trimmed.slice(0, positions[0]);
  const destination = trimmed.slice(
    positions[0] + 1,
    positions.length >= 2 ? positions[1] : trimmed.length,
  );
  const optionsRaw =
    positions.length >= 2 ? trimmed.slice(positions[1] + 1) : "";
  return {
    raw: trimmed,
    source,
    destination,
    options: optionsRaw ? optionsRaw.split(",") : [],
  };
}

function readComposeVolumes(): Volume[] {
  const text = readFileSync(COMPOSE_PATH, "utf-8");
  const lines = text.split(/\r?\n/);
  const volumes: Volume[] = [];
  let inVolumesBlock = false;
  let volumesIndent = -1;
  for (const line of lines) {
    const stripped = line.replace(/\s+$/, "");
    if (/^\s*volumes:\s*$/.test(stripped)) {
      inVolumesBlock = true;
      volumesIndent = stripped.search(/\S/);
      continue;
    }
    if (!inVolumesBlock) continue;
    if (stripped.length === 0) continue;
    const indent = stripped.search(/\S/);
    if (indent <= volumesIndent && !stripped.trimStart().startsWith("-")) {
      // Block ended at a sibling key.
      inVolumesBlock = false;
      continue;
    }
    if (!stripped.trimStart().startsWith("- ")) continue;
    const v = parseVolume(stripped);
    if (v) volumes.push(v);
  }
  return volumes;
}

function findByDestination(volumes: Volume[], dest: string): Volume | undefined {
  return volumes.find((v) => v.destination === dest);
}

describe("worker compose.yml claude-auth mounts", () => {
  const volumes = readComposeVolumes();

  it("binds .claude.json without a read-only option so container claude can rewrite session metadata", () => {
    const v = findByDestination(volumes, CLAUDE_JSON_DEST);
    expect(v, ".claude.json bind not found in compose.yml").toBeDefined();
    const optsString = v!.options.join(",");
    expect(
      READONLY_OPTION.test(optsString),
      `.claude.json bind has a read-only option: ${v!.raw}`,
    ).toBe(false);
  });

  it("binds .claude/ without a read-only option so container claude can atomic-rename .credentials.json", () => {
    const v = findByDestination(volumes, CLAUDE_DIR_DEST);
    expect(v, ".claude/ bind not found in compose.yml").toBeDefined();
    const optsString = v!.options.join(",");
    expect(
      READONLY_OPTION.test(optsString),
      `.claude/ bind has a read-only option: ${v!.raw}`,
    ).toBe(false);
  });

  it("references CLAUDE_CONFIG_FILE on the .claude.json source — guards against env-var-name typos", () => {
    const v = findByDestination(volumes, CLAUDE_JSON_DEST);
    expect(v, ".claude.json bind not found").toBeDefined();
    expect(
      v!.source.includes("${CLAUDE_CONFIG_FILE"),
      `.claude.json source must reference CLAUDE_CONFIG_FILE: got ${v!.source}`,
    ).toBe(true);
  });

  it("references CLAUDE_CREDS_DIR (not CLAUDE_CREDS_FILE) on the .claude/ dir source", () => {
    const v = findByDestination(volumes, CLAUDE_DIR_DEST);
    expect(v, ".claude/ bind not found").toBeDefined();
    expect(
      v!.source.includes("${CLAUDE_CREDS_DIR"),
      `.claude/ source must reference CLAUDE_CREDS_DIR: got ${v!.source}`,
    ).toBe(true);
    expect(
      v!.source.includes("CLAUDE_CREDS_FILE"),
      `.claude/ source must NOT reference the legacy CLAUDE_CREDS_FILE`,
    ).toBe(false);
  });

  it("never re-introduces a file-bind on .credentials.json — file-binds break atomic-rename rotation (Trello 0bjFD0a2)", () => {
    const fileBind = findByDestination(volumes, CREDENTIALS_FILE_DEST);
    expect(
      fileBind,
      `compose.yml must NOT bind .credentials.json directly — use the parent .claude/ dir-bind. Found: ${fileBind?.raw}`,
    ).toBeUndefined();
  });
});

// Regression test for Trello auX4nTRk — getDanxbotCommit() reads
// `process.env.DANXBOT_COMMIT` baked into the image at build time
// (Dockerfile ARG/ENV). A `DANXBOT_COMMIT: ${DANXBOT_COMMIT:-}` line in
// the worker compose's `environment:` block looks helpful but is the
// exact failure mode of the original bug: when the host shell hasn't
// exported the var, compose interpolates the default empty string and
// OVERRIDES the image-baked ENV inside the container, restoring the
// `danxbot_commit = NULL` rows we just paid to fix. Keep the entry out.
describe("worker compose.yml does not override the baked DANXBOT_COMMIT", () => {
  const text = readFileSync(COMPOSE_PATH, "utf-8");

  it("must NOT add DANXBOT_COMMIT to the container env — would override the image-baked ENV with empty when the host shell doesn't export it", () => {
    expect(
      /^\s*DANXBOT_COMMIT:\s/m.test(text),
      "compose.yml `environment:` must NOT contain `DANXBOT_COMMIT: ...` — the SHA reaches the runtime via the image-baked ENV (Dockerfile ARG). See Trello auX4nTRk.",
    ).toBe(false);
  });
});
