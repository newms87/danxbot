import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, LEVELS, type LogLevel } from "./logger.js";

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
const envBackup = process.env.LOG_LEVEL;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Default to "debug" so all levels output unless overridden
  process.env.LOG_LEVEL = "debug";
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  if (envBackup === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = envBackup;
  }
});

function getLastLogOutput(): Record<string, unknown> | null {
  // Check both console.log and console.error for the last call
  const logCalls = consoleLogSpy.mock.calls;
  const errorCalls = consoleErrorSpy.mock.calls;
  const lastLog = logCalls.length > 0 ? logCalls[logCalls.length - 1] : null;
  const lastError = errorCalls.length > 0 ? errorCalls[errorCalls.length - 1] : null;
  const lastCall = lastError ?? lastLog;
  if (!lastCall) return null;
  return JSON.parse(lastCall[0] as string);
}

describe("createLogger", () => {
  it("outputs valid JSON with required fields", () => {
    const log = createLogger("test-component");
    log.info("hello world");

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = getLastLogOutput();
    expect(output).not.toBeNull();
    expect(output!.timestamp).toBeTypeOf("string");
    expect(output!.level).toBe("info");
    expect(output!.component).toBe("test-component");
    expect(output!.message).toBe("hello world");
  });

  it("outputs ISO 8601 timestamp", () => {
    const log = createLogger("test");
    log.info("check timestamp");

    const output = getLastLogOutput();
    // ISO 8601 format check
    expect(() => new Date(output!.timestamp as string)).not.toThrow();
    expect(new Date(output!.timestamp as string).toISOString()).toBe(output!.timestamp);
  });

  it("tags output with the component name", () => {
    const log = createLogger("my-service");
    log.info("test");

    const output = getLastLogOutput();
    expect(output!.component).toBe("my-service");
  });

  describe("log levels", () => {
    it("outputs debug messages at debug level", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger("test");
      log.debug("debug msg");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      expect(getLastLogOutput()!.level).toBe("debug");
    });

    it("outputs info messages at info level", () => {
      process.env.LOG_LEVEL = "info";
      const log = createLogger("test");
      log.info("info msg");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      expect(getLastLogOutput()!.level).toBe("info");
    });

    it("outputs warn messages at warn level", () => {
      process.env.LOG_LEVEL = "warn";
      const log = createLogger("test");
      log.warn("warn msg");
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(getLastLogOutput()!.level).toBe("warn");
    });

    it("outputs error messages at error level", () => {
      process.env.LOG_LEVEL = "error";
      const log = createLogger("test");
      log.error("error msg");
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(getLastLogOutput()!.level).toBe("error");
    });
  });

  describe("level filtering", () => {
    it("suppresses debug messages at info level", () => {
      process.env.LOG_LEVEL = "info";
      const log = createLogger("test");
      log.debug("should not appear");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("suppresses debug and info messages at warn level", () => {
      process.env.LOG_LEVEL = "warn";
      const log = createLogger("test");
      log.debug("nope");
      log.info("nope");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("suppresses debug, info, and warn messages at error level", () => {
      process.env.LOG_LEVEL = "error";
      const log = createLogger("test");
      log.debug("nope");
      log.info("nope");
      log.warn("nope");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("allows error messages at any level", () => {
      process.env.LOG_LEVEL = "error";
      const log = createLogger("test");
      log.error("always shown");
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });

    it("defaults to info level when LOG_LEVEL is not set", () => {
      delete process.env.LOG_LEVEL;
      const log = createLogger("test");
      log.debug("should not appear");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      log.info("should appear");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });
  });

  describe("error objects", () => {
    it("includes error message and stack when Error is passed", () => {
      const log = createLogger("test");
      const err = new Error("something broke");
      log.error("operation failed", err);

      const output = getLastLogOutput();
      expect(output!.message).toBe("operation failed");
      expect(output!.error).toBe("something broke");
      expect(output!.stack).toBeTypeOf("string");
    });

    it("does not include error fields when no Error is passed", () => {
      const log = createLogger("test");
      log.error("simple error");

      const output = getLastLogOutput();
      expect(output!.message).toBe("simple error");
      expect(output!.error).toBeUndefined();
      expect(output!.stack).toBeUndefined();
    });
  });

  describe("stderr routing", () => {
    it("outputs debug to stdout", () => {
      const log = createLogger("test");
      log.debug("debug msg");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("outputs info to stdout", () => {
      const log = createLogger("test");
      log.info("info msg");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("outputs warn to stderr", () => {
      const log = createLogger("test");
      log.warn("warn msg");
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("outputs error to stderr", () => {
      const log = createLogger("test");
      log.error("error msg");
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("falls back to info level for invalid LOG_LEVEL value", () => {
      process.env.LOG_LEVEL = "banana";
      const log = createLogger("test");
      log.debug("should not appear");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      log.info("should appear");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });

    it("handles case-insensitive LOG_LEVEL", () => {
      process.env.LOG_LEVEL = "DEBUG";
      const log = createLogger("test");
      log.debug("should appear");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });

    it("creates independent loggers with different component names", () => {
      const logA = createLogger("alpha");
      const logB = createLogger("beta");

      logA.info("from alpha");
      logB.info("from beta");

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      const first = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      const second = JSON.parse(consoleLogSpy.mock.calls[1][0] as string);
      expect(first.component).toBe("alpha");
      expect(second.component).toBe("beta");
    });
  });

  describe("non-Error objects passed to error()", () => {
    it("includes String representation for non-Error objects", () => {
      const log = createLogger("test");
      log.error("something failed", "string error value");

      const output = getLastLogOutput();
      expect(output!.message).toBe("something failed");
      expect(output!.error).toBe("string error value");
      expect(output!.stack).toBeUndefined();
    });

    it("includes String representation for number values", () => {
      const log = createLogger("test");
      log.error("number error", 42);

      const output = getLastLogOutput();
      expect(output!.error).toBe("42");
      expect(output!.stack).toBeUndefined();
    });

    it("includes String representation for object values", () => {
      const log = createLogger("test");
      log.error("object error", { code: "ENOENT" });

      const output = getLastLogOutput();
      expect(output!.error).toBe("[object Object]");
      expect(output!.stack).toBeUndefined();
    });
  });

  describe("LEVELS constant", () => {
    it("exports level hierarchy", () => {
      expect(LEVELS.debug).toBeLessThan(LEVELS.info);
      expect(LEVELS.info).toBeLessThan(LEVELS.warn);
      expect(LEVELS.warn).toBeLessThan(LEVELS.error);
    });
  });
});
