import { Readable, Writable } from "node:stream";
import { describe, it, expect } from "vitest";
import {
  PASSWORD_ENV_VAR,
  readFirstLine,
  resolvePassword,
} from "./tty-password.js";

function makeStdin(text: string, isTTY = false): NodeJS.ReadableStream {
  const stream = Readable.from([text]) as Readable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return stream as NodeJS.ReadableStream;
}

function makeWritable(): { stream: Writable; output(): string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, output: () => buf };
}

describe("PASSWORD_ENV_VAR", () => {
  it("documents the canonical env-var name", () => {
    expect(PASSWORD_ENV_VAR).toBe("DANXBOT_CREATE_USER_PASSWORD");
  });
});

describe("readFirstLine", () => {
  it("returns the first line, stripping trailing CR", async () => {
    await expect(readFirstLine(makeStdin("hello\r\n"))).resolves.toBe("hello");
  });

  it("returns the first line without CR for plain LF input", async () => {
    await expect(readFirstLine(makeStdin("hello\n"))).resolves.toBe("hello");
  });

  it("ignores additional lines after the first", async () => {
    expect(await readFirstLine(makeStdin("first\nsecond\n"))).toBe("first");
  });

  it("rejects (does NOT silently resolve '') when stdin closes with no line", async () => {
    await expect(readFirstLine(makeStdin(""))).rejects.toThrow(
      /No password received on stdin/,
    );
  });

  it("preserves leading whitespace in the password", async () => {
    expect(await readFirstLine(makeStdin("  spaced\n"))).toBe("  spaced");
  });
});

describe("resolvePassword precedence", () => {
  it("returns env var when set and non-empty (does NOT touch stdin)", async () => {
    const stdin = makeStdin("ignored-from-stdin\n", false);
    const stderr = makeWritable();

    const pw = await resolvePassword(
      { [PASSWORD_ENV_VAR]: "envpw1234567" },
      stdin,
      stderr.stream,
    );

    expect(pw).toBe("envpw1234567");
    expect(stderr.output()).toBe("");
  });

  it("falls through to stdin when env is empty string", async () => {
    const stdin = makeStdin("piped-pw-12345\n", false);
    const stderr = makeWritable();

    const pw = await resolvePassword(
      { [PASSWORD_ENV_VAR]: "" },
      stdin,
      stderr.stream,
    );

    expect(pw).toBe("piped-pw-12345");
  });

  it("falls through to stdin when env is unset", async () => {
    const stdin = makeStdin("piped-pw-12345\n", false);
    const stderr = makeWritable();

    const pw = await resolvePassword({}, stdin, stderr.stream);

    expect(pw).toBe("piped-pw-12345");
  });

  it("propagates the readFirstLine reject when non-TTY stdin is empty", async () => {
    const stdin = makeStdin("", false);
    const stderr = makeWritable();

    await expect(resolvePassword({}, stdin, stderr.stream)).rejects.toThrow(
      /No password received on stdin/,
    );
  });

  // The TTY echo-off branch (readPasswordEchoOff) cannot be exercised in a
  // pure unit test without a real PTY (vitest ships happy-dom for the dashboard
  // suite and a node-default stdin for the backend suite — neither can synthesize
  // setRawMode). Live coverage comes from the integration verify in the Phase 3
  // card: `make create-user LOCALHOST=1 USERNAME=foo` interactively. The single
  // testable invariant — that setRawMode-less stdin marked as TTY rejects loudly —
  // is asserted below.
  it("rejects with a clear message when isTTY=true but setRawMode is missing", async () => {
    const stdin = Object.assign(Readable.from([""]), {
      isTTY: true,
    }) as unknown as NodeJS.ReadableStream;
    const stderr = makeWritable();

    await expect(resolvePassword({}, stdin, stderr.stream)).rejects.toThrow(
      /setRawMode is unavailable/,
    );
  });
});
