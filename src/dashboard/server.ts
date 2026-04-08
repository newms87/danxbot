import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile, access } from "fs/promises";
import {
  getEvents,
  getAnalytics,
  addSSEClient,
  removeSSEClient,
} from "./events.js";
import { eventsToCSV } from "./export.js";
import { getHealthStatus } from "./health.js";
import { createLogger } from "../logger.js";
import { config } from "../config.js";
import {
  launchAgent,
  cancelJob,
  getJobStatus,
  buildMcpSettings,
  type AgentJob,
} from "../agent/launcher.js";
import { spawnInTerminal, buildDispatchScript } from "../terminal.js";
import { getReposBase } from "../poller/constants.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const log = createLogger("dashboard");

const PORT = parseInt(process.env.DASHBOARD_PORT || "5555", 10);

/** Active dispatch jobs indexed by job ID */
const activeJobs = new Map<string, AgentJob>();

/** Parse JSON body from request */
async function parseBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Send JSON response */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

// Resolve dashboard dist directory (relative to project root, works with tsx)
const distDir = new URL("../../dashboard/dist", import.meta.url);

export async function startDashboard(): Promise<void> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/health") {
      const health = await getHealthStatus();
      const statusCode = health.status === "ok" ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getEvents()));
      return;
    }

    // Detailed log for a single event: /api/events/:id/log
    const logMatch = url.pathname.match(/^\/api\/events\/(.+)\/log$/);
    if (logMatch) {
      const event = getEvents().find((e) => e.id === logMatch[1]);
      if (!event) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Event not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            id: event.id,
            text: event.text,
            status: event.status,
            agentLog: event.agentLog,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (url.pathname === "/api/analytics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getAnalytics()));
      return;
    }

    if (url.pathname === "/api/events/export") {
      const format = url.searchParams.get("format");
      if (format === "json") {
        const body = JSON.stringify(getEvents(), null, 2);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="danxbot-events.json"',
        });
        res.end(body);
        return;
      }
      if (format === "csv") {
        const body = eventsToCSV(getEvents());
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="danxbot-events.csv"',
        });
        res.end(body);
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: 'Missing or invalid format parameter. Use "json" or "csv".',
        }),
      );
      return;
    }

    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const client = (data: string) => {
        res.write(`data: ${data}\n\n`);
      };

      addSSEClient(client);
      req.on("close", () => removeSSEClient(client));
      return;
    }

    // --- Dispatch API (for remote agent launches from GPT Manager) ---

    const method = req.method?.toUpperCase() || "GET";

    if (method === "POST" && url.pathname === "/api/launch") {
      try {
        const body = await parseBody(req);
        const task = body.task as string;
        const agents = body.agents as
          | Array<Record<string, unknown>>
          | undefined;
        const apiToken = body.api_token as string;
        const apiUrl =
          (body.api_url as string) || config.dispatch.defaultApiUrl;
        const statusUrl = body.status_url as string | undefined;
        const schemaDefinitionId = body.schema_definition_id as
          | string
          | undefined;

        if (!task || !apiToken) {
          json(res, 400, { error: "Missing required fields: task, api_token" });
          return;
        }

        const maxRuntimeMs = body.max_runtime_ms as number | undefined;
        const schemaRole = body.schema_role as string | undefined;

        const launchOptions = {
          task,
          agents,
          apiToken,
          apiUrl,
          statusUrl,
          schemaDefinitionId,
          schemaRole,
          timeout: config.dispatch.agentTimeoutMs,
          maxRuntimeMs,
        };

        if (config.isHost) {
          // Interactive mode: open in a Windows Terminal tab (same as poller)
          const jobId = randomUUID();
          const settingsDir = buildMcpSettings(launchOptions);

          const promptFile = join(settingsDir, "prompt.md");
          writeFileSync(promptFile, task);

          let agentsFile: string | undefined;
          if (agents && agents.length > 0) {
            agentsFile = join(settingsDir, "agents.json");
            writeFileSync(agentsFile, JSON.stringify(agents));
          }

          // Write debug logs
          const logDir = join(config.logsDir, jobId);
          try {
            mkdirSync(logDir, { recursive: true });
            writeFileSync(join(logDir, "prompt.md"), task);
          } catch {}

          const scriptPath = buildDispatchScript(settingsDir, {
            promptFile,
            mcpConfigPath: join(settingsDir, "settings.json"),
            agentsFile,
            statusUrl,
            apiToken,
          });

          // Resolve agent working directory — fail loudly if not configured
          const repoName = (process.env.REPOS || "")
            .split(",")[0]
            .split(":")[0]
            .trim();
          if (!repoName) {
            json(res, 500, {
              error:
                "REPOS env var is not configured — cannot determine agent working directory",
            });
            return;
          }
          const agentCwd = join(getReposBase(), repoName);

          spawnInTerminal({
            title: `Schema Agent ${jobId.substring(0, 8)}`,
            script: scriptPath,
            cwd: agentCwd,
          });

          json(res, 200, { job_id: jobId, status: "launched" });
        } else {
          // Piped mode: stream-json with heartbeats and status tracking
          const job = await launchAgent(launchOptions);

          activeJobs.set(job.id, job);

          // Clean up completed jobs after 1 hour
          const cleanupInterval = setInterval(() => {
            if (
              job.status !== "running" &&
              Date.now() - (job.completedAt?.getTime() || 0) > 3600000
            ) {
              activeJobs.delete(job.id);
              clearInterval(cleanupInterval);
            }
          }, 60000);

          json(res, 200, { job_id: job.id, status: "launched" });
        }
      } catch (err) {
        log.error("Launch failed", err);
        json(res, 500, {
          error: err instanceof Error ? err.message : "Launch failed",
        });
      }
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/cancel\/(.+)$/);
    if (method === "POST" && cancelMatch) {
      const jobId = cancelMatch[1];
      const job = activeJobs.get(jobId);
      if (!job) {
        json(res, 404, { error: "Job not found" });
        return;
      }
      if (job.status !== "running") {
        json(res, 409, { error: `Job is not running (status: ${job.status})` });
        return;
      }
      const body = await parseBody(req);
      await cancelJob(job, (body.api_token as string) || "");
      json(res, 200, { status: "canceled" });
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/status\/(.+)$/);
    if (method === "GET" && statusMatch) {
      const jobId = statusMatch[1];
      const job = activeJobs.get(jobId);
      if (!job) {
        json(res, 404, { error: "Job not found" });
        return;
      }
      json(res, 200, getJobStatus(job));
      return;
    }

    // --- End Dispatch API ---

    // Serve static assets from dashboard/dist/
    if (url.pathname.startsWith("/assets/")) {
      const filePath = new URL("." + url.pathname, distDir + "/");
      try {
        await access(filePath);
        const content = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": getMimeType(url.pathname),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(content);
        return;
      } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    // SPA fallback: serve index.html for all non-API routes
    const indexPath = new URL("./index.html", distDir + "/");
    try {
      const html = await readFile(indexPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Dashboard not built. Run: cd dashboard && npm run build");
    }
  });

  server.listen(PORT, () => {
    log.info(`Dashboard running at http://localhost:${PORT}`);
  });
}
