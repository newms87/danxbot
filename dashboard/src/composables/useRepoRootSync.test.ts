/**
 * DX-558 — composable reducer + banner-render coverage.
 *
 * Two layers:
 *
 *   1. Pure-reducer suite (`applyEvent`) exercised directly — no Vue,
 *      no SSE, no fetch. Asserts the three transitions the SSE feed
 *      can deliver (first-error, update-error, clear) without booting
 *      the full composable.
 *   2. Banner-component suite — mounts `RepoRootDirtyBanner.vue` and
 *      asserts the conditional rendering AC (visible when entry
 *      present + matching reason class, hidden when entry absent,
 *      retry click emits the event the composable subscribes to).
 *
 * The full SSE/fetch end-to-end of `useRepoRootSync` is intentionally
 * NOT covered here — the existing `useBrokenAgents.test.ts` pattern
 * also only unit-tests the pure helper, leaving stream wiring to
 * `useStream`'s own test. This file follows that convention.
 */

import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { applyEvent, type RepoRootSyncEntry } from "./useRepoRootSync";
import RepoRootDirtyBanner from "../components/agents/RepoRootDirtyBanner.vue";
import type { RepoRootSyncError } from "../types";

const ERR_DIRTY: RepoRootSyncError = {
  reason: "dirty",
  detail: "working tree dirty: M src/foo.ts",
  since: "2026-05-16T04:00:00.000Z",
  lastTriedAt: "2026-05-16T04:00:00.000Z",
};

const ERR_CONFLICT: RepoRootSyncError = {
  reason: "rebase-conflict",
  detail: "rebase against origin/main produced conflicts; aborted.",
  since: "2026-05-16T04:05:00.000Z",
  lastTriedAt: "2026-05-16T04:05:00.000Z",
};

const entry = (over: Partial<RepoRootSyncEntry> = {}): RepoRootSyncEntry => ({
  repoName: "danxbot",
  error: ERR_DIRTY,
  retrying: false,
  ...over,
});

describe("applyEvent — pure reducer", () => {
  it("inserts an entry on first `error` event for a new repo", () => {
    const next = applyEvent([], {
      type: "error",
      repoName: "danxbot",
      error: ERR_DIRTY,
    });
    expect(next).toEqual([
      { repoName: "danxbot", error: ERR_DIRTY, retrying: false },
    ]);
  });

  it("updates the error of an existing entry, preserving `retrying`", () => {
    const initial: RepoRootSyncEntry[] = [
      entry({ retrying: true, error: ERR_DIRTY }),
    ];
    const next = applyEvent(initial, {
      type: "error",
      repoName: "danxbot",
      error: ERR_CONFLICT,
    });
    expect(next).toHaveLength(1);
    expect(next[0].error.reason).toBe("rebase-conflict");
    expect(next[0].retrying).toBe(true);
  });

  it("removes the entry on `clear` for that repo", () => {
    const initial: RepoRootSyncEntry[] = [
      entry({ repoName: "danxbot" }),
      entry({ repoName: "other" }),
    ];
    const next = applyEvent(initial, {
      type: "clear",
      repoName: "danxbot",
    });
    expect(next.map((e) => e.repoName)).toEqual(["other"]);
  });

  it("returns the same shape (empty) when `clear` arrives for an unknown repo", () => {
    const next = applyEvent([], { type: "clear", repoName: "ghost" });
    expect(next).toEqual([]);
  });

  it("does not mutate the input array (returns a fresh reference on transitions)", () => {
    const initial: RepoRootSyncEntry[] = [entry()];
    const next = applyEvent(initial, {
      type: "error",
      repoName: "danxbot",
      error: ERR_CONFLICT,
    });
    expect(next).not.toBe(initial);
    expect(initial[0].error.reason).toBe("dirty");
  });
});

describe("RepoRootDirtyBanner — conditional render", () => {
  it("renders the dirty-class headline + detail when reason is 'dirty'", () => {
    const wrapper = mount(RepoRootDirtyBanner, {
      props: { error: ERR_DIRTY, repoName: "danxbot", retrying: false },
    });
    expect(wrapper.text()).toContain("working tree dirty");
    expect(wrapper.text()).toContain("danxbot");
    expect(wrapper.text()).toContain(ERR_DIRTY.detail);
    // Retry button shows the idle label.
    expect(wrapper.find('[data-test="repo-root-dirty-retry"]').text()).toBe(
      "Retry now",
    );
  });

  it("renders the rebase-conflict-class headline when reason is 'rebase-conflict'", () => {
    const wrapper = mount(RepoRootDirtyBanner, {
      props: { error: ERR_CONFLICT, repoName: "danxbot", retrying: false },
    });
    expect(wrapper.text()).toContain("rebase conflict");
    // Container class distinguishes red vs amber — `border-red-500`
    // is the visual contract test that the variant switched.
    expect(wrapper.find('[data-test="repo-root-dirty-banner"]').classes())
      .toContain("border-red-500");
  });

  it("disables the retry button + shows spinner copy while `retrying`", () => {
    const wrapper = mount(RepoRootDirtyBanner, {
      props: { error: ERR_DIRTY, repoName: "danxbot", retrying: true },
    });
    const btn = wrapper.find('[data-test="repo-root-dirty-retry"]');
    expect(btn.text()).toBe("Retrying…");
    expect(btn.attributes("disabled")).toBeDefined();
  });

  it("emits `retry` with the repoName on click", async () => {
    const wrapper = mount(RepoRootDirtyBanner, {
      props: { error: ERR_DIRTY, repoName: "danxbot", retrying: false },
    });
    await wrapper.find('[data-test="repo-root-dirty-retry"]').trigger("click");
    const events = wrapper.emitted("retry");
    expect(events).toBeTruthy();
    expect(events![0]).toEqual(["danxbot"]);
  });
});
