import http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MAX_TIMEOUT_MS = 30_000;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  return browser;
}

interface ScreenshotRequest {
  url: string;
  width?: number;
  height?: number;
  waitForSelector?: string;
  format?: "jpeg" | "png";
  quality?: number;
  trim?: boolean;
  padding?: number;
  timeout?: number;
}

/**
 * Trim whitespace from an image buffer using sharp.
 * Detects the bounding box of non-white content, crops to it,
 * and optionally adds uniform white padding.
 */
async function trimImage(
  imageBuffer: Buffer,
  padding: number | undefined,
  format: "jpeg" | "png",
  quality: number,
): Promise<Buffer> {
  // sharp trim() removes uniform borders automatically
  let pipeline = sharp(imageBuffer).trim({ threshold: 10 });

  if (padding && padding > 0) {
    pipeline = pipeline.extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  }

  if (format === "png") {
    return pipeline.png().toBuffer();
  }
  return pipeline.jpeg({ quality }).toBuffer();
}

async function captureScreenshot(params: ScreenshotRequest): Promise<Buffer> {
  const {
    url,
    width = 1024,
    height = 16000,
    waitForSelector,
    format = "jpeg",
    quality = 85,
    trim: shouldTrim = true,
    padding,
    timeout = 15000,
  } = params;

  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT_MS);
  const instance = await getBrowser();
  const page: Page = await instance.newPage();

  try {
    await page.setViewportSize({ width, height });
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: effectiveTimeout,
    });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, {
        timeout: effectiveTimeout,
      });
    }

    const screenshotBuffer = await page.screenshot({
      type: format,
      quality: format === "jpeg" ? quality : undefined,
      fullPage: true,
    });

    if (shouldTrim) {
      return trimImage(Buffer.from(screenshotBuffer), padding, format, quality);
    }

    return Buffer.from(screenshotBuffer);
  } finally {
    await page.close();
  }
}

/**
 * Navigate to a URL, wait for content to load, and extract the rendered HTML.
 * Returns the innerHTML of the body element with readable formatting.
 */
async function extractHtml(
  params: Pick<ScreenshotRequest, "url" | "waitForSelector" | "timeout">,
): Promise<string> {
  const { url, waitForSelector, timeout = 15000 } = params;

  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT_MS);
  const instance = await getBrowser();
  const page: Page = await instance.newPage();

  try {
    await page.goto(url!, {
      waitUntil: "networkidle",
      timeout: effectiveTimeout,
    });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, {
        timeout: effectiveTimeout,
      });
    }

    return await page.evaluate(() => document.body.innerHTML);
  } finally {
    await page.close();
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    const instance = await getBrowser().catch(() => null);
    if (instance?.isConnected()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "browser_not_ready" }));
    }
    return;
  }

  // HTML extraction endpoint
  if (req.method === "POST" && req.url === "/html") {
    try {
      const body = await readBody(req);
      const params: ScreenshotRequest = JSON.parse(body);

      if (!params.url) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "url is required" }));
        return;
      }

      const html = await extractHtml(params);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("HTML extraction error:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Screenshot endpoint
  if (req.method === "POST" && req.url === "/screenshot") {
    try {
      const body = await readBody(req);
      const params: ScreenshotRequest = JSON.parse(body);

      if (!params.url) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "url is required" }));
        return;
      }

      const imageBuffer = await captureScreenshot(params);
      const contentType =
        (params.format ?? "jpeg") === "png" ? "image/png" : "image/jpeg";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": imageBuffer.length,
      });
      res.end(imageBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Screenshot error:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// Launch browser eagerly on startup so health check passes immediately
getBrowser()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Playwright screenshot server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to launch browser:", err);
    process.exit(1);
  });

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`Received ${signal}, shutting down...`);
    server.close();
    if (browser) {
      await browser.close();
    }
    process.exit(0);
  });
}
