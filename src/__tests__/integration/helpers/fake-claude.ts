/**
 * Fake Claude CLI — Writes JSONL session files matching real Claude Code's format.
 *
 * Spawned as a child process by integration tests (via PATH override so the real
 * `claude` binary is replaced). Reads the prompt from CLI args, extracts the
 * dispatch tag, creates a JSONL session file at the expected location, and writes
 * entries simulating a real agent session.
 *
 * Usage:
 *   node --import tsx/esm fake-claude.ts --dangerously-skip-permissions \
 *     --verbose -p "<prompt>"
 *
 * Environment variables:
 *   FAKE_CLAUDE_SESSION_DIR — Override the session directory (required for test isolation)
 *   FAKE_CLAUDE_SCENARIO — Controls behavior:
 *     - "happy" (default): Two assistant messages, exits clean.
 *     - "error": Writes an error result entry, exits with non-zero.
 *     - "slow": One message then goes silent (parent kills via SIGTERM).
 *     - "empty": No assistant messages at all.
 *     - "dup-msg-id": Two assistant entries sharing the SAME `message.id`
 *                  (one text, one tool_use) — reproduces Claude Code's
 *                  multi-block-per-turn JSONL split. Used to verify the
 *                  msg_id usage dedup contract end-to-end.
 *     - "slack": Drives the Slack agent flow without spending API tokens —
 *                POSTs progress updates to DANXBOT_SLACK_UPDATE_URL,
 *                final reply to DANXBOT_SLACK_REPLY_URL, then completion
 *                via DANXBOT_STOP_URL. See the "slack scenario" section
 *                below for env-var contract.
 *     - "critical-failure": Writes one assistant entry, then POSTs
 *                {status:"critical_failure", summary} to DANXBOT_STOP_URL.
 *                Models the env-blocker code path the halt flag exists to
 *                catch (Trello 6AjSUCUQ — AC12 of EK8oSsWn). Reads the
 *                stop URL from `--mcp-config <path>` (mcpServers.danxbot.env)
 *                so the test does not have to learn the per-dispatch URL up
 *                front. Summary text comes from FAKE_CLAUDE_CRITICAL_SUMMARY
 *                (default: "MCP Trello tools failed to load").
 *     - "yaml-lifecycle": Drives the Phase 4 tracker-agnostic flow. Reads
 *                the YAML at FAKE_CLAUDE_YAML_PATH, flips status ToDo →
 *                In Progress, calls danx_issue_save (POST to
 *                DANXBOT_ISSUE_SAVE_URL from --mcp-config), edits the
 *                YAML to the final state (status, ac all checked, retro),
 *                calls danx_issue_save again, then danxbot_complete via
 *                DANXBOT_STOP_URL. NO mcp__trello__* entries written —
 *                that's the structural assertion the test makes.
 *     - "complete-only": Like "happy" but POSTs {status, summary} to
 *                DANXBOT_STOP_URL via the danxbot_complete shape (FROM
 *                --mcp-config) instead of just exiting. Used by the
 *                post-dispatch-check variant where the agent legitimately
 *                "completes" but never moves the tracked card. Status
 *                defaults to "completed"; summary to "ok".
 *   FAKE_CLAUDE_WRITE_DELAY_MS — Delay between JSONL entries (default: 50)
 *   FAKE_CLAUDE_EXIT_CODE — Exit code (default: 0, set to non-zero for error scenarios)
 *   FAKE_CLAUDE_LINGER_MS — Time to wait after writing entries before exiting (default: 3000).
 *                           Gives SessionLogWatcher time to discover the file (~1s) and poll.
 *
 * Slack scenario env (only consulted when FAKE_CLAUDE_SCENARIO=slack):
 *   DANXBOT_SLACK_UPDATE_URL — Worker route for `danxbot_slack_post_update` POSTs
 *   DANXBOT_SLACK_REPLY_URL  — Worker route for `danxbot_slack_reply` POSTs
 *   DANXBOT_STOP_URL         — Worker route for `danxbot_complete` POSTs
 *   FAKE_CLAUDE_SLACK_UPDATES — Newline-delimited progress messages (default: none)
 *   FAKE_CLAUDE_SLACK_REPLY  — Final reply text (default: "Done.")
 *   FAKE_CLAUDE_SLACK_SQL_BLOCK — Optional SQL string to inject as a
 *       ```sql:execute …``` block into the final reply (covers the
 *       K2zQYIdX substitution-path regression).
 *   FAKE_CLAUDE_SLACK_STATUS — Final status sent to DANXBOT_STOP_URL
 *                              (default: "completed"; "failed" + summary
 *                              is the failure-injection path).
 */

import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

// Extract prompt from -p argument (last two args: "-p" "<prompt>")
const promptIdx = args.lastIndexOf("-p");
const prompt = promptIdx >= 0 && promptIdx + 1 < args.length ? args[promptIdx + 1] : "";

/**
 * Read DANXBOT_STOP_URL the way real claude effectively delivers it: from
 * the `mcpServers.danxbot.env.DANXBOT_STOP_URL` field of the per-dispatch
 * MCP settings file passed via `--mcp-config <path>`. Returns undefined
 * when the flag is absent, the file is unreadable, or the field is
 * missing — the caller decides whether that's fatal for the scenario.
 *
 * Why parse the file instead of reading process.env: the dispatch core
 * writes DANXBOT_STOP_URL into the MCP settings (so the spawned MCP
 * server inherits it) but does NOT export it into the claude process
 * environment. Real claude is similarly blind to the URL — only the MCP
 * subprocess sees it. Tests that want fake-claude to call back into the
 * worker must use this path (or pass DANXBOT_STOP_URL directly via env,
 * which is how the slack scenario does it for tests that don't go
 * through the dispatch core at all).
 */
function readStopUrlFromMcpConfig(): string | undefined {
  return readMcpConfigEnv("DANXBOT_STOP_URL");
}

/**
 * Generic reader for any DANXBOT_*_URL value the dispatch core injects
 * into mcpServers.danxbot.env via --mcp-config. Supports the yaml-lifecycle
 * scenario reading DANXBOT_ISSUE_SAVE_URL the same way the real
 * danxbot MCP server does.
 */
function readMcpConfigEnv(key: string): string | undefined {
  const cfgIdx = args.indexOf("--mcp-config");
  if (cfgIdx < 0 || cfgIdx + 1 >= args.length) return undefined;
  const cfgPath = args[cfgIdx + 1];
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      mcpServers?: { danxbot?: { env?: Record<string, string> } };
    };
    const url = parsed.mcpServers?.danxbot?.env?.[key];
    return typeof url === "string" && url ? url : undefined;
  } catch {
    return undefined;
  }
}

// Extract dispatch ID from the prompt tag
const dispatchMatch = prompt.match(/<!-- danxbot-dispatch:([^\s]+) -->/);
const dispatchId = dispatchMatch?.[1] || "unknown";

// Config from env
const sessionDir = process.env.FAKE_CLAUDE_SESSION_DIR;
if (!sessionDir) {
  process.stderr.write("FAKE_CLAUDE_SESSION_DIR is required\n");
  process.exit(1);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO || "happy";
const writeDelayMs = parseInt(process.env.FAKE_CLAUDE_WRITE_DELAY_MS || "50", 10);
const exitCode = parseInt(process.env.FAKE_CLAUDE_EXIT_CODE || "0", 10);
const lingerMs = parseInt(process.env.FAKE_CLAUDE_LINGER_MS || "3000", 10);

// Create session directory and file
mkdirSync(sessionDir, { recursive: true });
const sessionId = randomUUID();
const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);

function writeEntry(entry: Record<string, unknown>): void {
  appendFileSync(jsonlPath, JSON.stringify(entry) + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a JSON body to the given URL. Resolves on any 2xx; rejects on
 * network failure. Tests assert on the capture-server's recorded
 * payload, not on this function's return value.
 */
async function postJson(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`fake-claude slack POST ${url} -> ${res.status}`);
  }
}

/**
 * Drive the agent-signaled critical-failure path end-to-end.
 *
 * Writes a minimal assistant entry so the SessionLogWatcher attaches
 * (the launcher needs activity to confirm the spawn worked), then POSTs
 * `{status:"critical_failure", summary}` to DANXBOT_STOP_URL. The worker's
 * handleStop in src/worker/dispatch.ts receives the POST and writes the
 * `<repo>/.danxbot/CRITICAL_FAILURE` flag. fake-claude exits soon after.
 *
 * Reads DANXBOT_STOP_URL from the MCP settings file passed via
 * `--mcp-config <path>` because that mirrors how the URL reaches a real
 * dispatch — see `readStopUrlFromMcpConfig` for the rationale. Tests
 * that don't go through the dispatch core can pass DANXBOT_STOP_URL via
 * env instead; the env value wins when both are present.
 */
async function runCriticalFailureScenario(): Promise<void> {
  const stopUrl =
    process.env.DANXBOT_STOP_URL || readStopUrlFromMcpConfig();
  if (!stopUrl) {
    process.stderr.write(
      "fake-claude critical-failure scenario requires DANXBOT_STOP_URL " +
        "(env or mcpServers.danxbot.env via --mcp-config)\n",
    );
    process.exit(1);
  }

  const summary =
    process.env.FAKE_CLAUDE_CRITICAL_SUMMARY ??
    "MCP Trello tools failed to load";

  // Minimal assistant entry — the launcher's watcher needs at least one
  // entry to confirm the session attached. Without this the inactivity
  // timer would race the danxbot_complete callback in slow CI.
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      content: [
        {
          type: "text",
          text:
            "MCP Trello tools failed to load — signaling critical_failure",
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  await postJson(stopUrl, { status: "critical_failure", summary });

  // Linger so the worker's handleStop has time to write the flag and
  // the watcher's last poll captures the post completion entries
  // before fake-claude exits.
  await sleep(lingerMs);
}

/**
 * "complete-only" scenario: write a couple of assistant entries, then
 * POST `{status, summary}` to DANXBOT_STOP_URL via the danxbot_complete
 * shape. Used by the post-dispatch-check variant where the agent
 * legitimately reports completion but never moves the tracked Trello
 * card — the poller's onComplete check then trips the flag with
 * source="post-dispatch-check".
 */
async function runCompleteOnlyScenario(): Promise<void> {
  const stopUrl =
    process.env.DANXBOT_STOP_URL || readStopUrlFromMcpConfig();
  if (!stopUrl) {
    process.stderr.write(
      "fake-claude complete-only scenario requires DANXBOT_STOP_URL " +
        "(env or mcpServers.danxbot.env via --mcp-config)\n",
    );
    process.exit(1);
  }
  const status = process.env.FAKE_CLAUDE_COMPLETE_STATUS ?? "completed";
  const summary = process.env.FAKE_CLAUDE_COMPLETE_SUMMARY ?? "ok";

  writeEntry({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "Working on it." }],
      usage: { input_tokens: 50, output_tokens: 10 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });
  await sleep(writeDelayMs);
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      content: [{ type: "text", text: summary }],
      usage: { input_tokens: 60, output_tokens: 15 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  await postJson(stopUrl, { status, summary });

  await sleep(lingerMs);
}

/**
 * Drive the Slack agent flow without spending API tokens.
 *
 * Sequence:
 *   1. POST each line of FAKE_CLAUDE_SLACK_UPDATES to DANXBOT_SLACK_UPDATE_URL
 *   2. Optionally splice FAKE_CLAUDE_SLACK_SQL_BLOCK into the final reply
 *      as a ```sql:execute …``` block — this is the K2zQYIdX substitution
 *      regression coverage path.
 *   3. POST the final reply text to DANXBOT_SLACK_REPLY_URL.
 *   4. POST {status, summary} to DANXBOT_STOP_URL via the
 *      `danxbot_complete` MCP shape so the worker finalizes the dispatch
 *      row.
 *
 * Each POST is also written to JSONL as an assistant tool_use + tool_result
 * pair so the SessionLogWatcher sees activity (the heartbeat lifecycle test
 * relies on this — a slack scenario with no JSONL writes between
 * dispatch start and completion looks like an inactivity stall).
 */
async function runSlackScenario(): Promise<void> {
  // All three URLs are required — the slack scenario emulates the full
  // dispatch lifecycle (update + reply + complete) and a missing URL is
  // a misconfiguration in production every bit as bad as a broken MCP
  // server. Empty string explicitly fails the same as undefined so a
  // future caller that passes `DANXBOT_STOP_URL=""` (e.g. shell-quoted
  // expansion of an unset var) gets the same loud error as "undefined".
  const required = ["DANXBOT_SLACK_UPDATE_URL", "DANXBOT_SLACK_REPLY_URL", "DANXBOT_STOP_URL"] as const;
  const missing = required.filter(
    (key) => !process.env[key] || process.env[key] === "",
  );
  if (missing.length > 0) {
    process.stderr.write(
      `fake-claude slack scenario requires ${missing.join(", ")}\n`,
    );
    process.exit(1);
  }
  // Non-null assertions safe — the missing-vars guard above exited the
  // process if any of these were undefined or "".
  const updateUrl = process.env.DANXBOT_SLACK_UPDATE_URL!;
  const replyUrl = process.env.DANXBOT_SLACK_REPLY_URL!;
  const stopUrl = process.env.DANXBOT_STOP_URL!;

  const updatesEnv = process.env.FAKE_CLAUDE_SLACK_UPDATES ?? "";
  const updates = updatesEnv ? updatesEnv.split("\n").filter((s) => s.length > 0) : [];
  const replyText = process.env.FAKE_CLAUDE_SLACK_REPLY ?? "Done.";
  const sqlBlock = process.env.FAKE_CLAUDE_SLACK_SQL_BLOCK;
  const finalStatus = process.env.FAKE_CLAUDE_SLACK_STATUS ?? "completed";

  // Each `post_update` corresponds to one assistant tool_use call in the
  // JSONL — keep the watcher seeing activity.
  for (let i = 0; i < updates.length; i++) {
    const text = updates[i];
    writeEntry({
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: `tool_update_${i + 1}`,
            name: "mcp__danxbot__danxbot_slack_post_update",
            input: { text },
          },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });
    await postJson(updateUrl, { text });
    writeEntry({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: `tool_update_${i + 1}`, content: "ok", is_error: false },
        ],
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });
    await sleep(writeDelayMs);
  }

  const finalText = sqlBlock
    ? `${replyText}\n\n\`\`\`sql:execute\n${sqlBlock}\n\`\`\``
    : replyText;

  // Final reply tool_use → POST → tool_result.
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      content: [
        {
          type: "tool_use",
          id: "tool_reply",
          name: "mcp__danxbot__danxbot_slack_reply",
          input: { text: finalText },
        },
      ],
      usage: { input_tokens: 200, output_tokens: 80 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });
  await postJson(replyUrl, { text: finalText });
  writeEntry({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tool_reply", content: "ok", is_error: false },
      ],
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  // Final completion signal. `danxbot_complete` is what the worker uses
  // to know the dispatch is done — without it the worker would wait for
  // inactivity timeout, which makes free-mode tests slow and brittle.
  const summary = process.env.FAKE_CLAUDE_SLACK_SUMMARY ?? finalText;
  await postJson(stopUrl, { status: finalStatus, summary });

  // Result entry — session complete.
  writeEntry({
    type: "result",
    subtype: finalStatus === "completed" ? "success" : "error",
    cost_usd: 0.0,
    num_turns: updates.length + 1,
    duration_ms: 200,
    duration_api_ms: 100,
    is_error: finalStatus !== "completed",
    result: finalText,
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(lingerMs);
}

/**
 * Drive the YAML-driven Phase 4 lifecycle. The agent (in real life) edits
 * `<repo>/.danxbot/issues/open/<external_id>.yml`, calls `danx_issue_save`,
 * then `danxbot_complete`. fake-claude does the same — but uses ONLY
 * danxbot infrastructure URLs (issue-save, stop). Zero `mcp__trello__*`
 * entries are written to the JSONL — that's the structural assertion this
 * scenario backs.
 *
 * Required env:
 *   FAKE_CLAUDE_YAML_PATH       — Absolute path to the YAML to mutate.
 *   FAKE_CLAUDE_EXTERNAL_ID     — The id passed to `danx_issue_save`.
 *
 * Optional env:
 *   FAKE_CLAUDE_YAML_FINAL_STATUS — `Done` (default), `Needs Help`, or
 *                                   `Cancelled`. Drives the final flip
 *                                   and AC check-off behaviour.
 *   FAKE_CLAUDE_YAML_RETRO_GOOD / _BAD — retro fields written into the
 *                                       final YAML state.
 */
async function runYamlLifecycleScenario(): Promise<void> {
  const issueSaveUrl =
    process.env.DANXBOT_ISSUE_SAVE_URL || readMcpConfigEnv("DANXBOT_ISSUE_SAVE_URL");
  const stopUrl =
    process.env.DANXBOT_STOP_URL || readStopUrlFromMcpConfig();
  const yamlPath = process.env.FAKE_CLAUDE_YAML_PATH;
  const externalId = process.env.FAKE_CLAUDE_EXTERNAL_ID;
  const finalStatus = process.env.FAKE_CLAUDE_YAML_FINAL_STATUS ?? "Done";
  const retroGood =
    process.env.FAKE_CLAUDE_YAML_RETRO_GOOD ?? "Test ran cleanly.";
  const retroBad =
    process.env.FAKE_CLAUDE_YAML_RETRO_BAD ?? "Nothing.";

  if (!issueSaveUrl || !stopUrl || !yamlPath || !externalId) {
    process.stderr.write(
      "fake-claude yaml-lifecycle scenario requires DANXBOT_ISSUE_SAVE_URL, " +
        "DANXBOT_STOP_URL, FAKE_CLAUDE_YAML_PATH, FAKE_CLAUDE_EXTERNAL_ID\n",
    );
    process.exit(1);
  }

  const editAndSave = async (mutate: (yaml: string) => string, toolUseId: string): Promise<void> => {
    const before = readFileSync(yamlPath, "utf-8");
    const after = mutate(before);
    writeFileSync(yamlPath, after);

    writeEntry({
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Edit",
            input: { file_path: yamlPath },
          },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });
    writeEntry({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "ok",
            is_error: false,
          },
        ],
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });

    const saveToolUseId = `${toolUseId}_save`;
    writeEntry({
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: saveToolUseId,
            name: "mcp__danxbot__danx_issue_save",
            input: { id: externalId },
          },
        ],
        usage: { input_tokens: 60, output_tokens: 15 },
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });

    const res = await fetch(issueSaveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: externalId }),
    });
    const body = await res.text();

    writeEntry({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: saveToolUseId,
            content: body,
            is_error: !res.ok,
          },
        ],
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });

    await sleep(writeDelayMs);
  };

  // 1. Flip status (ToDo OR Needs Help) → In Progress.
  //
  // The `^status: ` anchor relies on `serializeIssue`'s canonical key
  // order placing the top-level `status` field before the nested
  // `triaged.status` (which is indented two spaces and would not match
  // the multiline-mode line-start anchor). Verified against
  // `src/issue-tracker/yaml.ts#serializeIssue`. If a future schema
  // refactor reorders keys or changes indentation, switch to a YAML
  // round-trip via `parseIssue` + `serializeIssue` here.
  await editAndSave(
    (yaml) => yaml.replace(/^status: .*/m, "status: In Progress"),
    "tool_yaml_claim",
  );

  // 2. Do "implementation work". Apply the final state in one edit:
  //    - status → finalStatus
  //    - all ac items → checked: true (only when moving to Done)
  //    - retro.good / retro.bad populated (`JSON.stringify` produces
  //      a quoted YAML string, which `parseIssue` accepts the same as
  //      the unquoted form `serializeIssue` emits canonically)
  await editAndSave((yaml) => {
    let next = yaml.replace(/^status: .*/m, `status: ${finalStatus}`);
    if (finalStatus === "Done") {
      next = next.replace(/checked: false/g, "checked: true");
    }
    next = next.replace(/^  good: .*/m, `  good: ${JSON.stringify(retroGood)}`);
    next = next.replace(/^  bad: .*/m, `  bad: ${JSON.stringify(retroBad)}`);
    return next;
  }, "tool_yaml_finalize");

  // 3. Signal completion.
  await postJson(stopUrl, {
    status: finalStatus === "Cancelled" ? "failed" : "completed",
    summary: `YAML lifecycle: ${externalId} → ${finalStatus}`,
  });

  // Result entry — session complete.
  writeEntry({
    type: "result",
    subtype: "success",
    cost_usd: 0.0,
    num_turns: 3,
    duration_ms: 200,
    duration_api_ms: 100,
    is_error: false,
    result: `YAML lifecycle complete: ${externalId} → ${finalStatus}`,
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(lingerMs);
}

async function runScenario(): Promise<void> {
  const now = new Date().toISOString();

  // Write the user message (contains the dispatch tag — watcher scans for this)
  writeEntry({
    type: "user",
    message: { content: prompt },
    timestamp: now,
    sessionId,
  });

  await sleep(writeDelayMs);

  if (scenario === "empty") {
    // No assistant messages — just exit
    return;
  }

  if (scenario === "slack") {
    await runSlackScenario();
    return;
  }

  if (scenario === "critical-failure") {
    await runCriticalFailureScenario();
    return;
  }

  if (scenario === "complete-only") {
    await runCompleteOnlyScenario();
    return;
  }

  if (scenario === "yaml-lifecycle") {
    await runYamlLifecycleScenario();
    return;
  }

  if (scenario === "dup-msg-id") {
    // Reproduces Claude Code's multi-block-per-turn JSONL split: ONE API
    // response carrying both a text block and a tool_use block is written
    // as TWO assistant entries sharing the SAME `message.id`, each with
    // the IDENTICAL response-level `usage`. Without dedup the accumulator
    // and dashboard total this turn 2×.
    const sharedMsgId = "msg_FAKE_DUP_TURN";
    const sharedUsage = {
      input_tokens: 6,
      output_tokens: 110,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_362,
    };
    writeEntry({
      type: "assistant",
      message: {
        id: sharedMsgId,
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "PONG" }],
        usage: sharedUsage,
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });
    await sleep(writeDelayMs);
    writeEntry({
      type: "assistant",
      message: {
        id: sharedMsgId,
        model: "claude-opus-4-7",
        content: [
          { type: "tool_use", id: "tool_dup_1", name: "Read", input: {} },
        ],
        usage: sharedUsage,
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });
    await sleep(writeDelayMs);
    writeEntry({
      type: "result",
      subtype: "success",
      cost_usd: 0,
      num_turns: 1,
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      result: "PONG",
      timestamp: new Date().toISOString(),
      sessionId,
    });
    await sleep(lingerMs);
    return;
  }

  // First assistant message — watcher synthesizes init from this
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "I'll help you with that task." },
        { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/test/file.ts" } },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  // Tool result
  writeEntry({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tool_1", content: "file contents here", is_error: false },
      ],
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  if (scenario === "slow") {
    // Simulate a slow agent — write one message then go quiet
    // The inactivity timer should fire
    writeEntry({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Let me think about this..." }],
        usage: { input_tokens: 150, output_tokens: 20 },
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });

    // Stay alive but silent — keep the event loop running so the process
    // doesn't exit. The parent kills us via inactivity timeout (SIGTERM) or
    // cancelJob (SIGTERM then SIGKILL). We do NOT handle SIGTERM here so the
    // default behavior (exit with signal) fires, matching real claude behavior
    // where SIGTERM causes a non-zero exit.
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
    return;
  }

  if (scenario === "error") {
    // Write a result entry indicating error, then linger + exit with non-zero
    writeEntry({
      type: "result",
      subtype: "error",
      cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: true,
      result: "Agent encountered an error",
      timestamp: new Date().toISOString(),
      sessionId,
    });

    // Linger so SessionLogWatcher can discover and poll the file
    await sleep(lingerMs);
    process.exit(exitCode || 1);
    return;
  }

  // Happy path — second assistant message (final answer)
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Task completed successfully. Here are the results." }],
      usage: { input_tokens: 200, output_tokens: 80 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  // Result entry — session complete
  writeEntry({
    type: "result",
    subtype: "success",
    cost_usd: 0.05,
    num_turns: 2,
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    result: "Task completed successfully. Here are the results.",
    timestamp: new Date().toISOString(),
    sessionId,
  });

  // Linger so SessionLogWatcher can discover and poll the file before process exits.
  // In production, agents run for minutes; in tests, this simulates that buffer.
  await sleep(lingerMs);
}

runScenario()
  .then(() => {
    process.exit(exitCode);
  })
  .catch((err) => {
    process.stderr.write(`fake-claude error: ${err}\n`);
    process.exit(1);
  });
