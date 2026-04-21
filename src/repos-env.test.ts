import { describe, expect, it } from "vitest";
import { parseReposEnv } from "./repos-env.js";

describe("parseReposEnv", () => {
  it("parses a normal REPOS string into name/url entries", () => {
    expect(
      parseReposEnv(
        "danxbot:https://x.git,gpt-manager:https://y.git,platform:z",
      ),
    ).toEqual([
      { name: "danxbot", url: "https://x.git" },
      { name: "gpt-manager", url: "https://y.git" },
      { name: "platform", url: "z" },
    ]);
  });

  it("trims whitespace inside each entry", () => {
    expect(parseReposEnv("  foo : url1 , bar:url2  ")).toEqual([
      { name: "foo", url: "url1" },
      { name: "bar", url: "url2" },
    ]);
  });

  it("skips empty entries (trailing/internal commas) without throwing", () => {
    expect(parseReposEnv("foo:url, ,bar:url,")).toEqual([
      { name: "foo", url: "url" },
      { name: "bar", url: "url" },
    ]);
  });

  it("returns an empty list when REPOS is blank", () => {
    expect(parseReposEnv("")).toEqual([]);
    expect(parseReposEnv("   ")).toEqual([]);
  });

  it("throws when an entry has no colon", () => {
    expect(() => parseReposEnv("no-colon-here")).toThrow(/expected "name:url"/);
  });

  it("throws when the name is empty", () => {
    expect(() => parseReposEnv(":https://x")).toThrow(/expected "name:url"/);
  });

  it("throws when the url is empty", () => {
    expect(() => parseReposEnv("foo:")).toThrow(
      /name and url must not be empty/,
    );
  });
});
