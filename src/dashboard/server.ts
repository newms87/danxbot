import { createServer } from "http";
import { readFile } from "fs/promises";
import { getEvents, getAnalytics, addSSEClient, removeSSEClient } from "./events.js";
import { eventsToCSV } from "./export.js";
import { getHealthStatus } from "./health.js";

const PORT = 5555;

export async function startDashboard(): Promise<void> {
  const htmlPath = new URL("./index.html", import.meta.url);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/health") {
      const health = getHealthStatus();
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
      res.end(JSON.stringify({
        id: event.id,
        text: event.text,
        status: event.status,
        agentLog: event.agentLog,
      }, null, 2));
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
          "Content-Disposition": 'attachment; filename="flytebot-events.json"',
        });
        res.end(body);
        return;
      }
      if (format === "csv") {
        const body = eventsToCSV(getEvents());
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="flytebot-events.csv"',
        });
        res.end(body);
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid format parameter. Use "json" or "csv".' }));
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

    // Serve the dashboard HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache, no-store, must-revalidate" });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
}
