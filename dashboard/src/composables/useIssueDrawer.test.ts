import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useIssueDrawer } from "./useIssueDrawer";
import type { Issue, IssueDetail } from "../types";

function makeDetail(over: Partial<IssueDetail> & Pick<IssueDetail, "id">): IssueDetail {
  return {
    id: over.id,
    type: over.type ?? "Feature",
    title: over.title ?? `Title ${over.id}`,
    description: over.description ?? "",
    status: over.status ?? "Review",
    parent_id: over.parent_id ?? null,
    children: over.children ?? [],
    updated_at: over.updated_at ?? 0,
    created_at: over.created_at ?? 0,
    raw_yaml: over.raw_yaml ?? "",
  } as unknown as IssueDetail;
}

describe("useIssueDrawer", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  function setup(detail: IssueDetail = makeDetail({ id: "DX-1" })) {
    const fetchDetail = vi.fn(async (_id: string) => detail);
    const applyIssueUpdate = vi.fn();
    const api = useIssueDrawer({ fetchDetail, applyIssueUpdate });
    return { fetchDetail, applyIssueUpdate, api };
  }

  it("openDrawer fetches detail, populates state, writes URL", async () => {
    const detail = makeDetail({ id: "DX-1", title: "Hello" });
    const { fetchDetail, api } = setup(detail);
    await api.openDrawer("DX-1");
    expect(fetchDetail).toHaveBeenCalledWith("DX-1");
    expect(api.selectedIssueId.value).toBe("DX-1");
    expect(api.selectedDetail.value?.title).toBe("Hello");
    expect(api.detailLoading.value).toBe(false);
    expect(api.detailError.value).toBeNull();
    expect(new URLSearchParams(window.location.search).get("issue")).toBe("DX-1");
  });

  it("openDrawer surfaces fetch error in detailError; detail stays null", async () => {
    const { fetchDetail, api } = setup();
    fetchDetail.mockRejectedValueOnce(new Error("net"));
    await api.openDrawer("DX-2");
    expect(api.detailError.value).toBe("net");
    expect(api.selectedDetail.value).toBeNull();
  });

  it("openDrawer race: late-arriving response for a stale id is ignored", async () => {
    const fetchDetail = vi.fn();
    let resolveFirst: (d: IssueDetail) => void = () => {};
    fetchDetail.mockImplementationOnce(
      () => new Promise<IssueDetail>((r) => { resolveFirst = r; }),
    );
    fetchDetail.mockImplementationOnce(async () => makeDetail({ id: "DX-2", title: "Second" }));
    const applyIssueUpdate = vi.fn();
    const api = useIssueDrawer({ fetchDetail, applyIssueUpdate });
    const p1 = api.openDrawer("DX-1");
    await api.openDrawer("DX-2");
    resolveFirst(makeDetail({ id: "DX-1", title: "First (stale)" }));
    await p1;
    expect(api.selectedIssueId.value).toBe("DX-2");
    expect(api.selectedDetail.value?.title).toBe("Second");
  });

  it("detailLoading flips true while fetchDetail is in-flight", async () => {
    const fetchDetail = vi.fn<(id: string) => Promise<IssueDetail>>();
    let release: (d: IssueDetail) => void = () => {};
    fetchDetail.mockImplementationOnce(
      () => new Promise<IssueDetail>((r) => { release = r; }),
    );
    const applyIssueUpdate = vi.fn();
    const api = useIssueDrawer({ fetchDetail, applyIssueUpdate });
    const p = api.openDrawer("DX-9");
    expect(api.detailLoading.value).toBe(true);
    release(makeDetail({ id: "DX-9" }));
    await p;
    expect(api.detailLoading.value).toBe(false);
  });

  it("race-on-error: late rejection for stale id does NOT clobber newer error/detail", async () => {
    const fetchDetail = vi.fn<(id: string) => Promise<IssueDetail>>();
    let rejectFirst: (e: Error) => void = () => {};
    fetchDetail.mockImplementationOnce(
      () => new Promise<IssueDetail>((_resolve, reject) => { rejectFirst = reject; }),
    );
    fetchDetail.mockImplementationOnce(async () => makeDetail({ id: "DX-2", title: "Second" }));
    const applyIssueUpdate = vi.fn();
    const api = useIssueDrawer({ fetchDetail, applyIssueUpdate });
    const p1 = api.openDrawer("DX-1");
    await api.openDrawer("DX-2");
    rejectFirst(new Error("stale"));
    await p1;
    expect(api.selectedIssueId.value).toBe("DX-2");
    expect(api.detailError.value).toBeNull();
    expect(api.selectedDetail.value?.title).toBe("Second");
  });

  it("closeDrawer resets state + clears URL", async () => {
    const { api } = setup();
    await api.openDrawer("DX-1");
    api.closeDrawer();
    expect(api.selectedIssueId.value).toBeNull();
    expect(api.selectedDetail.value).toBeNull();
    expect(api.detailError.value).toBeNull();
    expect(new URLSearchParams(window.location.search).get("issue")).toBeNull();
  });

  it("mergeIssuePatch overlays fields on the open detail when ids match", async () => {
    const { api } = setup();
    await api.openDrawer("DX-1");
    api.mergeIssuePatch({ id: "DX-1", title: "Patched" } as Issue);
    expect(api.selectedDetail.value?.title).toBe("Patched");
  });

  it("mergeIssuePatch is a no-op when the open detail is a different id", async () => {
    const { api } = setup();
    await api.openDrawer("DX-1");
    api.mergeIssuePatch({ id: "DX-OTHER", title: "X" } as Issue);
    expect(api.selectedDetail.value?.id).toBe("DX-1");
    expect(api.selectedDetail.value?.title).not.toBe("X");
  });

  it("mergeIssueUpdateAndInvalidate invalidates cache + merges + bumps updated_at", async () => {
    const { applyIssueUpdate, api } = setup();
    await api.openDrawer("DX-1");
    const before = api.selectedDetail.value?.updated_at ?? 0;
    api.mergeIssueUpdateAndInvalidate({ id: "DX-1", title: "Renamed" } as Issue);
    expect(applyIssueUpdate).toHaveBeenCalledWith("DX-1");
    expect(api.selectedDetail.value?.title).toBe("Renamed");
    expect(api.selectedDetail.value?.updated_at).toBeGreaterThan(before);
  });

  it("readUrlIssue returns the `issue` query param", () => {
    window.history.replaceState({}, "", "/?issue=DX-42");
    const { api } = setup();
    expect(api.readUrlIssue()).toBe("DX-42");
  });
});
