import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  HostedDistRegistry,
  HOSTED_DIST_LRU_CAP,
  resolveRequestPath,
  resolveWorkspaceRoot,
  mimeFor,
  installTeardownHandlers,
  _resetTeardownForTests,
} from "./host-static.js";
import { vueBuildAndPreview } from "./vue-build-and-preview.js";
import { callTool, TOOLS } from "./index.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Build a workspace tree under a fresh tmpdir; return the realpath. */
function makeWorkspace(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "host-static-")));
  return root;
}

function writeDist(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), `<!doctype html><h1>${name}</h1>`);
  writeFileSync(path.join(dir, "app.js"), `console.log("${name}");`);
  return dir;
}

async function httpGet(url: string): Promise<{ status: number; body: string; mime: string }> {
  const res = await fetch(url);
  const body = await res.text();
  return {
    status: res.status,
    body,
    mime: (res.headers.get("content-type") ?? "").split(";")[0].trim(),
  };
}

describe("mimeFor", () => {
  it("maps the common Vite bundle types", () => {
    expect(mimeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeFor("app.js")).toBe("application/javascript; charset=utf-8");
    expect(mimeFor("style.css")).toBe("text/css; charset=utf-8");
    expect(mimeFor("logo.svg")).toBe("image/svg+xml");
    expect(mimeFor("img.png")).toBe("image/png");
    expect(mimeFor("font.woff2")).toBe("font/woff2");
  });

  it("defaults to octet-stream for unknown extensions", () => {
    expect(mimeFor("weird.xyz")).toBe("application/octet-stream");
    expect(mimeFor("no-ext")).toBe("application/octet-stream");
  });

  it("maps .wasm and .avif (modern Vite output)", () => {
    expect(mimeFor("foo.wasm")).toBe("application/wasm");
    expect(mimeFor("hero.avif")).toBe("image/avif");
  });
});

describe("resolveWorkspaceRoot", () => {
  it("realpaths PLAYWRIGHT_WORKSPACE_ROOT when set", () => {
    const root = makeWorkspace();
    expect(resolveWorkspaceRoot({ PLAYWRIGHT_WORKSPACE_ROOT: root })).toBe(root);
  });

  it("falls back to process.cwd()", () => {
    // process.cwd() is realpath-stable; just confirm a string-shaped result.
    const result = resolveWorkspaceRoot({});
    expect(typeof result).toBe("string");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    expect(() =>
      resolveWorkspaceRoot({ PLAYWRIGHT_WORKSPACE_ROOT: "/nonexistent-9c33ab" }),
    ).toThrow();
  });
});

describe("resolveRequestPath — traversal defense", () => {
  let root: string;
  let dist: string;
  beforeEach(() => {
    root = makeWorkspace();
    dist = writeDist(root, "dist");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves / to index.html with a fresh stat", () => {
    const r = resolveRequestPath(dist, "/");
    expect(r?.path).toBe(path.join(dist, "index.html"));
    expect(r?.stat.isFile()).toBe(true);
    expect(r?.stat.size).toBeGreaterThan(0);
  });

  it("resolves a normal asset with stat attached", () => {
    const r = resolveRequestPath(dist, "/app.js");
    expect(r?.path).toBe(path.join(dist, "app.js"));
    expect(r?.stat.isFile()).toBe(true);
  });

  it("returns null when the resolved path is a directory", () => {
    // Directories don't serve directly — even though `/` rewrites to
    // index.html, a deeper directory hit (e.g. /subdir without slash)
    // must 404 rather than autoindex.
    const sub = path.join(dist, "subdir");
    mkdirSync(sub);
    expect(resolveRequestPath(dist, "/subdir")).toBeNull();
  });

  it("returns null for a path with a literal `..` segment", () => {
    expect(resolveRequestPath(dist, "/../etc/passwd")).toBeNull();
    expect(resolveRequestPath(dist, "/sub/../../boom")).toBeNull();
  });

  it("returns null for a percent-encoded `..` segment", () => {
    // %2e%2e decodes to "..". The pre-flight segment check must catch
    // it after decoding, not before.
    expect(resolveRequestPath(dist, "/%2e%2e/passwd")).toBeNull();
  });

  it("returns null for a symlink whose realpath escapes dist", () => {
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "secret");
    const link = path.join(dist, "escape");
    symlinkSync(outside, link);
    expect(resolveRequestPath(dist, "/escape")).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(resolveRequestPath(dist, "/missing.html")).toBeNull();
  });

  it("returns null for malformed percent-encoding", () => {
    expect(resolveRequestPath(dist, "/%xx")).toBeNull();
  });
});

describe("HostedDistRegistry — start + stop + serve", () => {
  let root: string;
  let registry: HostedDistRegistry;
  beforeEach(() => {
    _resetTeardownForTests();
    root = makeWorkspace();
    registry = new HostedDistRegistry({ workspaceRoot: root });
  });
  afterEach(async () => {
    await registry.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves index.html on /", async () => {
    const dist = writeDist(root, "dist");
    const { url, server_id } = await registry.start(dist);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server_id).toMatch(/^[0-9a-f-]{36}$/);
    const res = await httpGet(url + "/");
    expect(res.status).toBe(200);
    expect(res.mime).toBe("text/html");
    expect(res.body).toContain("<h1>dist</h1>");
  });

  it("serves a named asset with the right MIME", async () => {
    const dist = writeDist(root, "dist");
    const { url } = await registry.start(dist);
    const res = await httpGet(url + "/app.js");
    expect(res.status).toBe(200);
    expect(res.mime).toBe("application/javascript");
    expect(res.body).toContain("console.log");
  });

  it("404s a traversal attempt", async () => {
    const dist = writeDist(root, "dist");
    const { url } = await registry.start(dist);
    const res = await httpGet(url + "/../../etc/passwd");
    expect(res.status).toBe(404);
  });

  it("404s a missing asset", async () => {
    const dist = writeDist(root, "dist");
    const { url } = await registry.start(dist);
    const res = await httpGet(url + "/missing.css");
    expect(res.status).toBe(404);
  });

  it("rejects a dist_path that is not absolute", async () => {
    await expect(registry.start("relative/path")).rejects.toThrow(/absolute/);
  });

  it("rejects a dist_path that does not exist", async () => {
    await expect(
      registry.start(path.join(root, "nope")),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a dist_path that is a file, not a directory", async () => {
    const file = path.join(root, "file.txt");
    writeFileSync(file, "hi");
    await expect(registry.start(file)).rejects.toThrow(/directory/);
  });

  it("rejects a dist_path outside the workspace root", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "outside-")));
    try {
      writeDist(outside, "dist");
      await expect(
        registry.start(path.join(outside, "dist")),
      ).rejects.toThrow(/outside workspace root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts a dist_path reached via a symlink as long as the realpath is inside", async () => {
    const dist = writeDist(root, "dist");
    const linked = path.join(root, "via-link");
    symlinkSync(dist, linked);
    const { url } = await registry.start(linked);
    const res = await httpGet(url + "/");
    expect(res.status).toBe(200);
  });

  it("stop() closes the server and frees the port", async () => {
    const dist = writeDist(root, "dist");
    const { url, server_id } = await registry.start(dist);
    await expect((await fetch(url + "/")).text()).resolves.toBeDefined();
    const stopped = await registry.stop(server_id);
    expect(stopped).toBe(true);
    expect(registry.size()).toBe(0);
    // Second stop is a benign no-op.
    expect(await registry.stop(server_id)).toBe(false);
    // Server is dead — fetch fails (connection refused).
    await expect(fetch(url + "/")).rejects.toThrow();
  });

  it("stop() rejects an empty server_id", async () => {
    await expect(registry.stop("")).rejects.toThrow(/non-empty/);
  });

  it("LRU evicts the oldest when the cap would be exceeded", async () => {
    const dists = [0, 1, 2, 3, 4].map((i) => writeDist(root, `dist-${i}`));
    expect(HOSTED_DIST_LRU_CAP).toBe(4);
    const entries: { server_id: string; url: string }[] = [];
    for (const d of dists) {
      entries.push(await registry.start(d));
    }
    // 5 starts → cap=4 → oldest one evicted, size capped.
    expect(registry.size()).toBe(4);
    // First entry's server_id is no longer present.
    expect(registry.get(entries[0].server_id)).toBeUndefined();
    // Last four ARE present.
    for (let i = 1; i < entries.length; i++) {
      expect(registry.get(entries[i].server_id)).toBeDefined();
    }
    // Evicted server's port is closed.
    await expect(fetch(entries[0].url + "/")).rejects.toThrow();
  });

  it("stopAll() closes every active server", async () => {
    const urls: string[] = [];
    for (const i of [0, 1, 2]) {
      urls.push((await registry.start(writeDist(root, `d-${i}`))).url);
    }
    expect(registry.size()).toBe(3);
    await registry.stopAll();
    expect(registry.size()).toBe(0);
    for (const url of urls) {
      await expect(fetch(url + "/")).rejects.toThrow();
    }
  });

  it("concurrent start() calls respect the LRU cap (mutex)", async () => {
    // Fire 8 concurrent starts. Without serialization, async races would
    // produce >4 active entries. The mutex must keep us at exactly 4.
    const dists = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => writeDist(root, `race-${i}`));
    const settled = await Promise.all(dists.map((d) => registry.start(d)));
    expect(settled).toHaveLength(8);
    expect(registry.size()).toBe(HOSTED_DIST_LRU_CAP);
    // The last 4 IDs should be the surviving ones (LRU evicts oldest).
    const surviving = new Set(registry.list().map((e) => e.server_id));
    expect(surviving.size).toBe(4);
    // Earliest evictees: the first 4 ids returned must not be present.
    for (let i = 0; i < 4; i++) {
      expect(surviving.has(settled[i].server_id)).toBe(false);
    }
  });
});

describe("installTeardownHandlers — AC (4) auto-teardown on exit", () => {
  let root: string;
  let registry: HostedDistRegistry;
  let stopAllSpy: ReturnType<typeof vi.spyOn>;
  // Snapshot listeners we add so afterEach can rip them out.
  let exitBefore: number;
  let sigintBefore: number;
  let sigtermBefore: number;

  beforeEach(() => {
    _resetTeardownForTests();
    root = makeWorkspace();
    registry = new HostedDistRegistry({ workspaceRoot: root });
    stopAllSpy = vi.spyOn(registry, "stopAll");
    exitBefore = process.listenerCount("exit");
    sigintBefore = process.listenerCount("SIGINT");
    sigtermBefore = process.listenerCount("SIGTERM");
  });

  afterEach(async () => {
    // Strip listeners added by this test so the suite doesn't accumulate.
    const exitListeners = process.listeners("exit").slice(exitBefore);
    const sigintListeners = process.listeners("SIGINT").slice(sigintBefore);
    const sigtermListeners = process.listeners("SIGTERM").slice(sigtermBefore);
    for (const l of exitListeners) process.off("exit", l as never);
    for (const l of sigintListeners) process.off("SIGINT", l as never);
    for (const l of sigtermListeners) process.off("SIGTERM", l as never);
    stopAllSpy.mockRestore();
    await registry.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers exit, SIGINT, and SIGTERM listeners", () => {
    installTeardownHandlers(registry);
    expect(process.listenerCount("exit")).toBe(exitBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
  });

  it("the exit listener invokes registry.stopAll() (fire-and-forget)", () => {
    installTeardownHandlers(registry);
    const handler = process.listeners("exit").at(-1) as () => void;
    expect(typeof handler).toBe("function");
    handler();
    expect(stopAllSpy).toHaveBeenCalledTimes(1);
  });

  it("the SIGINT listener invokes stopAll() before triggering process.exit(130)", () => {
    installTeardownHandlers(registry);
    const handler = process.listeners("SIGINT").at(-1) as () => void;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      handler();
      expect(stopAllSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("the SIGTERM listener invokes stopAll() before triggering process.exit(143)", () => {
    installTeardownHandlers(registry);
    const handler = process.listeners("SIGTERM").at(-1) as () => void;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      handler();
      expect(stopAllSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(143);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("vueBuildAndPreview", () => {
  let root: string;
  let registry: HostedDistRegistry;
  beforeEach(() => {
    _resetTeardownForTests();
    root = makeWorkspace();
    registry = new HostedDistRegistry({ workspaceRoot: root });
  });
  afterEach(async () => {
    await registry.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("hosts the dist and returns a navigable URL", async () => {
    const dist = writeDist(root, "fake-vite-dist");
    const { url, server_id } = await vueBuildAndPreview(
      { dist_path: dist },
      registry,
    );
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server_id).toMatch(/^[0-9a-f-]{36}$/);
    const res = await httpGet(url + "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("fake-vite-dist");
  });

  it("rejects missing dist_path", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vueBuildAndPreview({} as any, registry),
    ).rejects.toThrow(/dist_path/);
  });

  it("propagates the registry's path-traversal refusal", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "outside-")));
    try {
      writeDist(outside, "dist");
      await expect(
        vueBuildAndPreview({ dist_path: path.join(outside, "dist") }, registry),
      ).rejects.toThrow(/outside workspace root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("callTool dispatch — host-static tools", () => {
  let root: string;
  let registry: HostedDistRegistry;
  beforeEach(() => {
    _resetTeardownForTests();
    root = makeWorkspace();
    registry = new HostedDistRegistry({ workspaceRoot: root });
  });
  afterEach(async () => {
    await registry.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("playwright_host_static returns text content with parsed JSON {url, server_id}", async () => {
    const dist = writeDist(root, "dist");
    const content = await callTool(
      "playwright_host_static",
      { dist_path: dist },
      { url: "unused", timeoutMs: 1000, hostRegistry: registry },
    );
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    if (content[0].type !== "text") throw new Error("type narrow");
    const parsed = JSON.parse(content[0].text);
    expect(parsed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsed.server_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("playwright_host_static_stop accepts a started server_id and reports stopped:true", async () => {
    const dist = writeDist(root, "dist");
    const { server_id } = await registry.start(dist);
    const content = await callTool(
      "playwright_host_static_stop",
      { server_id },
      { url: "unused", timeoutMs: 1000, hostRegistry: registry },
    );
    if (content[0].type !== "text") throw new Error("type narrow");
    expect(JSON.parse(content[0].text)).toEqual({ stopped: true });
    // Second stop is a no-op (false).
    const second = await callTool(
      "playwright_host_static_stop",
      { server_id },
      { url: "unused", timeoutMs: 1000, hostRegistry: registry },
    );
    if (second[0].type !== "text") throw new Error("type narrow");
    expect(JSON.parse(second[0].text)).toEqual({ stopped: false });
  });

  it("playwright_host_static rejects an empty dist_path before touching the filesystem", async () => {
    await expect(
      callTool(
        "playwright_host_static",
        { dist_path: "" },
        { url: "unused", timeoutMs: 1000, hostRegistry: registry },
      ),
    ).rejects.toThrow(/dist_path/);
  });

  it("vue_build_and_preview dispatches through the registry and returns the URL", async () => {
    const dist = writeDist(root, "dist");
    const content = await callTool(
      "vue_build_and_preview",
      { dist_path: dist },
      { url: "unused", timeoutMs: 1000, hostRegistry: registry },
    );
    if (content[0].type !== "text") throw new Error("type narrow");
    const parsed = JSON.parse(content[0].text);
    expect(parsed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsed.server_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("vue_build_and_preview is registered as an MCP tool", () => {
    const tool = TOOLS.find((t) => t.name === "vue_build_and_preview");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/dist/);
  });

  it("playwright_host_static + playwright_host_static_stop are registered with required fields", () => {
    const start = TOOLS.find((t) => t.name === "playwright_host_static")!;
    const stop = TOOLS.find((t) => t.name === "playwright_host_static_stop")!;
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    const startSchema = start.inputSchema as unknown as { required: string[] };
    const stopSchema = stop.inputSchema as unknown as { required: string[] };
    expect(startSchema.required).toEqual(["dist_path"]);
    expect(stopSchema.required).toEqual(["server_id"]);
  });
});
