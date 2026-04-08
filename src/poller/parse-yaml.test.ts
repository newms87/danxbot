import { describe, it, expect } from "vitest";
import { parseSimpleYaml } from "./parse-yaml.js";

describe("parseSimpleYaml", () => {
  it("parses flat key-value pairs", () => {
    const result = parseSimpleYaml("name: test-repo\nurl: https://example.com");
    expect(result).toEqual({
      name: "test-repo",
      url: "https://example.com",
    });
  });

  it("parses nested sections with dot notation", () => {
    const yaml = `name: test
commands:
  test: "npm test"
  lint: "eslint ."
`;
    const result = parseSimpleYaml(yaml);
    expect(result["name"]).toBe("test");
    expect(result["commands.test"]).toBe("npm test");
    expect(result["commands.lint"]).toBe("eslint .");
  });

  it("trims values", () => {
    const result = parseSimpleYaml("name:   test-repo   ");
    expect(result["name"]).toBe("test-repo");
  });

  it("skips comments and empty lines", () => {
    const yaml = `# Comment
name: test

# Another comment
url: https://example.com
`;
    const result = parseSimpleYaml(yaml);
    expect(result).toEqual({
      name: "test",
      url: "https://example.com",
    });
  });

  it("handles quoted values", () => {
    const result = parseSimpleYaml('name: "my repo"');
    expect(result["name"]).toBe("my repo");
  });

  it("resets section when a top-level key follows a section", () => {
    const yaml = `commands:
  test: "npm test"
name: top-level
`;
    const result = parseSimpleYaml(yaml);
    expect(result["commands.test"]).toBe("npm test");
    expect(result["name"]).toBe("top-level");
  });

  it("handles empty quoted values", () => {
    const result = parseSimpleYaml('lint: ""');
    expect(result["lint"]).toBe("");
  });

  it("handles multiple nested sections in sequence", () => {
    const yaml = `commands:
  test: "npm test"
  lint: "eslint ."
paths:
  source: "src/"
  tests: "tests/"
`;
    const result = parseSimpleYaml(yaml);
    expect(result["commands.test"]).toBe("npm test");
    expect(result["commands.lint"]).toBe("eslint .");
    expect(result["paths.source"]).toBe("src/");
    expect(result["paths.tests"]).toBe("tests/");
  });

  it("returns empty object for empty input", () => {
    expect(parseSimpleYaml("")).toEqual({});
  });

  it("skips malformed lines", () => {
    const yaml = `name: valid
this has no colon
  # indented comment
url: also-valid
`;
    const result = parseSimpleYaml(yaml);
    expect(Object.keys(result)).toEqual(["name", "url"]);
    expect(result["name"]).toBe("valid");
    expect(result["url"]).toBe("also-valid");
  });
});
