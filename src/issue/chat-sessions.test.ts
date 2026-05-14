/**
 * DX-351 — Per-card chat session storage.
 *
 * Persists `{dispatch_id, updated_at}` per `<PREFIX>-N` at
 * `<repoRoot>/.danxbot/chat-sessions/<id>.json`. The chat route reads the
 * record on every POST: if absent, dispatch fresh; if present, resume the
 * named dispatch. Survives worker restarts via plain disk state — no DB
 * column, no schema migration.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  chatSessionPath,
  readChatSession,
  writeChatSession,
} from "./chat-sessions.js";

function makeRepoRoot(): string {
  return mkdtempSync(resolve(tmpdir(), "chat-sessions-"));
}

describe("chatSessionPath", () => {
  it("returns <repoRoot>/.danxbot/chat-sessions/<id>.json", () => {
    expect(chatSessionPath("/tmp/repo", "DX-351")).toBe(
      "/tmp/repo/.danxbot/chat-sessions/DX-351.json",
    );
  });

  it("rejects ids that are not <PREFIX>-N shape", () => {
    expect(() => chatSessionPath("/tmp/repo", "not-an-id")).toThrow(
      /Invalid issue id/,
    );
    expect(() => chatSessionPath("/tmp/repo", "DX351")).toThrow(/Invalid issue id/);
    expect(() => chatSessionPath("/tmp/repo", "dx-351")).toThrow(/Invalid issue id/);
    expect(() => chatSessionPath("/tmp/repo", "DX-")).toThrow(/Invalid issue id/);
    expect(() => chatSessionPath("/tmp/repo", "DX-3.5")).toThrow(/Invalid issue id/);
    expect(() => chatSessionPath("/tmp/repo", "")).toThrow(/Invalid issue id/);
  });
});

describe("readChatSession", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = makeRepoRoot();
  });

  it("returns null when the record file does not exist", async () => {
    expect(await readChatSession(repoRoot, "DX-351")).toBeNull();
  });

  it("returns the parsed record when the file exists", async () => {
    const path = chatSessionPath(repoRoot, "DX-351");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        dispatch_id: "job-abc",
        updated_at: "2026-05-14T07:00:00.000Z",
      }),
      "utf-8",
    );
    const record = await readChatSession(repoRoot, "DX-351");
    expect(record).toEqual({
      dispatch_id: "job-abc",
      updated_at: "2026-05-14T07:00:00.000Z",
    });
  });

  it("returns null when the record file is malformed JSON", async () => {
    const path = chatSessionPath(repoRoot, "DX-351");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "{not json", "utf-8");
    expect(await readChatSession(repoRoot, "DX-351")).toBeNull();
  });

  it("returns null when the record is missing a required field", async () => {
    const path = chatSessionPath(repoRoot, "DX-351");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ dispatch_id: "job-abc" }), "utf-8");
    expect(await readChatSession(repoRoot, "DX-351")).toBeNull();
  });

  it("rejects malformed issue id BEFORE reading", async () => {
    await expect(readChatSession(repoRoot, "not-an-id")).rejects.toThrow(
      /Invalid issue id/,
    );
  });
});

describe("writeChatSession", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = makeRepoRoot();
  });

  it("creates the chat-sessions dir on first write", async () => {
    await writeChatSession(repoRoot, "DX-351", "job-abc");
    const path = chatSessionPath(repoRoot, "DX-351");
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text);
    expect(parsed.dispatch_id).toBe("job-abc");
    expect(parsed.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("overwrites a prior record with the new dispatch id and timestamp", async () => {
    await writeChatSession(repoRoot, "DX-351", "job-1");
    await writeChatSession(repoRoot, "DX-351", "job-2");
    const record = await readChatSession(repoRoot, "DX-351");
    expect(record?.dispatch_id).toBe("job-2");
  });

  it("round-trips across separate read/write calls (survives worker restart)", async () => {
    await writeChatSession(repoRoot, "DX-351", "job-roundtrip");
    const record = await readChatSession(repoRoot, "DX-351");
    expect(record).not.toBeNull();
    expect(record?.dispatch_id).toBe("job-roundtrip");
    expect(typeof record?.updated_at).toBe("string");
  });

  it("never leaves a .tmp residue when the write succeeds", async () => {
    await writeChatSession(repoRoot, "DX-351", "job-abc");
    const dir = resolve(repoRoot, ".danxbot", "chat-sessions");
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("rejects malformed issue id BEFORE writing", async () => {
    await expect(
      writeChatSession(repoRoot, "not-an-id", "job-abc"),
    ).rejects.toThrow(/Invalid issue id/);
  });

  it("rejects empty / whitespace dispatch_id", async () => {
    await expect(writeChatSession(repoRoot, "DX-351", "")).rejects.toThrow(
      /dispatch_id/,
    );
    await expect(writeChatSession(repoRoot, "DX-351", "  ")).rejects.toThrow(
      /dispatch_id/,
    );
  });
});
