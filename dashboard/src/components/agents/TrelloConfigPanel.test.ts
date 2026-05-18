import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { AgentSnapshot, Feature } from "../../types";

const mockPatchTrelloCredentials = vi.fn();
vi.mock("../../api", () => ({
  patchTrelloCredentials: (...args: unknown[]) =>
    mockPatchTrelloCredentials(...args),
}));

import TrelloConfigPanel from "./TrelloConfigPanel.vue";

function makeAgent(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: "danxbot",
    repoName: "danxbot",
    url: "https://example.com/danxbot.git",
    settings: {
      overrides: {
        slack: { enabled: null },
        issuePoller: { enabled: null, pickupNamePrefix: null },
        dispatchApi: { enabled: null },
        ideator: { enabled: null },
        autoTriage: { enabled: null },
        trelloSync: { enabled: null },
      },
      display: {
        trello: {
          apiKey: "abcd****1234",
          apiToken: "wxyz****5678",
          boardId: "board-1",
          todoListId: "todo-list-1",
          inProgressListId: "ip-list-1",
          doneListId: "done-list-1",
          configured: true,
        },
        links: {},
      },
      meta: { updatedAt: "2026-05-01T00:00:00Z", updatedBy: "setup" },
    },
    counts: {
      total: { total: 0, slack: 0, trello: 0, api: 0 },
      last24h: { total: 0, slack: 0, trello: 0, api: 0 },
      today: { total: 0, slack: 0, trello: 0, api: 0 },
    },
    worker: { reachable: true, lastSeenMs: Date.now() },
    criticalFailure: null,
    issuePrefix: "DX",
    githubCredentials: {
      registered: false,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error: null,
    },
    ...over,
  };
}

function mountPanel(over: Partial<AgentSnapshot> = {}, busy: Feature | null = null) {
  return mount(TrelloConfigPanel, {
    props: { agent: makeAgent(over), busyFeature: busy },
  });
}

beforeEach(() => {
  mockPatchTrelloCredentials.mockReset();
  vi.unstubAllEnvs();
});

describe("TrelloConfigPanel", () => {
  it("renders the sync toggle, effective line, ID rows, and credential rows", () => {
    const w = mountPanel();
    expect(w.find('[data-test="trello-config-panel"]').exists()).toBe(true);
    // Toggle row (FeatureToggle renders a role=switch with the label)
    expect(w.text()).toContain("Trello sync");
    expect(w.find('[role="switch"]').exists()).toBe(true);
    // Effective line
    expect(w.get('[data-test="trello-effective-line"]').text()).toContain(
      "Effective: true",
    );
    expect(w.get('[data-test="trello-effective-line"]').text()).toContain(
      "env default",
    );
    // Board ID + ToDo list ID
    expect(w.get('[data-test="trello-board-id"]').text()).toBe("board-1");
    expect(w.get('[data-test="trello-todo-list-id"]').text()).toBe(
      "todo-list-1",
    );
    // Masked credential rows
    expect(w.get('[data-test="trello-apiKey-masked"]').text()).toBe(
      "abcd****1234",
    );
    expect(w.get('[data-test="trello-apiToken-masked"]').text()).toBe(
      "wxyz****5678",
    );
  });

  it("shows 'override' source when overrides.trelloSync.enabled is set explicitly", () => {
    const w = mountPanel({
      settings: {
        ...makeAgent().settings,
        overrides: {
          ...makeAgent().settings.overrides,
          trelloSync: { enabled: false },
        },
      },
    });
    const line = w.get('[data-test="trello-effective-line"]').text();
    expect(line).toContain("Effective: false");
    expect(line).toContain("override");
  });

  it("emits toggle(repo, 'trelloSync', !envDefault) when the FeatureToggle switch is clicked from null", async () => {
    const w = mountPanel();
    await w.get('[role="switch"]').trigger("click");
    const events = w.emitted<[string, Feature, boolean | null]>("toggle");
    expect(events).toHaveLength(1);
    // envDefault === configured === true, null → !envDefault = false.
    expect(events![0]).toEqual(["danxbot", "trelloSync", false]);
  });

  it("clicking [edit] swaps the masked value for an input that starts empty", async () => {
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    const input = w.get<HTMLInputElement>('[data-test="trello-apiKey-input"]');
    expect(input.element.value).toBe("");
    expect(w.find('[data-test="trello-apiKey-masked"]').exists()).toBe(false);
  });

  it("hides the [reveal] button when import.meta.env.DEV is false", async () => {
    vi.stubEnv("DEV", false);
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    expect(w.find('[data-test="trello-apiKey-reveal"]').exists()).toBe(false);
  });

  it("toggles input type between password and text when [reveal] is clicked", async () => {
    vi.stubEnv("DEV", true);
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    const input = w.get<HTMLInputElement>('[data-test="trello-apiKey-input"]');
    expect(input.attributes("type")).toBe("password");

    await w.get('[data-test="trello-apiKey-reveal"]').trigger("click");
    expect(input.attributes("type")).toBe("text");

    await w.get('[data-test="trello-apiKey-reveal"]').trigger("click");
    expect(input.attributes("type")).toBe("password");
  });

  it("[Save] is disabled when no field is dirty", async () => {
    const w = mountPanel();
    const save = w.get<HTMLButtonElement>('[data-test="trello-save"]');
    expect(save.element.disabled).toBe(true);
  });

  it("Save with only apiKey dirty: PATCH body has apiKey, not apiToken", async () => {
    mockPatchTrelloCredentials.mockResolvedValueOnce({
      updated: ["apiKey"],
      restartRequired: true,
    });
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("brand-new-key");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    expect(mockPatchTrelloCredentials).toHaveBeenCalledOnce();
    expect(mockPatchTrelloCredentials).toHaveBeenCalledWith("danxbot", {
      apiKey: "brand-new-key",
    });
  });

  it("Save with both dirty: both fields included in the PATCH body", async () => {
    mockPatchTrelloCredentials.mockResolvedValueOnce({
      updated: ["apiKey", "apiToken"],
      restartRequired: true,
    });
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("new-key");
    await w.get('[data-test="trello-apiToken-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiToken-input"]')
      .setValue("new-token");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    expect(mockPatchTrelloCredentials).toHaveBeenCalledWith("danxbot", {
      apiKey: "new-key",
      apiToken: "new-token",
    });
  });

  it("emits refresh + clears editors after a successful PATCH", async () => {
    mockPatchTrelloCredentials.mockResolvedValueOnce({
      updated: ["apiKey"],
      restartRequired: true,
    });
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("k");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    const refresh = w.emitted<[string]>("refresh");
    expect(refresh).toHaveLength(1);
    expect(refresh![0]).toEqual(["danxbot"]);
    // Editor for apiKey closed; masked value restored.
    expect(w.find('[data-test="trello-apiKey-input"]').exists()).toBe(false);
    // `get()` throws when missing, so simply retrieving is the assertion.
    w.get('[data-test="trello-apiKey-masked"]');
    // Restart-required banner surfaces.
    w.get('[data-test="trello-restart-required"]');
  });

  it("surfaces a 4xx server error inline and does not close the editor", async () => {
    const err = Object.assign(new Error("Backend boom"), {
      status: 400,
      serverMessage: "apiKey must be a non-empty string",
    });
    mockPatchTrelloCredentials.mockRejectedValueOnce(err);
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("   ");
    // Whitespace-only is not dirty → save button stays disabled. Type real value.
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("bad");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    const errEl = w.get('[data-test="trello-save-error"]');
    expect(errEl.text()).toContain("apiKey must be a non-empty string");
    // Editor stays open so the operator can re-try.
    expect(w.find('[data-test="trello-apiKey-input"]').exists()).toBe(true);
    // No refresh emitted.
    expect(w.emitted("refresh")).toBeUndefined();
  });

  it("ignores whitespace-only input — Save stays disabled", async () => {
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("   ");
    const save = w.get<HTMLButtonElement>('[data-test="trello-save"]');
    expect(save.element.disabled).toBe(true);
  });

  it("renders '(not set)' for missing display values + 'env default' false effective", () => {
    const w = mountPanel({
      settings: {
        ...makeAgent().settings,
        display: {
          trello: { configured: false },
          links: {},
        },
      },
    });
    expect(w.get('[data-test="trello-board-id"]').text()).toBe("(not set)");
    expect(w.get('[data-test="trello-todo-list-id"]').text()).toBe("(not set)");
    expect(w.get('[data-test="trello-apiKey-masked"]').text()).toBe("(not set)");
    expect(w.get('[data-test="trello-apiToken-masked"]').text()).toBe(
      "(not set)",
    );
    // When creds are absent → envDefault collapses to false; the effective
    // line must reflect that, not the always-true default.
    const eff = w.get('[data-test="trello-effective-line"]').text();
    expect(eff).toContain("Effective: false");
    expect(eff).toContain("env default");
  });

  it("cancel button closes the editor and the masked value re-appears", async () => {
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("typed-something");
    await w.get('[data-test="trello-apiKey-cancel"]').trigger("click");

    expect(w.find('[data-test="trello-apiKey-input"]').exists()).toBe(false);
    expect(w.get('[data-test="trello-apiKey-masked"]').text()).toBe(
      "abcd****1234",
    );
    // PATCH was not called.
    expect(mockPatchTrelloCredentials).not.toHaveBeenCalled();
  });

  it("three-valued toggle cycle: null → !envDefault → opposite → null", async () => {
    // Walk the full cycle by re-mounting at each step. FeatureToggle's
    // local "next()" rule (true→false, false→true, null→!envDefault)
    // produces three distinct emits across the cycle.
    let agent = makeAgent();
    let w = mount(TrelloConfigPanel, {
      props: { agent, busyFeature: null },
    });
    await w.get('[role="switch"]').trigger("click");
    expect(w.emitted<[string, Feature, boolean | null]>("toggle")![0]).toEqual([
      "danxbot",
      "trelloSync",
      false,
    ]);
    w.unmount();

    agent = makeAgent({
      settings: {
        ...makeAgent().settings,
        overrides: {
          ...makeAgent().settings.overrides,
          trelloSync: { enabled: false },
        },
      },
    });
    w = mount(TrelloConfigPanel, {
      props: { agent, busyFeature: null },
    });
    await w.get('[role="switch"]').trigger("click");
    expect(w.emitted<[string, Feature, boolean | null]>("toggle")![0]).toEqual([
      "danxbot",
      "trelloSync",
      true,
    ]);
    w.unmount();

    // FeatureToggle exposes a separate reset-to-default button (the "reset"
    // link in the row) — emits null. Verify that path so the cycle returns
    // to null as the card body's Tests section requires.
    agent = makeAgent({
      settings: {
        ...makeAgent().settings,
        overrides: {
          ...makeAgent().settings.overrides,
          trelloSync: { enabled: true },
        },
      },
    });
    w = mount(TrelloConfigPanel, {
      props: { agent, busyFeature: null },
    });
    const resetBtn = w
      .findAll("button")
      .find((b) => b.text() === "reset");
    expect(resetBtn).toBeTruthy();
    await resetBtn!.trigger("click");
    expect(w.emitted<[string, Feature, boolean | null]>("toggle")![0]).toEqual([
      "danxbot",
      "trelloSync",
      null,
    ]);
    w.unmount();
  });

  it("FeatureToggle is disabled when busyFeature === 'trelloSync'", () => {
    const w = mountPanel({}, "trelloSync");
    const sw = w.get<HTMLButtonElement>('[role="switch"]');
    expect(sw.element.disabled).toBe(true);
  });

  it("disables [edit], [cancel], [reveal], input + Save mid-flight while saving=true", async () => {
    vi.stubEnv("DEV", true);
    // Deferred promise — PATCH is in-flight when we assert.
    let resolvePatch!: (v: { updated: string[]; restartRequired: boolean }) => void;
    mockPatchTrelloCredentials.mockReturnValueOnce(
      new Promise((res) => {
        resolvePatch = res;
      }),
    );
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("typed");
    // Open token editor too so its cancel/reveal/input are present.
    await w.get('[data-test="trello-apiToken-edit"]').trigger("click");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    // Save button shows the saving label + is disabled.
    const saveBtn = w.get<HTMLButtonElement>('[data-test="trello-save"]');
    expect(saveBtn.element.disabled).toBe(true);
    expect(saveBtn.text()).toContain("Saving");

    // apiKey editor controls all disabled.
    expect(
      w.get<HTMLInputElement>('[data-test="trello-apiKey-input"]').element
        .disabled,
    ).toBe(true);
    expect(
      w.get<HTMLButtonElement>('[data-test="trello-apiKey-reveal"]').element
        .disabled,
    ).toBe(true);
    expect(
      w.get<HTMLButtonElement>('[data-test="trello-apiKey-cancel"]').element
        .disabled,
    ).toBe(true);
    // apiToken's [edit] (still in non-editing mode initially — but we
    // opened it above, so the cancel is the only one rendered) ...
    expect(
      w.get<HTMLButtonElement>('[data-test="trello-apiToken-cancel"]').element
        .disabled,
    ).toBe(true);

    // Resolve and confirm we leave the saving state. The Save button
    // may still be disabled because no field remains dirty — what we
    // really check is the saving FLAG cleared (label flips back to
    // "Save").
    resolvePatch({ updated: ["apiKey"], restartRequired: true });
    await flushPromises();
    expect(w.get('[data-test="trello-save"]').text()).toBe("Save");
  });

  it("partial-success: when result.updated = ['apiKey'] only, apiToken editor stays open", async () => {
    mockPatchTrelloCredentials.mockResolvedValueOnce({
      updated: ["apiKey"],
      restartRequired: true,
    });
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("k");
    await w.get('[data-test="trello-apiToken-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiToken-input"]')
      .setValue("t");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    // apiKey editor closed; apiToken editor stays open (server didn't
    // include it in `updated`).
    expect(w.find('[data-test="trello-apiKey-input"]').exists()).toBe(false);
    expect(w.find('[data-test="trello-apiToken-input"]').exists()).toBe(true);
    // PATCH was called with both.
    expect(mockPatchTrelloCredentials).toHaveBeenCalledWith("danxbot", {
      apiKey: "k",
      apiToken: "t",
    });
  });

  it("surfaces a 5xx server error inline the same as a 4xx", async () => {
    const err = Object.assign(new Error("Backend boom"), {
      status: 500,
      serverMessage: "internal: env writer crashed",
    });
    mockPatchTrelloCredentials.mockRejectedValueOnce(err);
    const w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("k");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="trello-save-error"]').text()).toContain(
      "internal: env writer crashed",
    );
    expect(w.emitted("refresh")).toBeUndefined();
  });

  it("falls back to Error.message when serverMessage is absent, then to a literal", async () => {
    // No serverMessage → use Error.message.
    mockPatchTrelloCredentials.mockRejectedValueOnce(new Error("network down"));
    let w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("k");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-test="trello-save-error"]').text()).toContain(
      "network down",
    );
    w.unmount();

    // Reject with no Error shape at all → literal fallback fires.
    mockPatchTrelloCredentials.mockRejectedValueOnce(undefined);
    w = mountPanel();
    await w.get('[data-test="trello-apiKey-edit"]').trigger("click");
    await w
      .get<HTMLInputElement>('[data-test="trello-apiKey-input"]')
      .setValue("k");
    await w.get('[data-test="trello-save"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-test="trello-save-error"]').text()).toContain(
      "Failed to rotate credentials.",
    );
  });

  it("copy-board-id calls clipboard.writeText with the board id and surfaces 'copied'", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const w = mountPanel();
    await w.get('[data-test="trello-copy-board-id"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("board-1");
    expect(w.get('[data-test="trello-copy-feedback"]').text()).toBe("copied");
  });

  it("copy-board-id surfaces 'copy failed' when clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const w = mountPanel();
    await w.get('[data-test="trello-copy-board-id"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-test="trello-copy-feedback"]').text()).toContain(
      "copy failed",
    );
  });

  it("copy-board-id button is disabled when boardId is '(not set)'", () => {
    const w = mountPanel({
      settings: {
        ...makeAgent().settings,
        display: { trello: { configured: false }, links: {} },
      },
    });
    const btn = w.get<HTMLButtonElement>('[data-test="trello-copy-board-id"]');
    expect(btn.element.disabled).toBe(true);
  });
});

