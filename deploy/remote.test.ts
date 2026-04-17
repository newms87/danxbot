import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { applyTemplateVars, resolveKeyPath } from "./remote.js";
import { makeConfig } from "./test-helpers.js";

describe("applyTemplateVars", () => {
  it("replaces all occurrences of each pattern", () => {
    const template = "image: ${ECR_IMAGE}\nports:\n  - ${PORT}:${PORT}";
    const result = applyTemplateVars(template, {
      "${ECR_IMAGE}": "123.dkr.ecr.us-east-1.amazonaws.com/bot:latest",
      "${PORT}": "5555",
    });

    expect(result).toBe(
      "image: 123.dkr.ecr.us-east-1.amazonaws.com/bot:latest\nports:\n  - 5555:5555",
    );
  });

  it("escapes regex metacharacters in the key (compose default syntax)", () => {
    const result = applyTemplateVars("x=${FOO:-bar}", {
      "${FOO:-bar}": "hello",
    });
    expect(result).toBe("x=hello");
  });

  it("returns unchanged template when no vars match", () => {
    const template = "unchanged content";
    const result = applyTemplateVars(template, {
      "${MISSING}": "replacement",
    });

    expect(result).toBe("unchanged content");
  });

  it("substitutes multi-line content", () => {
    const result = applyTemplateVars(
      "line1: ${A}\nline2: ${B}\nline3: ${A}",
      { "${A}": "one", "${B}": "two" },
    );
    expect(result).toBe("line1: one\nline2: two\nline3: one");
  });
});

describe("resolveKeyPath", () => {
  it("returns user-provided key path when set", () => {
    const config = makeConfig({
      instance: {
        ...makeConfig().instance,
        sshKey: "/path/to/my-key.pem",
      },
    });
    expect(resolveKeyPath(config)).toBe("/path/to/my-key.pem");
  });

  it("generates ~/.ssh/<name>-key.pem when sshKey is empty", () => {
    const home = process.env.HOME;
    if (!home) throw new Error("test precondition: HOME must be set");
    const config = makeConfig({ name: "danxbot-production" });
    const path = resolveKeyPath(config);
    expect(path).toBe(resolve(home, ".ssh", "danxbot-production-key.pem"));
  });

  it("throws when HOME is unset and sshKey is empty (no silent ~ literal)", () => {
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      const config = makeConfig({ name: "test-bot" });
      expect(() => resolveKeyPath(config)).toThrow(
        "HOME environment variable is not set",
      );
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
    }
  });
});
