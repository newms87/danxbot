import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, it, expect } from "vitest";
import {
  PASSWORD_ENV_VAR,
  readFirstLine,
  readPasswordEchoOff,
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

interface FakeTty extends EventEmitter {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
  setEncoding: (enc: string) => void;
  rawModeCalls: boolean[];
  resumeCalls: number;
  pauseCalls: number;
}

function makeFakeTty(): FakeTty {
  const ee = new EventEmitter() as FakeTty;
  ee.isTTY = true;
  ee.rawModeCalls = [];
  ee.resumeCalls = 0;
  ee.pauseCalls = 0;
  ee.setRawMode = (mode: boolean) => {
    ee.rawModeCalls.push(mode);
  };
  ee.resume = () => {
    ee.resumeCalls++;
  };
  ee.pause = () => {
    ee.pauseCalls++;
  };
  ee.setEncoding = () => {};
  return ee;
}

describe("readPasswordEchoOff — TTY lifecycle", () => {
  it("pauses stdin after a successful password read so the event loop can exit", async () => {
    const tty = makeFakeTty();
    const stderr = makeWritable();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      stderr.stream,
    );
    // Process event loop tick so the listener attaches.
    await new Promise((r) => setImmediate(r));
    tty.emit("data", "hunter2\n");
    await expect(promise).resolves.toBe("hunter2");
    expect(tty.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("pauses stdin after a cancelled password read (Ctrl-C)", async () => {
    const tty = makeFakeTty();
    const stderr = makeWritable();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      stderr.stream,
    );
    await new Promise((r) => setImmediate(r));
    tty.emit("data", "");
    await expect(promise).rejects.toThrow(/Cancelled/);
    expect(tty.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("removes the data listener after finishing (no leaked listeners)", async () => {
    const tty = makeFakeTty();
    const stderr = makeWritable();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      stderr.stream,
    );
    await new Promise((r) => setImmediate(r));
    expect(tty.listenerCount("data")).toBe(1);
    tty.emit("data", "ok\n");
    await promise;
    expect(tty.listenerCount("data")).toBe(0);
  });

  it("treats CR (\\r) as a terminator the same as LF", async () => {
    const tty = makeFakeTty();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      makeWritable().stream,
    );
    await new Promise((r) => setImmediate(r));
    tty.emit("data", "carriage\r");
    await expect(promise).resolves.toBe("carriage");
    expect(tty.pauseCalls).toBeGreaterThanOrEqual(1);
  });

  it("treats EOT (\\u0004 / Ctrl-D) as a terminator", async () => {
    const tty = makeFakeTty();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      makeWritable().stream,
    );
    await new Promise((r) => setImmediate(r));
    tty.emit("data", "eofpw");
    await expect(promise).resolves.toBe("eofpw");
    expect(tty.pauseCalls).toBeGreaterThanOrEqual(1);
  });

  it("backspace (\\u007f) deletes the last buffered character", async () => {
    const tty = makeFakeTty();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      makeWritable().stream,
    );
    await new Promise((r) => setImmediate(r));
    tty.emit("data", "abcd\n");
    await expect(promise).resolves.toBe("abc");
  });

  it("Ctrl-H (\\b) also deletes the last buffered character", async () => {
    const tty = makeFakeTty();
    const promise = readPasswordEchoOff(
      tty as unknown as NodeJS.ReadableStream,
      makeWritable().stream,
    );
    await new Promise((r) => setImmediate(r));
    tty.emit("data", "abcd\b\n");
    await expect(promise).resolves.toBe("abc");
  });
});
