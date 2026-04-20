import { Readable, Writable } from "node:stream";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockUpsert, mockClosePool } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockClosePool: vi.fn(),
}));

vi.mock("../dashboard/auth-db.js", () => ({
  upsertDashboardUser: mockUpsert,
}));

vi.mock("../db/connection.js", () => ({
  closePool: mockClosePool,
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { parseArgs, runCli } from "./create-user.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({ userId: 42, rawToken: "the-raw-token" });
  mockClosePool.mockResolvedValue(undefined);
});

function makeStdout(): { stream: Writable; output(): string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, output: () => buf };
}

function makeStdin(text: string, isTTY = false): NodeJS.ReadableStream {
  const stream = Readable.from([text]) as Readable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return stream as NodeJS.ReadableStream;
}

describe("parseArgs", () => {
  it("parses --username", () => {
    expect(parseArgs(["--username", "alice"])).toEqual({ username: "alice" });
  });

  it("parses --username=alice (= form)", () => {
    expect(parseArgs(["--username=alice"])).toEqual({ username: "alice" });
  });

  it("throws when --username is missing", () => {
    expect(() => parseArgs([])).toThrow(/--username/);
  });

  it("throws when --username has no value", () => {
    expect(() => parseArgs(["--username"])).toThrow(/--username/);
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--password", "x"])).toThrow(/Unknown/i);
  });
});

describe("runCli", () => {
  it("happy path: validates, calls upsertDashboardUser, prints token banner once, closes pool", async () => {
    const stdin = makeStdin("a-strong-password\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "alice"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).toBe(0);
    expect(mockUpsert).toHaveBeenCalledWith("alice", "a-strong-password");
    const out = stdout.output();
    expect(out).toContain('Created/updated user "alice"');
    expect(out).toContain("API token (shown once, copy now): the-raw-token");
    expect(out.match(/the-raw-token/g)?.length).toBe(1);
    expect(mockClosePool).toHaveBeenCalledOnce();
  });

  it("uses env-var password when set, never reads stdin", async () => {
    const stdin = makeStdin("should-not-be-read\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "alice"],
      { DANXBOT_CREATE_USER_PASSWORD: "env-password-1234" },
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).toBe(0);
    expect(mockUpsert).toHaveBeenCalledWith("alice", "env-password-1234");
  });

  it("rotate-on-rerun: invoking the CLI twice for the same username calls upsert twice with both passwords", async () => {
    // Each call returns a fresh raw token — rotate-on-issuance is enforced by
    // upsertDashboardUser (covered in src/dashboard/auth-db.test.ts). Here we
    // verify the CLI surface re-prints a fresh banner per invocation.
    mockUpsert
      .mockResolvedValueOnce({ userId: 42, rawToken: "token-A" })
      .mockResolvedValueOnce({ userId: 42, rawToken: "token-B" });

    const stdoutA = makeStdout();
    const stdoutB = makeStdout();
    const stderrA = makeStdout();
    const stderrB = makeStdout();

    await runCli(
      ["--username", "alice"],
      { DANXBOT_CREATE_USER_PASSWORD: "first-password-12" },
      makeStdin("", false),
      stdoutA.stream,
      stderrA.stream,
    );
    await runCli(
      ["--username", "alice"],
      { DANXBOT_CREATE_USER_PASSWORD: "second-password-12" },
      makeStdin("", false),
      stdoutB.stream,
      stderrB.stream,
    );

    expect(mockUpsert).toHaveBeenNthCalledWith(1, "alice", "first-password-12");
    expect(mockUpsert).toHaveBeenNthCalledWith(2, "alice", "second-password-12");
    expect(stdoutA.output()).toContain("token-A");
    expect(stdoutA.output()).not.toContain("token-B");
    expect(stdoutB.output()).toContain("token-B");
    expect(stdoutB.output()).not.toContain("token-A");
    expect(mockClosePool).toHaveBeenCalledTimes(2);
  });

  it("returns non-zero with a clear error on bad username (no upsert, pool closed)", async () => {
    const stdin = makeStdin("a-strong-password\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "ab"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).not.toBe(0);
    expect(stderr.output()).toMatch(/3-64/);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockClosePool).toHaveBeenCalledOnce();
  });

  it("returns non-zero with a clear error on bad password (<12, no upsert)", async () => {
    const stdin = makeStdin("short\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "alice"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).not.toBe(0);
    expect(stderr.output()).toMatch(/12/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns non-zero on missing --username and prints usage to stderr", async () => {
    const stdin = makeStdin("", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli([], {}, stdin, stdout.stream, stderr.stream);

    expect(code).not.toBe(0);
    expect(stderr.output()).toMatch(/--username/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns non-zero with the underlying message when stdin is empty and env is unset", async () => {
    const stdin = makeStdin("", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "alice"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).not.toBe(0);
    expect(stderr.output()).toMatch(/No password received on stdin/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns non-zero when DB error bubbles, never prints a token, closes pool", async () => {
    mockUpsert.mockRejectedValueOnce(new Error("ER_DUP_ENTRY: something"));
    const stdin = makeStdin("a-strong-password\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "alice"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).not.toBe(0);
    expect(stdout.output()).not.toContain("token");
    expect(stderr.output()).toMatch(/ER_DUP_ENTRY/);
    expect(mockClosePool).toHaveBeenCalledOnce();
  });

  it("never accepts password as a CLI argument (--password is not a known flag)", async () => {
    const stdin = makeStdin("a-strong-password\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    const code = await runCli(
      ["--username", "alice", "--password", "from-cli-arg"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(code).not.toBe(0);
    expect(stderr.output()).toMatch(/Unknown/i);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("never logs the password (not in stdout, not in stderr) on success", async () => {
    const stdin = makeStdin("a-strong-password\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    await runCli(
      ["--username", "alice"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(stdout.output()).not.toContain("a-strong-password");
    expect(stderr.output()).not.toContain("a-strong-password");
  });

  it("never logs the password on failure (DB error)", async () => {
    mockUpsert.mockRejectedValueOnce(new Error("ER_DUP_ENTRY"));
    const stdin = makeStdin("a-strong-password\n", false);
    const stdout = makeStdout();
    const stderr = makeStdout();

    await runCli(
      ["--username", "alice"],
      {},
      stdin,
      stdout.stream,
      stderr.stream,
    );

    expect(stdout.output()).not.toContain("a-strong-password");
    expect(stderr.output()).not.toContain("a-strong-password");
  });
});
