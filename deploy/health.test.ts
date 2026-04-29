import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForHealthy } from "./health.js";
import { setDryRun } from "./exec.js";

describe("waitForHealthy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns healthy on first 200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await waitForHealthy("https://test.example.com", 3, 10);

    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.error).toBeNull();
  });

  it("retries on failure and returns unhealthy after max attempts", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await waitForHealthy("https://test.example.com", 3, 10);

    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.attempts).toBe(3);
    expect(result.error).toContain("failed after 3 attempts");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on non-200 status then succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const result = await waitForHealthy("https://test.example.com", 5, 10);

    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("handles fetch abort gracefully", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await waitForHealthy("https://test.example.com", 2, 10);

    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it("appends /health to the base url", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    await waitForHealthy("https://example.com", 1, 10);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/health",
      expect.any(Object),
    );
  });

  it("returns synthetic healthy without polling in dry-run", async () => {
    // The placeholder URL passed in dry-run (`https://<DOMAIN>`) would never
    // resolve. Without short-circuiting we'd waste maxAttempts * intervalMs
    // on DNS failures and then mark the deploy as unhealthy — exactly the
    // outcome dry-run is supposed to skip.
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    setDryRun(true);
    try {
      const result = await waitForHealthy("https://<DOMAIN>", 30, 5000);
      expect(result.healthy).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attempts).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      setDryRun(false);
    }
  });
});
