/**
 * Capture Server — Minimal HTTP server that records all incoming requests.
 *
 * Used by integration tests to verify heartbeat PUTs, event POSTs, and status
 * updates without needing a real Laravel API or external service.
 *
 * Listens on a random available port (port 0). Responds 200 to all PUT/POST.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  timestamp: number;
}

export class CaptureServer {
  private server: Server | null = null;
  private requests: CapturedRequest[] = [];
  private port = 0;

  /** Start the server on a given port (0 = random available port). */
  async start(listenPort = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          this.requests.push({
            method: req.method || "GET",
            path: req.url || "/",
            headers: req.headers,
            body,
            timestamp: Date.now(),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      this.server.on("error", reject);
      this.server.listen(listenPort, () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr !== null) {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  /** Stop the server and close all connections. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /** Get all captured requests. */
  getRequests(): CapturedRequest[] {
    return this.requests;
  }

  /** Get captured requests filtered by method. */
  getRequestsByMethod(method: string): CapturedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  /** Get captured requests filtered by path prefix. */
  getRequestsByPath(pathPrefix: string): CapturedRequest[] {
    return this.requests.filter((r) => r.path.startsWith(pathPrefix));
  }

  /** Clear all captured requests. */
  clear(): void {
    this.requests = [];
  }

  /** Get the base URL of the running server. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Get the status URL pattern used by dispatch (baseUrl + /status). */
  get statusUrl(): string {
    return `${this.baseUrl}/status`;
  }

}
