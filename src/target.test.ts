import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadTarget, findTargetPath } from "./target.js";

vi.mock("./poller/constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
}));

let tmp: string;

function writeTarget(name: string, body: string): string {
  const targetsDir = resolve(tmp, "deploy/targets");
  mkdirSync(targetsDir, { recursive: true });
  const path = resolve(targetsDir, `${name}.yml`);
  writeFileSync(path, body, "utf-8");
  return path;
}

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "danxbot-target-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadTarget", () => {
  it("parses a deploy-mode target with multiple repos", () => {
    writeTarget(
      "gpt",
      `
name: danxbot-production
mode: deploy
repos:
  - name: danxbot
    url: https://github.com/x/danxbot.git
    worker_port: 5561
  - name: gpt-manager
    url: https://github.com/x/gpt-manager.git
    worker_port: 5562
`,
    );
    const t = loadTarget("gpt", tmp);
    expect(t.name).toBe("danxbot-production");
    expect(t.mode).toBe("deploy");
    expect(t.repos).toHaveLength(2);
    expect(t.repos[0]).toEqual({
      name: "danxbot",
      url: "https://github.com/x/danxbot.git",
      localPath: "/danxbot/repos/danxbot",
      workerPort: 5561,
    });
    expect(t.repos[1].workerPort).toBe(5562);
  });

  it("defaults mode to 'deploy' when omitted", () => {
    writeTarget("noMode", `name: x\nrepos: []\n`);
    expect(loadTarget("noMode", tmp).mode).toBe("deploy");
  });

  it("accepts mode: local", () => {
    writeTarget("local", `name: danxbot-local\nmode: local\nrepos: []\n`);
    expect(loadTarget("local", tmp).mode).toBe("local");
  });

  it("rejects invalid mode value", () => {
    writeTarget("bad", `name: x\nmode: staging\nrepos: []\n`);
    expect(() => loadTarget("bad", tmp)).toThrow(/Invalid `mode`/);
  });

  it("parses optional worker_host", () => {
    writeTarget(
      "with-host",
      `
name: x
repos:
  - name: a
    url: https://github.com/x/a.git
    worker_port: 5561
    worker_host: alpha-alias
  - name: b
    url: https://github.com/x/b.git
    worker_port: 5562
`,
    );
    const t = loadTarget("with-host", tmp);
    expect(t.repos[0].workerHost).toBe("alpha-alias");
    expect(t.repos[1].workerHost).toBeUndefined();
  });

  it("rejects worker_host with whitespace", () => {
    writeTarget(
      "ws-host",
      `
name: x
repos:
  - name: a
    url: https://github.com/x/a.git
    worker_port: 5561
    worker_host: bad host
`,
    );
    expect(() => loadTarget("ws-host", tmp)).toThrow(/worker_host/);
  });

  it("rejects worker_port out of range", () => {
    writeTarget(
      "bad-port",
      `
name: x
repos:
  - name: a
    url: https://github.com/x/a.git
    worker_port: 70000
`,
    );
    expect(() => loadTarget("bad-port", tmp)).toThrow(/worker_port/);
  });

  it("rejects empty repos[].name", () => {
    writeTarget(
      "no-name",
      `
name: x
repos:
  - url: https://github.com/x/a.git
    worker_port: 5561
`,
    );
    expect(() => loadTarget("no-name", tmp)).toThrow(/repos\[\]\.name/);
  });

  it("returns empty repos when omitted entirely", () => {
    writeTarget("empty", `name: x\nmode: local\n`);
    expect(loadTarget("empty", tmp).repos).toEqual([]);
  });

  it("throws when target file is missing", () => {
    expect(() => loadTarget("nonexistent", tmp)).toThrow(/No deploy\/targets\/nonexistent\.yml/);
  });

  it("findTargetPath walks up from a nested cwd", () => {
    const path = writeTarget("x", `name: x\nrepos: []\n`);
    const nested = resolve(tmp, "a/b/c");
    mkdirSync(nested, { recursive: true });
    expect(findTargetPath("x", nested)).toBe(path);
  });

  it("throws on malformed YAML", () => {
    writeTarget("bad-yaml", "not: valid: yaml: [");
    expect(() => loadTarget("bad-yaml", tmp)).toThrow();
  });

  it("throws when repos is not an array", () => {
    writeTarget("bad-repos", `name: x\nrepos: "not-an-array"\n`);
    expect(() => loadTarget("bad-repos", tmp)).toThrow(/repos/);
  });
});
