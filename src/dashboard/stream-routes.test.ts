import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { EventEmitter } from "events";

// `computeDashboardJsonlPath` (reached via the sessionUuid-fallback path)
// now derives from `workspacePath` which reads `DANXBOT_REPOS_BASE`. Pin
// the env so assertions about the encoded dir are deterministic regardless
// of the test-runner cwd. See the agent-isolation epic (Trello `7ha2CSpc`).
const PRIOR_REPOS_BASE = process.env.DANXBOT_REPOS_BASE;
beforeAll(() => {
  process.env.DANXBOT_REPOS_BASE = "/danxbot/app/repos";
});
afterAll(() => {
  if (PRIOR_REPOS_BASE === undefined) {
    delete process.env.DANXBOT_REPOS_BASE;
  } else {
    process.env.DANXBOT_REPOS_BASE = PRIOR_REPOS_BASE;
  }
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSubscribe = vi.fn();
const mockSubscriberCount = vi.fn().mockReturnValue(0);
vi.mock("./event-bus.js", () => ({
  eventBus: {
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    subscriberCount: (...args: unknown[]) => mockSubscriberCount(...args),
  },
}));

const mockGetDispatchById = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  getDispatchById: (...args: unknown[]) => mockGetDispatchById(...args),
}));

const mockStartJsonlWatcher = vi.fn().mockResolvedValue(undefined);
const mockStopJsonlWatcher = vi.fn();
vi.mock("./dispatch-stream.js", () => ({
  startJsonlWatcher: (...args: unknown[]) => mockStartJsonlWatcher(...args),
  stopJsonlWatcher: (...args: unknown[]) => mockStopJsonlWatcher(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import AFTER mocks.
import { handleStream } from "./stream-routes.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(query: string): IncomingMessage {
  const emitter = new EventEmitter();
  (emitter as unknown as { url: string }).url = `/api/stream?${query}`;
  return emitter as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & { written: string[]; statusCode: number; ended: boolean; headers: Record<string, string | number> } {
  const res = new EventEmitter() as ServerResponse & {
    written: string[];
    statusCode: number;
    ended: boolean;
    headers: Record<string, string | number>;
  };
  res.written = [];
  res.ended = false;
  res.statusCode = 200;
  res.headers = {};
  res.writeHead = vi.fn((code: number, headers?: Record<string, unknown>) => {
    res.statusCode = code;
    if (headers) Object.assign(res.headers, headers);
    return res;
  }) as unknown as typeof res.writeHead;
  res.write = vi.fn((chunk: unknown) => {
    res.written.push(String(chunk));
    return true;
  }) as unknown as typeof res.write;
  res.end = vi.fn((chunk?: unknown) => {
    if (chunk) res.written.push(String(chunk));
    res.ended = true;
    return res;
  }) as unknown as typeof res.end;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSubscribe.mockReturnValue(() => {});
  mockSubscriberCount.mockReturnValue(0);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleStream — input validation", () => {
  it("returns 400 when topics is empty", async () => {
    const req = makeReq("");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams(""));
    expect(res.statusCode).toBe(400);
    expect(res.ended).toBe(true);
  });

  it("returns 400 when all provided topics are invalid", async () => {
    const req = makeReq("topics=invalid:topic,another_bad");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=invalid:topic,another_bad"));
    expect(res.statusCode).toBe(400);
    expect(res.ended).toBe(true);
  });

  it("opens an SSE stream for valid static topics", async () => {
    const req = makeReq("topics=dispatch:created,dispatch:updated");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:created,dispatch:updated"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it("accepts agent:updated as a valid topic", async () => {
    const req = makeReq("topics=agent:updated");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=agent:updated"));
    expect(res.statusCode).toBe(200);
    expect(mockSubscribe).toHaveBeenCalledOnce();
  });
});

describe("handleStream — dispatch:jsonl:<id> topic", () => {
  it("returns 404 when the dispatch does not exist", async () => {
    mockGetDispatchById.mockResolvedValue(null);
    const req = makeReq("topics=dispatch:jsonl:no-such-job");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:no-such-job"));
    expect(res.statusCode).toBe(404);
    expect(res.ended).toBe(true);
  });

  it("returns 404 when the dispatch exists but both jsonlPath and sessionUuid are null", async () => {
    mockGetDispatchById.mockResolvedValue({ id: "job-1", jsonlPath: null, sessionUuid: null });
    const req = makeReq("topics=dispatch:jsonl:job-1");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:job-1"));
    expect(res.statusCode).toBe(404);
    expect(res.ended).toBe(true);
  });

  it("returns 500 when getDispatchById throws", async () => {
    mockGetDispatchById.mockRejectedValue(new Error("DB connection lost"));
    const req = makeReq("topics=dispatch:jsonl:job-err");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:job-err"));
    expect(res.statusCode).toBe(500);
    expect(res.ended).toBe(true);
  });

  it("starts a JSONL watcher using sessionUuid fallback when jsonlPath is null", async () => {
    mockGetDispatchById.mockResolvedValue({
      id: "job-uuid",
      repoName: "danxbot",
      jsonlPath: null,
      sessionUuid: "abc123",
    });
    const req = makeReq("topics=dispatch:jsonl:job-uuid");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:job-uuid"));
    expect(res.statusCode).toBe(200);
    expect(mockStartJsonlWatcher).toHaveBeenCalledWith(
      "job-uuid",
      "/danxbot/app/claude-projects/danxbot/-danxbot-app-repos-danxbot--danxbot-workspace/abc123.jsonl",
    );
  });

  it("starts a JSONL watcher for a valid dispatch:jsonl topic", async () => {
    mockGetDispatchById.mockResolvedValue({
      id: "job-1",
      jsonlPath: "/runs/job-1/session.jsonl",
    });
    const req = makeReq("topics=dispatch:jsonl:job-1");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:job-1"));
    expect(res.statusCode).toBe(200);
    expect(mockStartJsonlWatcher).toHaveBeenCalledWith(
      "job-1",
      "/runs/job-1/session.jsonl",
    );
  });

  it("stops the JSONL watcher when the client disconnects (if no other subscribers)", async () => {
    mockGetDispatchById.mockResolvedValue({
      id: "job-2",
      jsonlPath: "/runs/job-2/session.jsonl",
    });
    mockSubscriberCount.mockReturnValue(0); // no more subscribers after cleanup

    const req = makeReq("topics=dispatch:jsonl:job-2");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:job-2"));

    // Simulate client disconnect.
    (req as unknown as EventEmitter).emit("close");

    expect(mockStopJsonlWatcher).toHaveBeenCalledWith("job-2");
  });

  it("does NOT stop the JSONL watcher when other subscribers remain", async () => {
    mockGetDispatchById.mockResolvedValue({
      id: "job-3",
      jsonlPath: "/runs/job-3/session.jsonl",
    });
    mockSubscriberCount.mockReturnValue(1); // another subscriber still active

    const req = makeReq("topics=dispatch:jsonl:job-3");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:jsonl:job-3"));

    (req as unknown as EventEmitter).emit("close");

    expect(mockStopJsonlWatcher).not.toHaveBeenCalled();
  });
});

describe("handleStream — event forwarding", () => {
  it("writes a data: line when the EventBus delivers an event", async () => {
    let capturedCb: ((event: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((_topic: string, cb: (event: unknown) => void) => {
      capturedCb = cb;
      return () => {};
    });

    const req = makeReq("topics=dispatch:created");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:created"));

    const event = { topic: "dispatch:created", data: { id: "job-x" } };
    capturedCb!(event);

    expect(res.written.some((w) => w.includes('"topic":"dispatch:created"'))).toBe(true);
    expect(res.written.some((w) => w.includes('"id":"job-x"'))).toBe(true);
  });

  it("unsubscribes and ends the response when the client disconnects", async () => {
    const unsubSpy = vi.fn();
    mockSubscribe.mockReturnValue(unsubSpy);

    const req = makeReq("topics=dispatch:created");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:created"));

    (req as unknown as EventEmitter).emit("close");

    expect(unsubSpy).toHaveBeenCalledOnce();
    expect(res.ended).toBe(true);
  });
});

describe("handleStream — keep-alive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a keep-alive SSE comment after the interval fires", async () => {
    vi.useFakeTimers();

    const req = makeReq("topics=dispatch:created");
    const res = makeRes();
    await handleStream(req, res, new URLSearchParams("topics=dispatch:created"));

    // Advance time past the 15 s keep-alive threshold.
    await vi.advanceTimersByTimeAsync(15_000);

    expect(res.written.some((w) => w === ": keep-alive\n\n")).toBe(true);
  });
});

describe("handleStream — slow-consumer eviction", () => {
  it("evicts the subscriber via isSlowConsumer and ends the response", async () => {
    let capturedIsSlowConsumer: (() => boolean) | null = null;
    let capturedOnEvict: (() => void) | null = null;

    mockSubscribe.mockImplementation(
      (
        _topic: string,
        _cb: unknown,
        onEvict: () => void,
        isSlowConsumer: () => boolean,
      ) => {
        capturedOnEvict = onEvict;
        capturedIsSlowConsumer = isSlowConsumer;
        return () => {};
      },
    );

    const req = makeReq("topics=dispatch:created");
    const res = makeRes();
    // Simulate a full write buffer so isSlowConsumer() returns true.
    (res as unknown as { writableLength: number }).writableLength = 65 * 1024;
    await handleStream(req, res, new URLSearchParams("topics=dispatch:created"));

    // isSlowConsumer should return true for this res.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedIsSlowConsumer!()).toBe(true);

    // Trigger the eviction path.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    capturedOnEvict!();

    expect(res.ended).toBe(true);
  });
});
