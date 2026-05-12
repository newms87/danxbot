import { describe, expect, it } from "vitest";
import { evaluateSkillTrigger } from "./jsonl-parser.js";

const TAG = "<!-- danxbot-dispatch:probe-001 -->";

function lines(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function userTagEntry(): object {
  return {
    type: "user",
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "text", text: `${TAG} please look at /tmp/foo.log` }],
    },
  };
}

function assistantSkill(name: string): object {
  return {
    type: "assistant",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_001",
          name: "Skill",
          input: { skill: name },
        },
      ],
    },
  };
}

function assistantText(body: string): object {
  return {
    type: "assistant",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: body }],
    },
  };
}

function sidechainSkill(name: string): object {
  return {
    type: "assistant",
    isSidechain: true,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_sub",
          name: "Skill",
          input: { skill: name },
        },
      ],
    },
  };
}

describe("evaluateSkillTrigger", () => {
  it("PASS when expected Skill is invoked before any assistant text", () => {
    const jsonl = lines(
      userTagEntry(),
      assistantSkill("dev:debugging"),
      assistantText("OK here is the diagnosis..."),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(true);
    expect(v.tagFound).toBe(true);
    expect(v.skillCalls).toEqual(["dev:debugging"]);
  });

  it("FAIL when assistant produces text without invoking any Skill", () => {
    const jsonl = lines(
      userTagEntry(),
      assistantText("Sure, the test logs show..."),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.skillCalls).toEqual([]);
    expect(v.firstAssistantText).toContain("Sure, the test logs");
    expect(v.reason).toMatch(/without invoking any Skill/);
  });

  it("FAIL when a DIFFERENT Skill is invoked before assistant text", () => {
    const jsonl = lines(
      userTagEntry(),
      assistantSkill("base:tool-discipline"),
      assistantText("Loaded the tool-discipline skill."),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.skillCalls).toEqual(["base:tool-discipline"]);
    expect(v.reason).toMatch(/base:tool-discipline.*dev:debugging/);
  });

  it("ignores sidechain (sub-agent) Skill calls", () => {
    const jsonl = lines(
      userTagEntry(),
      sidechainSkill("dev:debugging"),
      assistantText("dispatching a sub-agent..."),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.skillCalls).toEqual([]);
  });

  it("FAIL with tagFound=false when the dispatch tag is absent", () => {
    const jsonl = lines(
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "no tag here" }] },
      },
      assistantSkill("dev:debugging"),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.tagFound).toBe(false);
    expect(v.reason).toMatch(/not found/);
  });

  it("PASS when the expected Skill is the SECOND of multiple invocations", () => {
    const jsonl = lines(
      userTagEntry(),
      assistantSkill("base:tool-discipline"),
      assistantSkill("dev:debugging"),
      assistantText("done"),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(true);
    expect(v.skillCalls).toEqual(["base:tool-discipline", "dev:debugging"]);
  });

  it("FAIL when session ends with no text and no matching Skill", () => {
    const jsonl = lines(userTagEntry(), assistantSkill("other:thing"));
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/never matched/);
  });

  it("skips unparseable JSONL lines and surfaces droppedLines count", () => {
    const jsonl =
      JSON.stringify(userTagEntry()) +
      "\nnot valid json\n" +
      JSON.stringify(assistantSkill("dev:debugging")) +
      "\n";
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(true);
    expect(v.droppedLines).toBe(1);
  });

  it("droppedLines is 0 on a clean JSONL", () => {
    const jsonl = lines(
      userTagEntry(),
      assistantSkill("dev:debugging"),
      assistantText("done"),
    );
    expect(evaluateSkillTrigger(jsonl, TAG, "dev:debugging").droppedLines).toBe(
      0,
    );
  });

  it("ignores tool_use entries whose name is not 'Skill'", () => {
    const jsonl = lines(
      userTagEntry(),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "/tmp/foo" } },
          ],
        },
      },
      assistantText("read the file"),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.skillCalls).toEqual([]);
  });

  it("PASS when a single assistant turn carries Skill(tool_use) THEN text in one content array", () => {
    // Real Claude Code shape: thinking → tool_use → text can all live in one
    // assistant message's `content[]`. The parser walks blocks in document
    // order, so an in-array Skill BEFORE an in-array text block satisfies
    // the trigger even though the same turn ends with text.
    const jsonl = lines(userTagEntry(), {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "Skill", input: { skill: "dev:debugging" } },
          { type: "text", text: "Loaded dev:debugging — beginning analysis." },
        ],
      },
    });
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(true);
    expect(v.skillCalls).toEqual(["dev:debugging"]);
  });

  it("FAIL when in-array text precedes Skill in the same content array", () => {
    // Mirror case: same single assistant turn but text comes first. The text
    // block stops the scan; the trailing tool_use never gets a chance.
    const jsonl = lines(userTagEntry(), {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me think about this first." },
          { type: "tool_use", id: "toolu_a", name: "Skill", input: { skill: "dev:debugging" } },
        ],
      },
    });
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.skillCalls).toEqual([]);
    expect(v.firstAssistantText).toContain("Let me think");
  });

  it("does not crash when message.content is a string (legacy/synthetic shape)", () => {
    const jsonl = lines(userTagEntry(), {
      type: "assistant",
      message: { role: "assistant", content: "Plain string content" },
    });
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.tagFound).toBe(true);
    expect(v.skillCalls).toEqual([]);
  });

  it("ignores Skill tool_use whose input.skill is not a string", () => {
    const jsonl = lines(
      userTagEntry(),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "Skill", input: { skill: 42 } },
          ],
        },
      },
      assistantText("text after malformed skill input"),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(false);
    expect(v.skillCalls).toEqual([]);
  });

  it("finds the dispatch tag when it lives inside a hook additionalContext blob, not message.content", () => {
    // Real shape: SessionStart hooks attach a string blob to the entry but
    // not under `message.content`. The parser's stringify-based search MUST
    // still locate the tag so the walk starts at the correct entry.
    const entryWithHook = {
      type: "system",
      isSidechain: false,
      attachment: {
        hookEvent: "SessionStart",
        stdout: `{"additionalContext": "blah blah ${TAG} blah"}`,
      },
    };
    const jsonl = lines(
      entryWithHook,
      assistantSkill("dev:debugging"),
      assistantText("done"),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(true);
    expect(v.tagFound).toBe(true);
  });

  it("treats whitespace-only text blocks as non-stopping", () => {
    const jsonl = lines(
      userTagEntry(),
      // empty/whitespace text — should not stop the scan
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "   " }],
        },
      },
      assistantSkill("dev:debugging"),
      assistantText("real text now"),
    );
    const v = evaluateSkillTrigger(jsonl, TAG, "dev:debugging");
    expect(v.pass).toBe(true);
  });
});
