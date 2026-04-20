/**
 * Password input helpers shared by the worker CLI and the deploy CLI helper.
 *
 * Three sources, in fixed precedence:
 *   1. `DANXBOT_CREATE_USER_PASSWORD` env var (CI / scripted invocation)
 *   2. TTY: prompt with echo OFF (interactive operator)
 *   3. Non-TTY stdin: first line read and returned (deploy CLI pipes it in)
 *
 * Trailing CR is stripped from stdin lines (Windows line endings); LF was
 * already consumed by readline. Leading whitespace is preserved — passwords
 * with leading spaces are uncommon but legal, while line-end whitespace from
 * shells/SSH is always noise.
 *
 * Empty stdin is a hard error (`No password received on stdin (EOF before
 * first line)`). Per the project's fail-loud rule, never silently fall
 * through to a "" password that then trips PASSWORD_MIN_LEN — the operator
 * needs to see WHY their pipe was empty.
 */

import { createInterface } from "node:readline";

export const PASSWORD_ENV_VAR = "DANXBOT_CREATE_USER_PASSWORD";

export async function resolvePassword(
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream,
): Promise<string> {
  const envPw = env[PASSWORD_ENV_VAR];
  if (typeof envPw === "string" && envPw.length > 0) return envPw;

  const isTTY = (stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY;
  if (isTTY) return readPasswordEchoOff(stdin, stderr);
  return readFirstLine(stdin);
}

/**
 * Read one newline-terminated line from a non-TTY stream. Rejects if the
 * stream closes before any line arrives — better to fail loudly than to
 * resolve "" and let downstream validation report a misleading "too short"
 * error for what is actually a broken-pipe / missing-heredoc bug.
 */
export function readFirstLine(
  stdin: NodeJS.ReadableStream,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdin });
    let lineSeen = false;
    rl.once("line", (line) => {
      lineSeen = true;
      rl.close();
      resolve(line.replace(/\r$/, ""));
    });
    rl.once("close", () => {
      if (!lineSeen) {
        reject(
          new Error("No password received on stdin (EOF before first line)"),
        );
      }
    });
    rl.once("error", reject);
  });
}

/**
 * TTY-only echo-off prompt. We can't import a third-party prompt lib — the
 * dashboard image is intentionally minimal — so we toggle `setRawMode` on
 * the input TTY and read byte-by-byte until newline. Mirrors the technique
 * used by `gh auth login` and `npm login`.
 *
 * Single-shot by design: a validation failure (too-short password) requires
 * re-invoking the command, matching the UX of `psql`, `mysql`, and
 * `gh auth login`. The cost of re-invocation is small; an in-process retry
 * loop would complicate the cancellation contract for a marginal gain.
 */
export function readPasswordEchoOff(
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tty = stdin as NodeJS.ReadStream & {
      setRawMode?: (mode: boolean) => void;
    };
    if (typeof tty.setRawMode !== "function") {
      reject(new Error("stdin is a TTY but setRawMode is unavailable"));
      return;
    }
    stderr.write("Password: ");
    tty.setRawMode(true);
    tty.resume();
    tty.setEncoding("utf8");

    let buf = "";
    const finish = (action: "resolve" | "reject"): void => {
      tty.setRawMode!(false);
      tty.removeListener("data", onData);
      stderr.write("\n");
      if (action === "resolve") resolve(buf);
      else reject(new Error("Cancelled"));
    };

    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          finish("resolve");
          return;
        }
        if (ch === "\u0003") {
          finish("reject");
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    tty.on("data", onData);
  });
}
