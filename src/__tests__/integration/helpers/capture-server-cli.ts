#!/usr/bin/env npx tsx
/**
 * Capture Server CLI — Standalone HTTP server for shell-based system tests.
 *
 * Wraps the CaptureServer class as a CLI entrypoint. Starts on a given port,
 * prints the assigned port to stdout, and writes captured requests (including
 * headers) to a JSON file on SIGTERM/SIGINT.
 *
 * Usage:
 *   npx tsx src/__tests__/integration/helpers/capture-server-cli.ts [--port PORT] [--output PATH]
 *
 * Options:
 *   --port PORT     Listen on a specific port (default: 0 = random)
 *   --output PATH   Write captured requests to this file on exit (default: /tmp/danxbot-capture-<pid>.json)
 */

import { writeFileSync } from "node:fs";
import { CaptureServer } from "./capture-server.js";

function parseArgs(): { port: number; output: string } {
  const args = process.argv.slice(2);
  let port = 0;
  let output = `/tmp/danxbot-capture-${process.pid}.json`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
        console.error(`Invalid port: ${args[i + 1]}`);
        process.exit(1);
      }
      port = parsed;
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  return { port, output };
}

const { port, output } = parseArgs();
const server = new CaptureServer();

server.start(port).then(() => {
  // Extract port from baseUrl since CaptureServer doesn't expose port directly
  const assignedPort = new URL(server.baseUrl).port;
  console.log(assignedPort);
});

function shutdown(): void {
  writeFileSync(output, JSON.stringify(server.getRequests(), null, 2));
  server.stop().then(() => process.exit(0));
  // Force exit after 2s if close hangs
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
