import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import IssueCopyButton from "./IssueCopyButton.vue";

vi.mock("../../api", () => ({
  getIssueSubtree: vi.fn(),
}));

import { getIssueSubtree } from "../../api";
const subtreeMock = vi.mocked(getIssueSubtree);

function installClipboardStub(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

describe("IssueCopyButton", () => {
  beforeEach(() => {
    subtreeMock.mockReset();
  });

  it("renders with the idle drawer-copy data-test", () => {
    const w = mount(IssueCopyButton, {
      props: { repo: "danxbot", issueId: "DX-1" },
    });
    expect(w.find('[data-test="drawer-copy"]').exists()).toBe(true);
  });

  it("fetches the subtree and writes JSON to the clipboard on click", async () => {
    const { writeText } = installClipboardStub();
    subtreeMock.mockResolvedValue({
      schema_version: 1,
      exported_at: "",
      repo: "danxbot",
      root_id: "DX-1",
      issues: [{ id: "DX-1" }, { id: "DX-2" }],
    } as never);
    const w = mount(IssueCopyButton, {
      props: { repo: "danxbot", issueId: "DX-1" },
    });
    await w.find('[data-test="drawer-copy"]').trigger("click");
    await flushPromises();
    expect(subtreeMock).toHaveBeenCalledWith("danxbot", "DX-1");
    expect(writeText).toHaveBeenCalledTimes(1);
    const arg = writeText.mock.calls[0]![0];
    expect(JSON.parse(arg).issues.length).toBe(2);
  });

  it("flips data-test to drawer-copy-success after a successful copy", async () => {
    installClipboardStub();
    subtreeMock.mockResolvedValue({
      schema_version: 1,
      exported_at: "",
      repo: "danxbot",
      root_id: "DX-1",
      issues: [{ id: "DX-1" }],
    } as never);
    const w = mount(IssueCopyButton, {
      props: { repo: "danxbot", issueId: "DX-1" },
    });
    await w.find('[data-test="drawer-copy"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="drawer-copy-success"]').exists()).toBe(true);
  });

});
