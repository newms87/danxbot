import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAuth } from "../composables/useAuth";
import {
  jsonRequest,
  labelRequest,
  listsRequest,
  readJsonError,
  readListsError,
  toggleError,
  type ToggleError,
} from "./_request";

const TOKEN_KEY = "danxbot.authToken";

function seedToken(raw: string | null): void {
  if (raw) sessionStorage.setItem(TOKEN_KEY, raw);
  else sessionStorage.removeItem(TOKEN_KEY);
  const auth = useAuth();
  (auth.token as { value: string | null }).value = raw;
}

beforeEach(() => {
  sessionStorage.clear();
  seedToken("ok");
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("jsonRequest", () => {
  it("GET without a body sends no Content-Type and parses JSON response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await jsonRequest<{ value: number }>("GET", "/api/x");

    expect(result).toEqual({ value: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).body).toBeUndefined();
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("POST with body serializes JSON and sets Content-Type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await jsonRequest<{ ok: boolean }>("POST", "/api/x", { a: 1 });

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ a: 1 }));
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("throws ToggleError carrying the server's error string on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    );

    await expect(jsonRequest("POST", "/api/x", {})).rejects.toMatchObject({
      status: 400,
      serverMessage: "bad request",
    });
  });

  it("returns undefined for 204 No Content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 204 }),
    );

    const result = await jsonRequest<void>("DELETE", "/api/x");
    expect(result).toBeUndefined();
  });

  it("falls back to the generic ToggleError message when the 4xx body is malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json {", { status: 500 }),
    );

    await expect(jsonRequest("POST", "/api/x", {})).rejects.toMatchObject({
      status: 500,
      serverMessage: undefined,
      message: "patchToggle failed: 500",
    });
  });
});

describe("labelRequest", () => {
  it("throws a plain Error with `<label> failed: <status>` on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );

    await expect(
      labelRequest("fetchThing", "GET", "/api/thing"),
    ).rejects.toThrow("fetchThing failed: 500");
  });

  it("returns parsed JSON on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await labelRequest<number[]>(
      "fetchThing",
      "GET",
      "/api/thing",
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns undefined for 204 No Content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 204 }),
    );

    const result = await labelRequest<void>(
      "deleteThing",
      "DELETE",
      "/api/thing",
    );
    expect(result).toBeUndefined();
  });
});

describe("listsRequest", () => {
  it("joins the `errors: []` array into the ToggleError message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ errors: ["name must be non-empty", "color invalid"] }),
        { status: 400 },
      ),
    );

    await expect(listsRequest("POST", "/api/lists", {})).rejects.toMatchObject({
      status: 400,
      serverMessage: "name must be non-empty; color invalid",
    });
  });

  it("returns the parsed body on 2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ file: { lists: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await listsRequest<{ file: { lists: unknown[] } }>(
      "GET",
      "/api/lists?repo=x",
    );
    expect(result).toEqual({ file: { lists: [] } });
  });

  it("falls back to the generic message when the 4xx body is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json", { status: 500 }),
    );

    await expect(listsRequest("POST", "/api/lists", {})).rejects.toMatchObject({
      status: 500,
      serverMessage: undefined,
      message: "patchToggle failed: 500",
    });
  });
});

describe("readJsonError / readListsError / toggleError", () => {
  it("readJsonError returns body.error when present", async () => {
    const res = new Response(JSON.stringify({ error: "nope" }), { status: 400 });
    expect(await readJsonError(res)).toBe("nope");
  });

  it("readJsonError returns undefined on malformed JSON", async () => {
    const res = new Response("not json", { status: 400 });
    expect(await readJsonError(res)).toBeUndefined();
  });

  it("readListsError joins body.errors[] strings", async () => {
    const res = new Response(JSON.stringify({ errors: ["a", "b"] }), {
      status: 400,
    });
    expect(await readListsError(res)).toBe("a; b");
  });

  it("readListsError filters non-string entries from errors[] and joins the rest", async () => {
    const res = new Response(
      JSON.stringify({ errors: [1, null, "x", { obj: 1 }, "y"] }),
      { status: 400 },
    );
    expect(await readListsError(res)).toBe("x; y");
  });

  it("readListsError falls back to body.error when errors[] absent", async () => {
    const res = new Response(JSON.stringify({ error: "fallback" }), {
      status: 400,
    });
    expect(await readListsError(res)).toBe("fallback");
  });

  it("toggleError populates status + serverMessage", () => {
    const err: ToggleError = toggleError(409, "duplicate");
    expect(err.status).toBe(409);
    expect(err.serverMessage).toBe("duplicate");
    expect(err.message).toBe("duplicate");
  });

  it("toggleError uses a fallback message when serverMessage absent", () => {
    const err = toggleError(500);
    expect(err.message).toBe("patchToggle failed: 500");
  });
});
