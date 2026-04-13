import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { parseJsonResponse } from "./parse-json-response.js";

// --- Helpers ---

function makeResponse(
  ...texts: string[]
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: texts.map((text) => ({
      type: "text" as const,
      text,
      citations: null,
    })),
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

describe("parseJsonResponse", () => {
  it("parses clean JSON from a single text block", () => {
    const response = makeResponse('{"key": "value", "count": 42}');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value", count: 42 });
  });

  it("strips code fences and parses JSON", () => {
    const response = makeResponse('```json\n{"key": "value"}\n```');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });

  it("strips code fences without trailing newline", () => {
    const response = makeResponse('```json\n{"key": "value"}```');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });

  it("joins text from multiple text blocks before parsing", () => {
    const response = makeResponse('{"key":', ' "value"}');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });

  it("throws SyntaxError for malformed JSON", () => {
    const response = makeResponse("this is not json at all");

    expect(() => parseJsonResponse(response)).toThrow(SyntaxError);
  });

  it("throws for empty content array (no text blocks)", () => {
    const response: Anthropic.Messages.Message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
      },
    };

    expect(() => parseJsonResponse(response)).toThrow();
  });

  it("filters out non-text blocks (tool_use)", () => {
    const response: Anthropic.Messages.Message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Read",
          input: { file_path: "/src/index.ts" },
        },
        { type: "text", text: '{"key": "value"}', citations: null },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
      },
    };

    const result = parseJsonResponse(response);
    expect(result).toEqual({ key: "value" });
  });

  it("handles nested JSON objects", () => {
    const response = makeResponse(
      '{"outer": {"inner": "deep"}, "list": [1, 2, 3]}',
    );
    const result = parseJsonResponse(response);

    expect(result).toEqual({ outer: { inner: "deep" }, list: [1, 2, 3] });
  });

  it("handles whitespace around JSON", () => {
    const response = makeResponse('  \n  {"key": "value"}  \n  ');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });

  it("strips bare code fences (no language tag)", () => {
    const response = makeResponse('```\n{"key": "value"}\n```');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });

  it("strips code fences with arbitrary language tags", () => {
    const response = makeResponse('```text\n{"key": "value"}\n```');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });

  it("strips closing code fence mid-text (not just end of string)", () => {
    const response = makeResponse('```json\n{"key": "value"}\n```\n');
    const result = parseJsonResponse(response);

    expect(result).toEqual({ key: "value" });
  });
});
