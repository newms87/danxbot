/**
 * McpServerProbe — Pre-launch verification that an MCP server can actually start
 * before Claude Code is spawned against it.
 *
 * Claude Code launches successfully even when a configured MCP server crashes
 * on startup — the agent silently loses that server's tools. When the failure
 * is a missing env var / bad config, the only symptom is "my tools aren't
 * there," which the agent may notice minutes later (after burning prompt
 * tokens) or may never notice at all.
 *
 * This probe spawns each MCP server the same way Claude would, sends a minimal
 * JSON-RPC `initialize` request, and waits up to `timeoutMs` for a `result`
 * frame on stdout. Four failure shapes are distinguished so the caller can
 * tell the user exactly what went wrong:
 *
 *   - reason="exit"     — child exited non-zero before responding, or was
 *                         killed by a signal (exitCode=null in that case).
 *                         Catches missing env var / missing dep / bad command.
 *   - reason="timeout"  — child stayed alive but never responded in time
 *                         (hanging server)
 *   - reason="protocol" — child responded with a JSON-RPC error, emitted
 *                         non-JSON output, or violated the initialize schema
 *                         (bad server code)
 *
 * All three modes capture stderr so the dispatch error message can surface
 * the actual root cause. See `.claude/rules/code-quality.md` "fallbacks are
 * bugs" — this exists precisely to avoid handing a broken environment to an
 * agent and pretending everything is fine.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createLogger } from "../logger.js";
import type { McpServerConfig, McpSettingsFile } from "./mcp-settings-shape.js";

export type { McpServerConfig } from "./mcp-settings-shape.js";

const log = createLogger("mcp-probe");

/**
 * Threshold above which a probe is considered slow enough to warrant an
 * explicit "still probing" progress log. Keeps routine probes quiet while
 * making cold-install waits visible to operators tailing logs. See the
 * `mcpProbeTimeoutMs` rationale in `src/config.ts`.
 */
const SLOW_PROBE_LOG_THRESHOLD_MS = 3_000;

export interface ProbeSuccess {
  ok: true;
  serverName: string;
}

export interface ProbeFailure {
  ok: false;
  serverName: string;
  reason: "exit" | "timeout" | "protocol";
  /**
   * Process exit code. `null` means the child was killed by a signal rather
   * than exiting cleanly — reporting 0 here would be a lie (0 = success).
   */
  exitCode?: number | null;
  stderr: string;
  message: string;
}

export type ProbeResult = ProbeSuccess | ProbeFailure;

export interface ProbeAllResult {
  ok: boolean;
  failures: ProbeFailure[];
}

const JSON_RPC_INIT_ID = 1;

/**
 * Extract the first non-empty line of a stderr buffer for inclusion in error
 * messages. Empty stderr returns an empty string — callers should guard.
 */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Compose the human-readable message attached to a failure. The serverName
 * is always first so the operator sees which server broke without scanning
 * the rest of the text. `detailOverride` is used by the protocol/malformed-
 * JSON branches to inject their own hint text without overloading the stderr
 * parameter's meaning — callers that want the default stderr behavior leave
 * it undefined.
 */
function buildFailureMessage(
  serverName: string,
  reason: ProbeFailure["reason"],
  stderr: string,
  exitCode: number | null | undefined,
  detailOverride?: string,
): string {
  const detailSource = detailOverride ?? firstNonEmptyLine(stderr);
  const detail = detailSource ? `: ${detailSource}` : "";

  switch (reason) {
    case "exit": {
      const code =
        exitCode === null
          ? "a signal"
          : exitCode === undefined
            ? "nonzero"
            : String(exitCode);
      return `MCP server "${serverName}" exited with code ${code} before responding${detail}`;
    }
    case "timeout":
      return `MCP server "${serverName}" timeout: no response to initialize${detail}`;
    case "protocol":
      return `MCP server "${serverName}" protocol error${detail}`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Probe a single MCP server. Spawns it, sends an `initialize` JSON-RPC
 * request, waits for a result frame, kills the process, returns the outcome.
 *
 * Always cleans up the child process — success or failure. On timeout, sends
 * SIGKILL directly because a hanging server has already proven it won't react
 * to polite signals.
 */
export async function probeMcpServer(
  serverName: string,
  cfg: McpServerConfig,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(cfg.command, cfg.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...cfg.env },
    });

    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // Fires once if the probe is still unresolved after the slow-log
    // threshold — surfaces cold `npx -y` installs (and network stalls) to
    // operators tailing logs instead of silently eating minutes.
    const slowLogHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      log.info(
        `[${serverName}] still probing after ${SLOW_PROBE_LOG_THRESHOLD_MS}ms — likely installing package via npx`,
      );
    }, SLOW_PROBE_LOG_THRESHOLD_MS);

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      clearTimeout(slowLogHandle);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok) {
        log.info(`[${serverName}] probe OK in ${elapsedMs}ms`);
      } else {
        log.warn(
          `[${serverName}] probe FAILED in ${elapsedMs}ms (reason=${result.reason})`,
        );
      }
      // SIGKILL because a stuck server may ignore SIGTERM and we've already
      // decided it failed — we don't care about graceful shutdown here.
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may already be dead; ignore.
      }
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        serverName,
        reason: "exit",
        stderr: stderr || String(err),
        message: `MCP server "${serverName}" failed to spawn: ${err.message}`,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();

      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish({
            ok: false,
            serverName,
            reason: "protocol",
            stderr,
            message: buildFailureMessage(
              serverName,
              "protocol",
              stderr,
              undefined,
              `malformed JSON from server: ${line.slice(0, 120)}`,
            ),
          });
          return;
        }

        // JSON-RPC permits numeric or string ids. Coerce to Number so a
        // stringy "1" doesn't cause the probe to ignore a valid response
        // and time out — the contract with our own initialize request is
        // "use whatever id we sent," and we sent the number 1.
        if (Number(parsed.id) !== JSON_RPC_INIT_ID) continue;

        if (parsed.error) {
          const err = parsed.error as { message?: string };
          finish({
            ok: false,
            serverName,
            reason: "protocol",
            stderr,
            message: buildFailureMessage(
              serverName,
              "protocol",
              stderr,
              undefined,
              err.message ?? firstNonEmptyLine(stderr),
            ),
          });
          return;
        }

        if (parsed.result) {
          finish({ ok: true, serverName });
          return;
        }
      }
    });

    child.on("exit", (code) => {
      if (settled) return;
      finish({
        ok: false,
        serverName,
        reason: "exit",
        exitCode: code,
        stderr,
        message: buildFailureMessage(serverName, "exit", stderr, code),
      });
    });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      finish({
        ok: false,
        serverName,
        reason: "timeout",
        stderr,
        message: buildFailureMessage(serverName, "timeout", stderr, undefined),
      });
    }, timeoutMs);

    const initRequest =
      JSON.stringify({
        jsonrpc: "2.0",
        id: JSON_RPC_INIT_ID,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "danxbot-probe", version: "1.0" },
        },
      }) + "\n";

    child.stdin?.write(initRequest, (err) => {
      if (err && !settled) {
        finish({
          ok: false,
          serverName,
          reason: "exit",
          stderr,
          message: `MCP server "${serverName}" stdin write failed: ${err.message}`,
        });
      }
    });
  });
}

/**
 * Read an `mcpServers` map from a Claude Code settings file and probe every
 * configured server in parallel. Returns the aggregated outcome.
 *
 * Throws (rather than returning `ok: true`) when the settings file has no
 * `mcpServers` key, or the key is present but empty. The caller is expected
 * to have built a settings file with at least one server — an empty map is a
 * bug upstream, not a state the probe should silently paper over.
 *
 * Callers (spawnAgent) should throw when `ok` is false so the dispatch fails
 * loudly with a clear error instead of handing a broken environment to the
 * agent.
 */
export async function probeAllMcpServers(
  settingsPath: string,
  timeoutMs: number,
): Promise<ProbeAllResult> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read MCP settings file "${settingsPath}": ${(err as Error).message}`,
    );
  }

  const parsed = JSON.parse(raw) as Partial<McpSettingsFile>;

  if (!parsed.mcpServers) {
    throw new Error(
      `MCP settings file "${settingsPath}" has no "mcpServers" key — probeAllMcpServers called on a file with nothing to probe`,
    );
  }

  const entries = Object.entries(parsed.mcpServers);
  if (entries.length === 0) {
    throw new Error(
      `MCP settings file "${settingsPath}" contains an empty "mcpServers" map — probeAllMcpServers called on a file with nothing to probe`,
    );
  }

  const results = await Promise.all(
    entries.map(([name, cfg]) => probeMcpServer(name, cfg, timeoutMs)),
  );

  const failures = results.filter((r): r is ProbeFailure => !r.ok);

  return {
    ok: failures.length === 0,
    failures,
  };
}
