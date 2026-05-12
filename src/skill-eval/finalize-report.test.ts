import { describe, expect, it, vi } from "vitest";
import {
  finalizeReportWriteoutAndPersist,
  type FinalizeReportDeps,
} from "./finalize-report.js";

function makeDeps(): FinalizeReportDeps & {
  persistReportMock: ReturnType<typeof vi.fn>;
  stdoutWrites: string[];
} {
  const stdoutWrites: string[] = [];
  const persistReportMock = vi.fn(() => ({
    path: "/tmp/REPORT.md",
    bytesWritten: 7,
  }));
  return {
    persistReport: persistReportMock,
    stdout: {
      write(chunk: string) {
        stdoutWrites.push(chunk);
        return true;
      },
    },
    persistReportMock,
    stdoutWrites,
  };
}

describe("finalizeReportWriteoutAndPersist", () => {
  it("calls persistReport exactly once after rendering", () => {
    const deps = makeDeps();
    finalizeReportWriteoutAndPersist(
      {
        markdown: "# report\nbody",
        evalSetPath: "/tmp/dev-debugging/eval-set.json",
        runAt: new Date("2026-05-12T05:45:00.000Z"),
      },
      deps,
    );
    expect(deps.persistReportMock).toHaveBeenCalledTimes(1);
  });

  it("writes the markdown body + trailing newline to stdout BEFORE persisting", () => {
    const deps = makeDeps();
    const callOrder: string[] = [];
    deps.persistReportMock.mockImplementation(() => {
      callOrder.push("persist");
      return { path: "/tmp/REPORT.md", bytesWritten: 0 };
    });
    deps.stdout.write = (chunk: string) => {
      callOrder.push(`stdout:${chunk}`);
      return true;
    };
    finalizeReportWriteoutAndPersist(
      {
        markdown: "# rendered body",
        evalSetPath: "/tmp/eval-set.json",
        runAt: new Date("2026-05-12T05:45:00.000Z"),
      },
      deps,
    );
    expect(callOrder).toEqual([
      "stdout:# rendered body",
      "stdout:\n",
      "persist",
    ]);
  });

  it("forwards markdown + evalSetPath + runAt to persistReport verbatim", () => {
    const deps = makeDeps();
    const runAt = new Date("2026-05-12T05:45:00.000Z");
    finalizeReportWriteoutAndPersist(
      {
        markdown: "body",
        evalSetPath: "/tmp/x/eval-set.json",
        runAt,
      },
      deps,
    );
    expect(deps.persistReportMock).toHaveBeenCalledWith({
      markdown: "body",
      evalSetPath: "/tmp/x/eval-set.json",
      runAt,
    });
  });

  it("writes stdout before persist even when persistReport throws (defensive: operator still sees the report on stdout)", () => {
    const deps = makeDeps();
    deps.persistReportMock.mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    expect(() =>
      finalizeReportWriteoutAndPersist(
        {
          markdown: "# the body",
          evalSetPath: "/tmp/x/eval-set.json",
          runAt: new Date(),
        },
        deps,
      ),
    ).toThrow(/ENOSPC/);
    // Stdout was written before the throw — operator still sees the report.
    expect(deps.stdoutWrites).toEqual(["# the body", "\n"]);
  });

  it("returns the persistReport result so the caller can inspect the on-disk path", () => {
    const deps = makeDeps();
    deps.persistReportMock.mockReturnValueOnce({
      path: "/custom/REPORT.md",
      bytesWritten: 42,
    });
    const result = finalizeReportWriteoutAndPersist(
      {
        markdown: "body",
        evalSetPath: "/tmp/x/eval-set.json",
        runAt: new Date(),
      },
      deps,
    );
    expect(result.path).toBe("/custom/REPORT.md");
    expect(result.bytesWritten).toBe(42);
  });
});
