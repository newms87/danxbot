import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "fs/promises";
import { config } from "../config.js";
import type { AgentResponse, RouterResult } from "../types.js";

let systemPrompt: string | null = null;

async function getSystemPrompt(): Promise<string> {
  if (!systemPrompt) {
    systemPrompt = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
  }
  return systemPrompt;
}

/**
 * Router: the entrypoint for every message. Always produces a quick response,
 * then decides whether the full Claude Code agent needs to be invoked for
 * deeper codebase/database exploration.
 */
export async function runRouter(messageText: string): Promise<RouterResult> {
  try {
    const conversation = query({
      prompt: messageText,
      options: {
        model: "claude-haiku-4-5",
        systemPrompt: [
          "You are Flytebot, a friendly assistant for the Flytedesk engineering team.",
          "You live in a dedicated Slack channel. Every message is directed at you.",
          "",
          "Respond with JSON:",
          "{\"quickResponse\": \"...\", \"needsAgent\": true/false, \"reason\": \"...\"}",
          "",
          "quickResponse: A short, friendly reply to the user. For greetings, greet them back.",
          "For questions, acknowledge the question and say you're looking into it.",
          "Keep it to 1-2 sentences. Be warm and helpful.",
          "Always encourage the user to ask questions about the platform or its data.",
          "",
          "needsAgent: true if the user is asking something that requires exploring the",
          "codebase, querying the database, or deep platform knowledge. false if your",
          "quickResponse fully handles it (greetings, small talk, simple acknowledgments).",
          "",
          "reason: Brief explanation of your routing decision.",
        ].join("\n"),
        maxTurns: 1,
        permissionMode: "acceptEdits",
      },
    });

    for await (const message of conversation) {
      if (message.type === "result" && message.subtype === "success") {
        const jsonStr = message.result.replace(/```json\s*\n?/g, "").replace(/```\s*$/g, "").trim();
        const parsed = JSON.parse(jsonStr);
        return {
          quickResponse: parsed.quickResponse || "",
          needsAgent: parsed.needsAgent === true,
          reason: parsed.reason || "",
        };
      }
    }
  } catch (error) {
    console.error("Router error:", error);
  }

  return { quickResponse: "", needsAgent: false, reason: "router error" };
}

/**
 * Runs the main Claude Code agent to answer a platform question.
 * Optionally resumes a previous session for thread continuity.
 */
export async function runAgent(
  messageText: string,
  sessionId: string | null,
): Promise<AgentResponse> {
  const prompt = await getSystemPrompt();

  const conversation = query({
    prompt: messageText,
    options: {
      model: config.agent.model,
      systemPrompt: prompt,
      cwd: config.platform.repoPath,
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      maxTurns: config.agent.maxTurns,
      maxBudgetUsd: config.agent.maxBudgetUsd,
      permissionMode: "acceptEdits",
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  let resultText = "";
  let resultSessionId: string | null = null;
  let costUsd = 0;
  let turns = 0;

  for await (const message of conversation) {
    if (message.type === "system" && message.subtype === "init") {
      resultSessionId = message.session_id;
    }

    if (message.type === "result") {
      costUsd = message.total_cost_usd;
      turns = message.num_turns;

      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        resultText = `I ran into an issue while researching your question: ${message.subtype}. ${(message as any).errors?.join(", ") || ""}`.trim();
      }
    }
  }

  if (!resultText) {
    resultText = "I wasn't able to generate a response. Please try again.";
  }

  return {
    text: resultText,
    sessionId: resultSessionId,
    costUsd,
    turns,
  };
}
