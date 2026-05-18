import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { ListsFile } from "../types";

const fakeListsFile: ListsFile = {
  lists: [
    { id: "u-archived", name: "Backlog", type: "archived", order: 0, is_default_for_type: true, color: "#aaaaaa" },
    { id: "u-review", name: "Review", type: "review", order: 1, is_default_for_type: true, color: "#3b82f6" },
    { id: "u-ready", name: "To Do", type: "ready", order: 2, is_default_for_type: true, color: "#22d3ee" },
    { id: "u-ip", name: "In Progress", type: "in_progress", order: 4, is_default_for_type: true, color: "#f59e0b" },
    { id: "u-done", name: "Done", type: "completed", order: 5, is_default_for_type: true, color: "#22c55e" },
    { id: "u-cancel", name: "Cancelled", type: "cancelled", order: 6, is_default_for_type: true, color: "#71717a" },
  ],
  tombstone_ids: [],
};

/** Test seam — replaced per-test via vi.mock so the SUT pulls fixtures, not the network. */
vi.mock("../api", () => ({
  fetchLists: vi.fn(),
}));

/**
 * Stub for `useStream` that captures the topic subscription so each test
 * can manually inject `lists:updated` payloads. Matches the real
 * `UseStreamReturn` surface that `createHydrationBuffer` consumes.
 */
const subscribers = new Map<string, Set<(event: { topic: string; data: unknown }) => void>>();
let mockConnectionState = ref<"connecting" | "connected" | "disconnected">("disconnected");

vi.mock("./useStream", async () => {
  const actual = await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => ({
      connectionState: mockConnectionState,
      subscribe(topic: string, handler: (event: { topic: string; data: unknown }) => void) {
        let set = subscribers.get(topic);
        if (!set) {
          set = new Set();
          subscribers.set(topic, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
      },
      disconnect() {
        subscribers.clear();
      },
    }),
  };
});

/** Push one `lists:updated` SSE event into every subscriber. */
function emitListsUpdated(repoName: string, file: ListsFile): void {
  const subs = subscribers.get("lists:updated");
  if (!subs) return;
  for (const handler of [...subs]) handler({ topic: "lists:updated", data: { repoName, file } });
}

async function flushHydration(): Promise<void> {
  // The composable's init() fires a void hydrate(); resolve the microtask
  // queue twice — once for the fetch microtask, once for the buffer's
  // queue-drain microtask — so reactive state has settled before assertions.
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe("useListColors", () => {
  beforeEach(async () => {
    subscribers.clear();
    mockConnectionState = ref("disconnected");
    vi.resetModules();
    const apiMod = await import("../api");
    (apiMod.fetchLists as ReturnType<typeof vi.fn>).mockResolvedValue(fakeListsFile);
  });

  afterEach(() => {
    subscribers.clear();
  });

  it("initial fetch populates lists and colorFor()", async () => {
    const { useListColors } = await import("./useListColors");
    const { lists, colorFor, init, destroy } = useListColors("danxbot");
    init();
    await flushHydration();

    expect(lists.value.length).toBe(6);
    expect(colorFor("Review")).toBe("#3b82f6");
    expect(colorFor("Done")).toBe("#22c55e");
    destroy();
  });

  it("unknown list name returns the neutral fallback color", async () => {
    const { useListColors, NEUTRAL_LIST_COLOR } = await import("./useListColors");
    const { colorFor, init, destroy } = useListColors("danxbot");
    init();
    await flushHydration();

    expect(colorFor("Triage")).toBe(NEUTRAL_LIST_COLOR);
    expect(colorFor("")).toBe(NEUTRAL_LIST_COLOR);
    destroy();
  });

  it("SSE lists:updated for this repo updates colorFor() without a refetch", async () => {
    const { useListColors } = await import("./useListColors");
    const { lists, colorFor, init, destroy } = useListColors("danxbot");
    init();
    await flushHydration();
    expect(colorFor("Review")).toBe("#3b82f6");

    const recolored: ListsFile = {
      ...fakeListsFile,
      lists: fakeListsFile.lists.map((l) =>
        l.name === "Review" ? { ...l, color: "#abcdef" } : l,
      ),
    };
    emitListsUpdated("danxbot", recolored);
    await nextTick();

    expect(colorFor("Review")).toBe("#abcdef");
    expect(lists.value.find((l) => l.name === "Review")?.color).toBe("#abcdef");
    destroy();
  });

  it("SSE lists:updated for a different repo is ignored", async () => {
    const { useListColors } = await import("./useListColors");
    const { colorFor, init, destroy } = useListColors("danxbot");
    init();
    await flushHydration();

    const otherRepoUpdate: ListsFile = {
      ...fakeListsFile,
      lists: fakeListsFile.lists.map((l) =>
        l.name === "Review" ? { ...l, color: "#000000" } : l,
      ),
    };
    emitListsUpdated("platform", otherRepoUpdate);
    await nextTick();

    expect(colorFor("Review")).toBe("#3b82f6");
    destroy();
  });

  it("refresh() re-fetches and replaces the cache", async () => {
    const { useListColors } = await import("./useListColors");
    const apiMod = await import("../api");
    const fetchMock = apiMod.fetchLists as ReturnType<typeof vi.fn>;

    const { colorFor, refresh, init, destroy } = useListColors("danxbot");
    init();
    await flushHydration();
    expect(colorFor("Review")).toBe("#3b82f6");

    const next: ListsFile = {
      ...fakeListsFile,
      lists: fakeListsFile.lists.map((l) =>
        l.name === "Review" ? { ...l, color: "#deadbe" } : l,
      ),
    };
    fetchMock.mockResolvedValueOnce(next);
    await refresh();

    expect(colorFor("Review")).toBe("#deadbe");
    destroy();
  });

  it("does not call setInterval (no polling — SSE only)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "useListColors.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
  });
});
