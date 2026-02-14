import { describe, it, expect, vi, beforeEach } from "vitest";

// Dynamic import after each reset to get fresh module state
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveUserName: (client: any, userId: string) => Promise<string>;
let resetUserCache: () => void;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./user-cache.js");
  resolveUserName = mod.resolveUserName;
  resetUserCache = mod.resetUserCache;
});

describe("resolveUserName", () => {
  it("returns display_name when available from users.info", async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: {
            profile: { display_name: "Jane D", real_name: "Jane Doe" },
            real_name: "Jane Doe",
          },
        }),
      },
    };

    const name = await resolveUserName(client, "U-JANE");
    expect(name).toBe("Jane D");
    expect(client.users.info).toHaveBeenCalledWith({ user: "U-JANE" });
  });

  it("falls back to real_name when display_name is empty", async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: {
            profile: { display_name: "", real_name: "Bob Smith" },
            real_name: "Bob Smith",
          },
        }),
      },
    };

    const name = await resolveUserName(client, "U-BOB");
    expect(name).toBe("Bob Smith");
  });

  it("falls back to userId when users.info fails (API error)", async () => {
    const client = {
      users: {
        info: vi.fn().mockRejectedValue(new Error("user_not_found")),
      },
    };

    const name = await resolveUserName(client, "U-GONE");
    expect(name).toBe("U-GONE");
  });

  it("returns cached value on second call (no additional API call)", async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: {
            profile: { display_name: "Alice", real_name: "Alice W" },
            real_name: "Alice W",
          },
        }),
      },
    };

    const first = await resolveUserName(client, "U-ALICE");
    const second = await resolveUserName(client, "U-ALICE");

    expect(first).toBe("Alice");
    expect(second).toBe("Alice");
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache fallback values (retries on next call after error)", async () => {
    const client = {
      users: {
        info: vi
          .fn()
          .mockRejectedValueOnce(new Error("network_error"))
          .mockResolvedValueOnce({
            ok: true,
            user: {
              profile: { display_name: "Recovered", real_name: "Recovered User" },
              real_name: "Recovered User",
            },
          }),
      },
    };

    const first = await resolveUserName(client, "U-FLAKY");
    expect(first).toBe("U-FLAKY");

    const second = await resolveUserName(client, "U-FLAKY");
    expect(second).toBe("Recovered");
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });

  it("resetUserCache clears the cache", async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: {
            profile: { display_name: "Cached", real_name: "Cached User" },
            real_name: "Cached User",
          },
        }),
      },
    };

    await resolveUserName(client, "U-CACHED");
    expect(client.users.info).toHaveBeenCalledTimes(1);

    resetUserCache();

    await resolveUserName(client, "U-CACHED");
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });

  it("handles missing profile gracefully (returns userId)", async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: {},
        }),
      },
    };

    const name = await resolveUserName(client, "U-NOPROFILE");
    expect(name).toBe("U-NOPROFILE");
  });
});
