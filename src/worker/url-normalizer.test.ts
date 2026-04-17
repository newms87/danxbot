import { describe, it, expect } from "vitest";
import { normalizeCallbackUrl } from "./url-normalizer.js";

describe("normalizeCallbackUrl", () => {
  describe("docker runtime (isHost=false)", () => {
    it("rewrites localhost hostname to host.docker.internal (default http port elided)", () => {
      // URL normalization drops the default :80 on the http scheme; both forms
      // are semantically identical and fetch() treats them the same.
      expect(
        normalizeCallbackUrl("http://localhost:80/api/agent-dispatch/1", false),
      ).toBe("http://host.docker.internal/api/agent-dispatch/1");
    });

    it("rewrites 127.0.0.1 to host.docker.internal", () => {
      expect(normalizeCallbackUrl("http://127.0.0.1:8080/status", false)).toBe(
        "http://host.docker.internal:8080/status",
      );
    });

    it("rewrites IPv6 loopback [::1] to host.docker.internal", () => {
      expect(normalizeCallbackUrl("http://[::1]:8080/status", false)).toBe(
        "http://host.docker.internal:8080/status",
      );
    });

    it("rewrites uppercase LOCALHOST (URL lowercases hostnames)", () => {
      expect(normalizeCallbackUrl("http://LOCALHOST/status", false)).toBe(
        "http://host.docker.internal/status",
      );
    });

    it("preserves user-info credentials when rewriting", () => {
      expect(
        normalizeCallbackUrl("http://user:pw@localhost/secure", false),
      ).toBe("http://user:pw@host.docker.internal/secure");
    });

    it("preserves the path and query string verbatim", () => {
      expect(
        normalizeCallbackUrl(
          "http://localhost/api/agent-dispatch/abc?trace=1",
          false,
        ),
      ).toBe("http://host.docker.internal/api/agent-dispatch/abc?trace=1");
    });

    it("preserves https scheme and explicit port", () => {
      expect(normalizeCallbackUrl("https://localhost:8443/secure", false)).toBe(
        "https://host.docker.internal:8443/secure",
      );
    });

    it("strips trailing slash from origin-only URLs to prevent double-slash when paths are concatenated", () => {
      // MCP server builds URLs as `${API_URL}/api/path`. If API_URL ends with
      // a slash, the result is `http://host.docker.internal//api/path` → 404.
      expect(normalizeCallbackUrl("http://localhost:80", false)).toBe(
        "http://host.docker.internal",
      );
    });

    it("leaves non-loopback hostnames untouched", () => {
      expect(
        normalizeCallbackUrl("http://gpt-manager-laravel.test-1:80/api", false),
      ).toBe("http://gpt-manager-laravel.test-1:80/api");
    });

    it("does not rewrite a hostname that merely contains 'localhost' as a substring", () => {
      // Guard against naive string-replace regressions.
      expect(
        normalizeCallbackUrl("http://mylocalhost.example.com/api", false),
      ).toBe("http://mylocalhost.example.com/api");
    });
  });

  describe("host runtime (isHost=true)", () => {
    it("leaves localhost URLs untouched so the host can reach its own services", () => {
      expect(
        normalizeCallbackUrl("http://localhost:80/api/agent-dispatch/1", true),
      ).toBe("http://localhost:80/api/agent-dispatch/1");
    });

    it("leaves 127.0.0.1 untouched", () => {
      expect(normalizeCallbackUrl("http://127.0.0.1:8080/status", true)).toBe(
        "http://127.0.0.1:8080/status",
      );
    });
  });

  describe("edge cases", () => {
    it("returns undefined when the input is undefined", () => {
      expect(normalizeCallbackUrl(undefined, false)).toBeUndefined();
      expect(normalizeCallbackUrl(undefined, true)).toBeUndefined();
    });

    it("throws on an unparseable URL so bad dispatch payloads fail loudly", () => {
      expect(() => normalizeCallbackUrl("not a url", false)).toThrow();
    });
  });
});
