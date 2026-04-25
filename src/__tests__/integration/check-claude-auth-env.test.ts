/**
 * Integration tests for scripts/check-claude-auth-env.sh.
 *
 * The script is called from the Makefile's `launch-worker REPO=danxbot`
 * recipe BEFORE `docker compose up`, to fail loud if the operator hasn't
 * set CLAUDE_CONFIG_FILE / CLAUDE_CREDS_DIR. Without this gate, compose
 * silently fell back to a stale snapshot dir that broke dispatches within
 * ~24h of setup (Trello th8GCprR).
 *
 * Tests run the real shell script via child_process. No mocks.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/check-claude-auth-env.sh");
const COMPOSE_PATH = join(process.cwd(), ".danxbot/config/compose.yml");
const ENV_EXAMPLE = join(process.cwd(), ".env.example");

function runScript(env: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }
  return spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", ...cleanEnv },
    encoding: "utf-8",
  });
}

describe("scripts/check-claude-auth-env.sh", () => {
  it("exits 0 when both CLAUDE_CONFIG_FILE and CLAUDE_CREDS_DIR are set", () => {
    const result = runScript({
      CLAUDE_CONFIG_FILE: "/home/test/.claude.json",
      CLAUDE_CREDS_DIR: "/home/test/.claude",
    });
    expect(result.status).toBe(0);
  });

  it("exits 1 with an error mentioning CLAUDE_CONFIG_FILE when only that var is missing", () => {
    const result = runScript({
      CLAUDE_CREDS_DIR: "/home/test/.claude",
      // CLAUDE_CONFIG_FILE intentionally unset
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE_CONFIG_FILE");
  });

  it("exits 1 with an error mentioning CLAUDE_CREDS_DIR when only that var is missing", () => {
    const result = runScript({
      CLAUDE_CONFIG_FILE: "/home/test/.claude.json",
      // CLAUDE_CREDS_DIR intentionally unset
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE_CREDS_DIR");
  });

  it("exits 1 mentioning both vars when neither is set", () => {
    const result = runScript({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE_CONFIG_FILE");
    expect(result.stderr).toContain("CLAUDE_CREDS_DIR");
  });

  it("treats empty string as unset", () => {
    const result = runScript({
      CLAUDE_CONFIG_FILE: "",
      CLAUDE_CREDS_DIR: "",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE_CONFIG_FILE");
    expect(result.stderr).toContain("CLAUDE_CREDS_DIR");
  });

  it("error output points operators at .env.example for the copy-pasteable block", () => {
    const result = runScript({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".env.example");
  });

  // The Makefile recipe is `./scripts/check-claude-auth-env.sh` — a relative
  // path with no `bash` prefix. If the executable bit gets lost (Windows
  // checkout, archive round-trip, accidental chmod), the recipe fails with
  // "Permission denied" and the AC2 gate silently regresses. Cheap to assert.
  it("script file is executable so the Makefile's `./scripts/...` invocation works", () => {
    const stat = statSync(SCRIPT);
    // Owner execute bit must be set; we don't care about group/other for portability.
    expect(stat.mode & 0o100).toBe(0o100);
  });
});

describe("AC verification — Makefile + .env.example wiring", () => {
  // AC2 — `make launch-worker REPO=danxbot` invokes the script BEFORE
  // `docker compose up`. We use `make -n` (dry-run) so docker is never
  // actually invoked. The dry-run prints recipe lines verbatim, so we
  // can assert the script call appears, and that it appears in a
  // recipe block conditional on REPO=danxbot.
  // The makefile recipe is one long `\`-continued shell block, so we can't
  // use `make -n` (it prints recipe lines as-is, but the assertion target is
  // the line content). Read the Makefile directly and assert structurally:
  // the launch-worker target body invokes the script when REPO=danxbot, and
  // the invocation appears before `docker compose ... up`.
  it("Makefile launch-worker recipe invokes the pre-check script before docker compose up (gated on REPO=danxbot)", () => {
    const text = readFileSync(join(process.cwd(), "Makefile"), "utf-8");
    // Extract the launch-worker target body (until the next blank line / target).
    const match = text.match(/^launch-worker:[^\n]*\n((?:\t[^\n]*\n)+)/m);
    expect(match, "launch-worker target not found in Makefile").not.toBeNull();
    const body = match![1];
    expect(body, "launch-worker body must reference the pre-check script").toContain(
      "check-claude-auth-env.sh",
    );
    // Conditional gate: must wrap the script invocation with REPO=danxbot.
    expect(body).toMatch(/\[\s*"\$\(REPO\)"\s*=\s*"danxbot"\s*\]/);
    // Order: script invocation must come before `docker compose ... up`.
    const scriptIdx = body.indexOf("check-claude-auth-env.sh");
    const composeIdx = body.indexOf("docker compose");
    expect(composeIdx, "docker compose line must appear in body").toBeGreaterThanOrEqual(0);
    expect(scriptIdx).toBeLessThan(composeIdx);
  });

  // AC3 — `.env.example` documents both vars in a copy-pasteable block.
  // The script's error message points operators here, so this reference
  // must not rot.
  it(".env.example contains the CLAUDE_CONFIG_FILE / CLAUDE_CREDS_DIR copy-pasteable block", () => {
    const text = readFileSync(ENV_EXAMPLE, "utf-8");
    expect(text).toMatch(/CLAUDE_CONFIG_FILE=/);
    expect(text).toMatch(/CLAUDE_CREDS_DIR=/);
  });

  // AC4 — `docker compose -f .danxbot/config/compose.yml config` without
  // `CLAUDE_CONFIG_FILE` set must emit "required variable …", not a silent
  // default. The compose-mounts test asserts the `:?` syntax is present in
  // the YAML; this test exercises the runtime behavior end-to-end.
  //
  // Skipped automatically when `docker` is not on PATH (worker container
  // doesn't have docker socket access; CI without docker would also skip).
  it("docker compose config rejects with 'required variable' when CLAUDE_CONFIG_FILE is unset", () => {
    const dockerCheck = spawnSync("docker", ["--version"], { encoding: "utf-8" });
    if (dockerCheck.status !== 0) {
      // Docker not available in this environment — defer to the YAML-syntax test.
      return;
    }
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_FILE;
    delete env.CLAUDE_CREDS_DIR;
    // compose still needs DANXBOT_WORKER_PORT for the `ports:` interpolation;
    // give it any value so we can test the auth-var check in isolation.
    env.DANXBOT_WORKER_PORT = env.DANXBOT_WORKER_PORT ?? "5560";
    const result = spawnSync("docker", ["compose", "-f", COMPOSE_PATH, "config"], {
      env,
      encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    const stderr = result.stderr ?? "";
    expect(stderr).toMatch(/required variable.*CLAUDE_CONFIG_FILE/i);
  });
});
