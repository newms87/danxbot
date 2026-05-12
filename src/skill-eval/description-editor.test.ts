import { describe, expect, it } from "vitest";
import {
  DescriptionEditError,
  MAX_DESCRIPTION_LENGTH,
  getDescription,
  parseSkillFile,
  replaceDescription,
  validateDiff,
} from "./description-editor.js";

const sampleSkill = `---
name: example
description: 'Original short description.'
---

# Example Skill

Body line 1.
Body line 2.
`;

const sampleSkillBlock = `---
name: example
description: |
  Long-form
  multi-line
  description.
---

Body.
`;

describe("parseSkillFile", () => {
  it("splits frontmatter from body", () => {
    const f = parseSkillFile(sampleSkill);
    expect(f.frontmatter.name).toBe("example");
    expect(f.frontmatter.description).toBe("Original short description.");
    expect(f.body).toBe(
      "\n# Example Skill\n\nBody line 1.\nBody line 2.\n",
    );
  });

  it("parses block-scalar descriptions", () => {
    const f = parseSkillFile(sampleSkillBlock);
    expect(f.frontmatter.description).toBe(
      "Long-form\nmulti-line\ndescription.\n",
    );
  });

  it("preserves CRLF body bytes verbatim", () => {
    const crlf = `---\nname: x\ndescription: 'a'\n---\r\nBody\r\nMore\r\n`;
    const f = parseSkillFile(crlf);
    expect(f.body).toBe("Body\r\nMore\r\n");
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseSkillFile("# No frontmatter\n")).toThrow(
      DescriptionEditError,
    );
    expect(() => parseSkillFile("# No frontmatter\n")).toThrow(/frontmatter/);
  });

  it("rejects a file whose frontmatter is not a YAML mapping", () => {
    const bad = "---\n- 1\n- 2\n---\nbody";
    expect(() => parseSkillFile(bad)).toThrow(DescriptionEditError);
    expect(() => parseSkillFile(bad)).toThrow(/mapping/);
  });

  it("rejects malformed YAML in frontmatter", () => {
    const bad = "---\nname: 'unterminated\n---\nbody";
    expect(() => parseSkillFile(bad)).toThrow(DescriptionEditError);
    expect(() => parseSkillFile(bad)).toThrow(/parse/);
  });

  it("rejects an unclosed frontmatter block", () => {
    const bad = "---\nname: example\nbody-without-closing-marker\n";
    expect(() => parseSkillFile(bad)).toThrow(/frontmatter/);
  });
});

describe("getDescription", () => {
  it("returns the description string", () => {
    expect(getDescription(sampleSkill)).toBe("Original short description.");
  });

  it("returns the block-scalar value with newlines intact", () => {
    expect(getDescription(sampleSkillBlock)).toBe(
      "Long-form\nmulti-line\ndescription.\n",
    );
  });

  it("throws when description field is absent", () => {
    const noDesc = "---\nname: x\n---\nbody";
    expect(() => getDescription(noDesc)).toThrow(/description/);
  });

  it("throws when description is non-string (e.g. a number)", () => {
    const numDesc = "---\nname: x\ndescription: 42\n---\nbody";
    expect(() => getDescription(numDesc)).toThrow(/non-string/);
  });
});

describe("replaceDescription", () => {
  it("replaces the description and leaves the body byte-identical", () => {
    const updated = replaceDescription(sampleSkill, "New description text.");
    const f = parseSkillFile(updated);
    expect(f.frontmatter.description).toBe("New description text.");
    expect(f.body).toBe(parseSkillFile(sampleSkill).body);
  });

  it("preserves the original frontmatter key order", () => {
    const orig = `---\nname: x\nallowed-tools:\n  - Read\ndescription: 'old'\nmodel: opus\n---\nbody`;
    const updated = replaceDescription(orig, "new");
    // Keys appear in the same order in the serialized output.
    const lines = updated.split("\n");
    const nameLine = lines.findIndex((l) => l.startsWith("name:"));
    const toolsLine = lines.findIndex((l) => l.startsWith("allowed-tools:"));
    const descLine = lines.findIndex((l) => l.startsWith("description:"));
    const modelLine = lines.findIndex((l) => l.startsWith("model:"));
    expect(nameLine).toBeLessThan(toolsLine);
    expect(toolsLine).toBeLessThan(descLine);
    expect(descLine).toBeLessThan(modelLine);
  });

  it("preserves non-description frontmatter values exactly", () => {
    const orig = `---\nname: x\nmodel: opus\ndescription: 'old'\n---\nbody`;
    const updated = replaceDescription(orig, "new");
    const f = parseSkillFile(updated);
    expect(f.frontmatter.name).toBe("x");
    expect(f.frontmatter.model).toBe("opus");
  });

  it("rejects an empty new description", () => {
    expect(() => replaceDescription(sampleSkill, "")).toThrow(/empty/);
  });

  it("rejects a whitespace-only new description", () => {
    expect(() => replaceDescription(sampleSkill, "   \n\t")).toThrow(
      /empty/,
    );
  });

  it("rejects a new description over the length cap", () => {
    const tooLong = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    expect(() => replaceDescription(sampleSkill, tooLong)).toThrow(
      DescriptionEditError,
    );
    expect(() => replaceDescription(sampleSkill, tooLong)).toThrow(
      /length/i,
    );
  });

  it("accepts a new description exactly at the length cap", () => {
    const justRight = "x".repeat(MAX_DESCRIPTION_LENGTH);
    expect(() =>
      replaceDescription(sampleSkill, justRight),
    ).not.toThrow();
  });

  it("throws when the source has no description field", () => {
    const noDesc = "---\nname: x\n---\nbody";
    expect(() => replaceDescription(noDesc, "anything")).toThrow(
      /description/,
    );
  });

  it("round-trips through parseSkillFile+replaceDescription", () => {
    const round = replaceDescription(sampleSkill, "Round trip.");
    const f = parseSkillFile(round);
    expect(f.frontmatter.description).toBe("Round trip.");
    expect(f.frontmatter.name).toBe("example");
  });
});

describe("validateDiff", () => {
  it("accepts a same-source no-op diff", () => {
    expect(() => validateDiff(sampleSkill, sampleSkill)).not.toThrow();
  });

  it("accepts a diff that only changes the description", () => {
    const updated = replaceDescription(sampleSkill, "New description.");
    expect(() => validateDiff(sampleSkill, updated)).not.toThrow();
  });

  it("rejects a diff that touches the body", () => {
    const original = sampleSkill;
    const tampered = sampleSkill.replace(
      "Body line 1.",
      "Body line 1. INJECTED",
    );
    expect(() => validateDiff(original, tampered)).toThrow(
      DescriptionEditError,
    );
    expect(() => validateDiff(original, tampered)).toThrow(/body/);
  });

  it("rejects a diff that adds a frontmatter key", () => {
    const original = sampleSkill;
    const tampered = sampleSkill.replace(
      "description: 'Original short description.'",
      "description: 'Original short description.'\nmodel: opus",
    );
    expect(() => validateDiff(original, tampered)).toThrow(/keys/);
  });

  it("rejects a diff that removes a frontmatter key", () => {
    const orig = `---\nname: x\nmodel: opus\ndescription: 'a'\n---\nbody`;
    const tampered = `---\nname: x\ndescription: 'a'\n---\nbody`;
    expect(() => validateDiff(orig, tampered)).toThrow(/keys/);
  });

  it("rejects a diff that renames the skill (changes `name`)", () => {
    const original = sampleSkill;
    const tampered = sampleSkill.replace("name: example", "name: renamed");
    expect(() => validateDiff(original, tampered)).toThrow(
      /name|changed/,
    );
  });

  it("rejects a diff that changes a non-description frontmatter value", () => {
    const orig = `---\nname: x\nmodel: opus\ndescription: 'a'\n---\nbody`;
    const tampered = `---\nname: x\nmodel: haiku\ndescription: 'a'\n---\nbody`;
    expect(() => validateDiff(orig, tampered)).toThrow(/model/);
  });

  it("surfaces the changed key name in the error message", () => {
    const orig = `---\nname: x\nmodel: opus\ndescription: 'a'\n---\nbody`;
    const tampered = `---\nname: x\nmodel: haiku\ndescription: 'a'\n---\nbody`;
    let caught: unknown;
    try {
      validateDiff(orig, tampered);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DescriptionEditError);
    expect((caught as Error).message).toContain("model");
  });
});

describe("validateDiff round-trips block-scalar source", () => {
  it("accepts replaceDescription output even when the source used a block scalar", () => {
    // sampleSkillBlock uses `description: |` block-scalar form. After
    // `replaceDescription` the YAML serializer chooses whatever
    // representation is shortest — for a single-line replacement it
    // emits a quoted scalar. validateDiff parses both sides so the
    // representation change is invisible to its keys+body comparison.
    const updated = replaceDescription(sampleSkillBlock, "New short.");
    expect(() => validateDiff(sampleSkillBlock, updated)).not.toThrow();
    // The value round-trips through getDescription correctly.
    expect(getDescription(updated)).toBe("New short.");
  });
});

describe("DescriptionEditError category", () => {
  it("carries a category for downstream classification", () => {
    try {
      parseSkillFile("# nope");
    } catch (e) {
      expect(e).toBeInstanceOf(DescriptionEditError);
      expect((e as DescriptionEditError).category).toBe("no-frontmatter");
    }
    try {
      replaceDescription(sampleSkill, "");
    } catch (e) {
      expect((e as DescriptionEditError).category).toBe("description-empty");
    }
    try {
      replaceDescription(sampleSkill, "x".repeat(MAX_DESCRIPTION_LENGTH + 1));
    } catch (e) {
      expect((e as DescriptionEditError).category).toBe(
        "description-too-long",
      );
    }
  });
});
