import { describe, expect, it, vi } from "vitest";
import { MAX_DESCRIPTION_LENGTH } from "./description-editor.js";
import {
  DescriptionProposerError,
  buildProposerPrompt,
  makeAnthropicProposer,
  parseProposerResponse,
  type ProposerInput,
} from "./description-proposer.js";

const sampleInput: ProposerInput = {
  pluginSkill: "dev:debugging",
  currentDescription:
    "MANDATORY for bugs, errors, failing tests, or making factual assertions.",
  trainFailures: [
    {
      query: "Summarize the failures from the latest CI run.",
      expected: "trigger",
      observed: "no-trigger",
    },
    {
      query: "Why is the dispatch agent stuck on DX-244?",
      expected: "trigger",
      observed: "no-trigger",
    },
    {
      query: "List the files in src/agent/",
      expected: "no-trigger",
      observed: "trigger",
    },
  ],
  attempt: 1,
};

describe("buildProposerPrompt", () => {
  it("includes the current description", () => {
    const p = buildProposerPrompt(sampleInput);
    expect(p).toContain(sampleInput.currentDescription);
  });

  it("includes the plugin:skill identifier", () => {
    expect(buildProposerPrompt(sampleInput)).toContain("dev:debugging");
  });

  it("labels train failures by side (false negative vs false positive)", () => {
    const p = buildProposerPrompt(sampleInput);
    expect(p).toMatch(/false negative|should[ -]have[ -]triggered|MISSED/i);
    expect(p).toMatch(/false positive|should[ -]NOT[ -]have[ -]triggered|EXTRA/i);
  });

  it("quotes every failing query verbatim", () => {
    const p = buildProposerPrompt(sampleInput);
    for (const f of sampleInput.trainFailures) {
      expect(p).toContain(f.query);
    }
  });

  it("communicates the length budget to the model", () => {
    const p = buildProposerPrompt(sampleInput);
    expect(p).toContain(`${MAX_DESCRIPTION_LENGTH}`);
  });

  it("renders an attempt-N marker so the model knows context", () => {
    expect(buildProposerPrompt({ ...sampleInput, attempt: 3 })).toMatch(/attempt 3|iteration 3/i);
  });

  it("trims correctly when there are no false negatives", () => {
    const p = buildProposerPrompt({
      ...sampleInput,
      trainFailures: [
        {
          query: "do a thing",
          expected: "no-trigger",
          observed: "trigger",
        },
      ],
    });
    expect(p).toMatch(/false positive|EXTRA/i);
  });

  it("trims correctly when there are no false positives", () => {
    const p = buildProposerPrompt({
      ...sampleInput,
      trainFailures: [
        {
          query: "thing",
          expected: "trigger",
          observed: "no-trigger",
        },
      ],
    });
    expect(p).toMatch(/false negative|MISSED/i);
  });

  it("rejects empty trainFailures (no signal to propose against)", () => {
    expect(() =>
      buildProposerPrompt({ ...sampleInput, trainFailures: [] }),
    ).toThrow(DescriptionProposerError);
  });
});

describe("parseProposerResponse", () => {
  it("extracts a description wrapped in <description> tags", () => {
    const raw = "Reasoning blah blah\n<description>NEW DESC</description>\nmore noise";
    expect(parseProposerResponse(raw)).toBe("NEW DESC");
  });

  it("extracts a multi-line description (preserves internal newlines)", () => {
    const raw = "<description>Line 1\nLine 2\nLine 3</description>";
    expect(parseProposerResponse(raw)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("trims surrounding whitespace from the captured value", () => {
    const raw = "<description>\n  padded  \n</description>";
    expect(parseProposerResponse(raw)).toBe("padded");
  });

  it("throws when no <description> tag is present", () => {
    expect(() => parseProposerResponse("just text")).toThrow(
      DescriptionProposerError,
    );
    expect(() => parseProposerResponse("just text")).toThrow(/<description>/);
  });

  it("throws when the <description> capture is empty", () => {
    expect(() =>
      parseProposerResponse("<description></description>"),
    ).toThrow(/empty/);
  });

  it("throws when the value exceeds the length cap", () => {
    const tooLong = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    expect(() =>
      parseProposerResponse(`<description>${tooLong}</description>`),
    ).toThrow(/length|cap/);
  });

  it("uses only the FIRST <description> tag if multiple are emitted", () => {
    const raw = "<description>FIRST</description>\n<description>SECOND</description>";
    expect(parseProposerResponse(raw)).toBe("FIRST");
  });
});

describe("makeAnthropicProposer", () => {
  function buildFakeClient(responseText: string) {
    const create = vi.fn(
      async (_args: { model: string; max_tokens: number; messages: { role: string; content: string }[] }) => ({
        content: [{ type: "text", text: responseText }],
      }),
    );
    return {
      client: { messages: { create } } as never,
      create,
    };
  }

  it("calls Anthropic with the built prompt and returns the parsed description", async () => {
    const { client, create } = buildFakeClient(
      "<description>Tighter description text.</description>",
    );
    const proposer = makeAnthropicProposer({ client, model: "haiku-test" });
    const out = await proposer(sampleInput);
    expect(out.newDescription).toBe("Tighter description text.");
    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0]![0]!;
    expect(call.model).toBe("haiku-test");
    expect(call.messages[0].content).toContain("dev:debugging");
  });

  it("uses claude-haiku-4-5 as the default model", async () => {
    const { client, create } = buildFakeClient(
      "<description>x</description>",
    );
    const proposer = makeAnthropicProposer({ client });
    await proposer(sampleInput);
    const call = create.mock.calls[0]![0]!;
    expect(call.model).toMatch(/haiku/);
  });

  it("propagates DescriptionProposerError when the response can't be parsed", async () => {
    const { client } = buildFakeClient("no description tag here");
    const proposer = makeAnthropicProposer({ client });
    await expect(proposer(sampleInput)).rejects.toThrow(
      DescriptionProposerError,
    );
  });

  it("throws when the content array is empty / has no text block", async () => {
    const create = vi.fn(async () => ({ content: [] }));
    const proposer = makeAnthropicProposer({
      client: { messages: { create } } as never,
    });
    await expect(proposer(sampleInput)).rejects.toThrow(/empty|content/);
  });

  it("concatenates multiple text content blocks before parsing", async () => {
    const create = vi.fn(async () => ({
      content: [
        { type: "text", text: "Pre-thought.\n" },
        { type: "text", text: "<description>FROM BLOCK 2</description>" },
      ],
    }));
    const proposer = makeAnthropicProposer({
      client: { messages: { create } } as never,
    });
    const out = await proposer(sampleInput);
    expect(out.newDescription).toBe("FROM BLOCK 2");
  });
});
