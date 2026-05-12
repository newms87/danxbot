/**
 * Skill-trigger assertion against a Claude Code session JSONL.
 *
 * Given a session JSONL produced by a probe dispatch, decides whether the
 * agent invoked an expected skill via the `Skill` tool BEFORE the first
 * assistant text block in that session.
 *
 * Rationale:
 *   - The harness asserts that a load-discipline trigger fires on the very
 *     first turn (the prompt was crafted to match the skill's description).
 *   - A `Skill` tool_use entry whose `input.skill === expected` qualifies as
 *     a successful load. Anything else (the agent answered directly, loaded
 *     a different skill first, or never loaded anything) is a FAIL.
 *   - Sub-agent JSONL entries (`isSidechain: true`) are skipped — they
 *     belong to a downstream Task dispatch, not the top-level session.
 *
 * Pure module: takes a JSONL string + dispatch tag + expected skill name,
 * returns a structured verdict. No filesystem, no network — the runner
 * (`run.ts`) is responsible for resolving the file path and reading it.
 */

export interface SkillTriggerVerdict {
  /** True iff a top-level `Skill` tool_use with the expected name landed before the first assistant text block. */
  readonly pass: boolean;
  /** Reason summary suitable for CLI output. */
  readonly reason: string;
  /** Every top-level Skill name observed up to the stop point (in order). Useful for FAIL diagnostics. */
  readonly skillCalls: readonly string[];
  /** First ~200 chars of the first assistant text block, when one was found. */
  readonly firstAssistantText?: string;
  /** True iff the dispatch tag could be located in the JSONL — when false, the dispatch and JSONL likely don't match. */
  readonly tagFound: boolean;
  /**
   * Number of JSONL lines that failed to JSON.parse. Surfaced so the runner
   * can warn the operator — a non-zero count means the parser MAY have
   * missed a real `Skill` tool_use carried by the dropped line, and a FAIL
   * verdict here is suspect rather than authoritative.
   */
  readonly droppedLines: number;
}

interface ContentBlock {
  type?: string;
  name?: string;
  input?: { skill?: string };
  text?: string;
}

interface JsonlEntry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
}

/**
 * Parse JSONL text. Unparseable lines are tolerated (claude occasionally
 * writes partial lines mid-stream and the harness reads the file after
 * the dispatch reaches terminal status — partial lines should not abort
 * the assertion), but the count is returned so the caller can surface it:
 * a dropped line MAY have carried the very tool_use entry the assertion
 * hinges on, so a FAIL with droppedLines > 0 is suspect.
 */
export function parseJsonlEntries(jsonl: string): {
  entries: JsonlEntry[];
  droppedLines: number;
} {
  const entries: JsonlEntry[] = [];
  let droppedLines = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JsonlEntry);
    } catch {
      droppedLines++;
    }
  }
  return { entries, droppedLines };
}

/**
 * Locate the first entry whose payload contains the dispatch tag string.
 * Returns -1 when the tag is absent — the caller treats that as a JSONL
 * / dispatch mismatch (almost always means the runner picked the wrong
 * session file).
 *
 * Search is intentionally JSON-stringify-based: the tag can land in
 * `message.content[].text` (host-mode positional arg) OR inside a hook
 * `additionalContext` blob (rare but observed). Stringifying the whole
 * entry catches both surfaces without growing a brittle keypath list.
 */
export function findDispatchTagIndex(
  entries: readonly JsonlEntry[],
  dispatchTag: string,
): number {
  for (let i = 0; i < entries.length; i++) {
    const serialized = JSON.stringify(entries[i] ?? null);
    if (serialized.includes(dispatchTag)) return i;
  }
  return -1;
}

function isNonEmptyText(block: ContentBlock): boolean {
  if (block.type !== "text") return false;
  if (typeof block.text !== "string") return false;
  return block.text.trim().length > 0;
}

function getContentBlocks(entry: JsonlEntry): ContentBlock[] {
  const content = entry.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Run the assertion. Walk entries in order starting from the dispatch tag;
 * within each `type: assistant` entry, walk content blocks in document
 * order; the first `text` block stops the scan; any `tool_use` named
 * `Skill` matches against `expectedSkill`.
 *
 * Match semantics: `block.input.skill === expectedSkill` — exact string
 * equality. Callers use the canonical `<plugin>:<skill>` form
 * (e.g. `dev:debugging`); the JSONL stamps whatever the user / agent
 * literally invoked (Skill tool input.skill). A FAIL verdict carries
 * the observed `skillCalls[]` so the operator can see whether the agent
 * loaded a different skill, or none at all.
 */
export function evaluateSkillTrigger(
  jsonl: string,
  dispatchTag: string,
  expectedSkill: string,
): SkillTriggerVerdict {
  const { entries, droppedLines } = parseJsonlEntries(jsonl);
  const tagIdx = findDispatchTagIndex(entries, dispatchTag);
  if (tagIdx === -1) {
    return {
      pass: false,
      reason: `Dispatch tag ${dispatchTag} not found in JSONL — likely picked the wrong session file`,
      skillCalls: [],
      tagFound: false,
      droppedLines,
    };
  }

  const skillCalls: string[] = [];
  for (let i = tagIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isSidechain) continue;
    if (entry.type !== "assistant") continue;
    const blocks = getContentBlocks(entry);
    for (const block of blocks) {
      if (
        block.type === "tool_use" &&
        block.name === "Skill" &&
        typeof block.input?.skill === "string"
      ) {
        skillCalls.push(block.input.skill);
        if (block.input.skill === expectedSkill) {
          return {
            pass: true,
            reason: `Skill(${expectedSkill}) invoked before first assistant text`,
            skillCalls,
            tagFound: true,
            droppedLines,
          };
        }
        continue;
      }
      if (isNonEmptyText(block)) {
        return {
          pass: false,
          reason:
            skillCalls.length > 0
              ? `Assistant produced text after invoking ${skillCalls.join(", ")} — expected ${expectedSkill} was NOT among them`
              : `Assistant produced text without invoking any Skill — expected ${expectedSkill}`,
          skillCalls,
          firstAssistantText: (block.text ?? "").slice(0, 200),
          tagFound: true,
          droppedLines,
        };
      }
    }
  }

  return {
    pass: false,
    reason:
      skillCalls.length > 0
        ? `Session ended after invoking ${skillCalls.join(", ")} but never matched ${expectedSkill}`
        : `Session ended without any Skill tool_use — expected ${expectedSkill}`,
    skillCalls,
    tagFound: true,
    droppedLines,
  };
}
