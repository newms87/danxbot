/**
 * Regression test for Trello cjAyJpgr AC6 — install.sh / make setup
 * creates `<repo>/claude-projects/` with UID-1000-writable permissions
 * for every connected repo at install time.
 *
 * The worker compose binds `../../claude-projects` as the host source for
 * `/home/danxbot/.claude/projects` inside the container. If the host dir
 * doesn't exist when `docker compose up` runs, Docker auto-creates it
 * root-owned, which blocks the in-container `danxbot` user (UID 1000)
 * from writing JSONL — the exact silent failure mode this card opened
 * against. Pre-creating the dir at install time (with UID 1000 owner)
 * eliminates that race entirely.
 *
 * A Makefile-level mkdir already happens in `launch-worker` /
 * `launch-all-workers`, but AC6 requires install-time creation so a
 * fresh clone reaches first-launch with the dirs already in place.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL_PATH = join(process.cwd(), "install.sh");

describe("install.sh — claude-projects bootstrap (Trello cjAyJpgr AC6)", () => {
  const text = readFileSync(INSTALL_PATH, "utf-8");

  it("parses REPOS from .env after /setup completes so each connected repo can be processed", () => {
    // /setup writes REPOS=<name>:<url>,... to .env. install.sh must read
    // that file AFTER the interactive setup exits, otherwise the loop
    // runs against an empty REPOS on first install.
    expect(
      /\.\s+\.\/\.env|source\s+\.\/\.env|set\s+-a;?\s*\.\s+\.\/\.env/.test(text),
      "install.sh must source .env after /setup so REPOS is in scope",
    ).toBe(true);
  });

  it("creates each connected repo's claude-projects/ dir at install time", () => {
    // Loop over REPOS entries (comma-separated `name:url` pairs) and
    // `mkdir -p repos/<name>/claude-projects` for each one. Idempotent.
    expect(
      /mkdir\s+-p\s+["']?repos\/\$\{?name\}?\/claude-projects/.test(text),
      "install.sh must mkdir repos/<name>/claude-projects per REPOS entry",
    ).toBe(true);
  });

  it("chowns each created dir to UID 1000 so the worker container's danxbot user can write", () => {
    // The worker container's `danxbot` user is UID 1000 (Dockerfile pin).
    // Dev hosts where the host UID != 1000 need a chown so Docker doesn't
    // mount a host-owned dir that the container user can't write to.
    // sudo fallback acceptable — interactive install can prompt.
    expect(
      /chown\s+1000:1000\s+["']?repos\/\$\{?name\}?\/claude-projects/.test(text),
      "install.sh must chown 1000:1000 on each created claude-projects dir",
    ).toBe(true);
  });

  it("uses idempotent `mkdir -p` so re-running install.sh doesn't error on existing dirs", () => {
    // `mkdir` (no -p) errors if the dir exists. install.sh runs every
    // time the operator re-installs / re-runs the wizard; the loop
    // must be safe to invoke against an already-bootstrapped tree.
    expect(
      /mkdir\s+-p\s+["']?repos\/\$\{?name\}?\/claude-projects/.test(text),
      "mkdir must use -p flag for idempotency",
    ).toBe(true);
  });

  it("guards against empty REPOS entries — empty `name` after `${entry%%:*}` is skipped, not turned into `repos//claude-projects`", () => {
    // `REPOS=""` or a trailing comma (`REPOS=foo:url,`) produces a
    // 1-element array `[""]` from `read -ra`; without an empty-name
    // guard the loop body would run mkdir on `repos//claude-projects`
    // — succeeds but creates a meaningless dir. Pin the guard so a
    // future refactor that drops it fails loudly here.
    expect(
      /\[\s*-z\s+["']?\$\{?name\}?["']?\s*\]\s*&&\s*continue|if\s+\[\s*-z\s+["']?\$\{?name\}?["']?\s*\]\s*;\s*then\s+continue/.test(text),
      "install.sh must skip empty `name` entries before mkdir",
    ).toBe(true);
  });

  it("chown chain is fail-soft — unprivileged → sudo → WARN, install never aborts on chown failure", () => {
    // Three rungs: unprivileged chown, sudo chown, final WARN echo.
    // Without the final rung, `set -e` aborts the install on a host
    // where chown is rejected (CI containers, restrictive policies).
    // The `WARN:` uppercase prefix matches `ERROR:` convention above
    // so a future filter on install output sees both.
    expect(
      /chown\s+1000:1000[^|]*\|\|[^|]*sudo\s+chown\s+1000:1000/.test(text),
      "chown must fall through to sudo chown",
    ).toBe(true);
    expect(
      /\|\|\s*\{?\s*echo\s+["']WARN:/.test(text),
      "chown chain must end with a WARN-prefixed echo so install never aborts on chown failure",
    ).toBe(true);
  });

  it("emits a consolidated WARN summary at end of bootstrap when any chown failed — install exit 0 must not bury the partial-failure signal", () => {
    // Per-line WARNs are easy to scroll past during a verbose npm
    // install. A consolidated summary at the end (gated on a
    // `chown_failed` flag) ensures the operator sees one definitive
    // status line.
    expect(
      /chown_failed=1/.test(text),
      "install.sh must track chown_failed=1 when a chown fails",
    ).toBe(true);
    expect(
      /chown_failed.*=.*["']1["']|chown_failed\s*=\s*1\s*\]/.test(text),
      "install.sh must check chown_failed at end-of-bootstrap and print a summary",
    ).toBe(true);
  });

  it("runs the bootstrap AFTER `claude '/setup'` — REPOS is populated by /setup, so order matters", () => {
    // /setup is the source of REPOS in .env. The bootstrap loop must
    // appear AFTER the `claude /setup` invocation so it sees the
    // populated value. A loop above /setup runs against an empty REPOS
    // on first install and silently no-ops.
    const setupIdx = text.search(/claude\s+['"]?\/setup/);
    const mkdirIdx = text.search(/mkdir\s+-p\s+["']?repos\/\$\{?name\}?\/claude-projects/);
    expect(setupIdx, "install.sh must invoke claude /setup").toBeGreaterThan(-1);
    expect(mkdirIdx, "install.sh must contain claude-projects mkdir loop").toBeGreaterThan(-1);
    expect(
      mkdirIdx > setupIdx,
      `claude-projects mkdir (index ${mkdirIdx}) must appear AFTER claude /setup (index ${setupIdx})`,
    ).toBe(true);
  });
});
