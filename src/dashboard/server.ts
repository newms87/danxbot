import { createServer } from "http";
import { readFile } from "fs/promises";
import { getEvents, getAnalytics, addSSEClient, removeSSEClient } from "./events.js";

const PORT = 5555;

export async function startDashboard(): Promise<void> {
  const htmlPath = new URL("./index.html", import.meta.url);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getEvents()));
      return;
    }

    if (url.pathname === "/api/analytics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getAnalytics()));
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
      res.writeHead(200, { "Content-Type": "text/html" });
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
