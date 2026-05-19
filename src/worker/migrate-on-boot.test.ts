import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYamlText } from "yaml";
import { runBootMigrationSweep } from "./migrate-on-boot.js";

/**
 * DX-700 — boot sweep heals stale `"Blocked"` references on v12
 * files. The v1 of the v11→v12 migration only remapped top-level
 * `status`; `history[].to: "Blocked"` survived into v12 and now
 * fails the strict-enum validator on every read.
 */

async function makeRepoWithIssue(name: string, body: string): Promise<{
  localPath: string;
  issuePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "danxbot-migrate-test-"));
  const issuesOpen = join(root, ".danxbot", "issues", "open");
  await mkdir(issuesOpen, { recursive: true });
  const issuePath = join(issuesOpen, `${name}.yml`);
  await writeFile(issuePath, body, "utf-8");
  return { localPath: root, issuePath };
}

describe("runBootMigrationSweep — DX-700 history-Blocked heal", () => {
  it("heals an at-MAX v12 file that still carries history[].to: Blocked", async () => {
    const stale = `schema_version: 12
tracker: memory
id: DX-1
external_id: ""
parent_id: null
children: []
dispatch: null
status: Done
type: Feature
title: Already-migrated card with stale history
description: ""
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
history:
  - timestamp: 2026-04-01T00:00:00Z
    actor: worker:auto-derive
    event: status_change
    from: ToDo
    to: Blocked
  - timestamp: 2026-04-02T00:00:00Z
    actor: worker:auto-derive
    event: status_change
    from: Blocked
    to: Done
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: null
waiting_on: null
blocked: null
requires_human: null
conflict_on: []
effort_level: medium
db_updated_at: 2026-04-02T00:00:00Z
archived_at: null
ready_at: 2026-03-31T00:00:00Z
completed_at: 2026-04-02T00:00:00Z
cancelled_at: null
list_name: null
`;
    const { localPath, issuePath } = await makeRepoWithIssue("DX-1", stale);
    const result = await runBootMigrationSweep([{ localPath }]);
    expect(result.failed).toEqual([]);
    expect(result.healed).toBe(1);
    expect(result.migrated).toBe(0);
    const updated = parseYamlText(await readFile(issuePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const history = updated.history as Array<Record<string, unknown>>;
    // completed_at populated → projection is "Done" for every Blocked
    // appearance.
    expect(history[0].to).toBe("Done");
    expect(history[1].from).toBe("Done");
    // Non-Blocked entries pass through
    expect(history[0].from).toBe("ToDo");
    expect(history[1].to).toBe("Done");
    expect(updated.schema_version).toBe(12);
  });

  it("is a no-op when the v12 file is already clean (unchanged++)", async () => {
    const clean = `schema_version: 12
tracker: memory
id: DX-2
external_id: ""
parent_id: null
children: []
dispatch: null
status: ToDo
type: Feature
title: Clean v12
description: ""
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
history:
  - timestamp: 2026-04-01T00:00:00Z
    actor: worker:auto-derive
    event: status_change
    from: Review
    to: ToDo
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: null
waiting_on: null
blocked: null
requires_human: null
conflict_on: []
effort_level: medium
db_updated_at: 2026-04-01T00:00:00Z
archived_at: null
ready_at: 2026-03-31T00:00:00Z
completed_at: null
cancelled_at: null
list_name: null
`;
    const { localPath } = await makeRepoWithIssue("DX-2", clean);
    const result = await runBootMigrationSweep([{ localPath }]);
    expect(result.failed).toEqual([]);
    expect(result.healed).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it("heals stale history in a closed/ bucket file (AC #2 — boot sweep walks both)", async () => {
    const stale = `schema_version: 12
tracker: memory
id: DX-CLOSED
external_id: ""
parent_id: null
children: []
dispatch: null
status: Done
type: Feature
title: Closed v12 with stale history
description: ""
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
history:
  - timestamp: 2026-04-01T00:00:00Z
    actor: worker:auto-derive
    event: status_change
    from: ToDo
    to: Blocked
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: null
waiting_on: null
blocked: null
requires_human: null
conflict_on: []
effort_level: medium
db_updated_at: 2026-04-02T00:00:00Z
archived_at: null
ready_at: 2026-03-31T00:00:00Z
completed_at: 2026-04-02T00:00:00Z
cancelled_at: null
list_name: null
`;
    const root = await mkdtemp(join(tmpdir(), "danxbot-migrate-test-"));
    const issuesClosed = join(root, ".danxbot", "issues", "closed");
    await mkdir(issuesClosed, { recursive: true });
    const issuePath = join(issuesClosed, "DX-CLOSED.yml");
    await writeFile(issuePath, stale, "utf-8");

    const result = await runBootMigrationSweep([{ localPath: root }]);
    expect(result.failed).toEqual([]);
    expect(result.healed).toBe(1);
    const updated = parseYamlText(await readFile(issuePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const history = updated.history as Array<Record<string, unknown>>;
    expect(history[0].to).toBe("Done");
  });

  it("forward-migrates a v11 file AND remaps its history entries", async () => {
    const v11 = `schema_version: 11
tracker: memory
id: DX-3
external_id: ""
parent_id: null
children: []
dispatch: null
status: Blocked
type: Feature
title: Pre-v12 card mid-Blocked
description: ""
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
history:
  - timestamp: 2026-04-01T00:00:00Z
    actor: worker:auto-derive
    event: status_change
    from: In Progress
    to: Blocked
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: null
waiting_on: null
blocked:
  reason: "self-block"
  at: 2026-04-01T00:00:00Z
requires_human: null
conflict_on: []
effort_level: medium
db_updated_at: 2026-04-01T00:00:00Z
archived_at: null
ready_at: 2026-03-31T00:00:00Z
completed_at: null
cancelled_at: null
list_name: null
`;
    const { localPath, issuePath } = await makeRepoWithIssue("DX-3", v11);
    const result = await runBootMigrationSweep([{ localPath }]);
    expect(result.failed).toEqual([]);
    expect(result.migrated).toBe(1);
    const updated = parseYamlText(await readFile(issuePath, "utf-8")) as Record<
      string,
      unknown
    >;
    // ready_at populated, no dispatch, no terminal trigger → ToDo
    expect(updated.status).toBe("ToDo");
    expect(updated.schema_version).toBe(12);
    const history = updated.history as Array<Record<string, unknown>>;
    expect(history[0].to).toBe("ToDo");
    expect(history[0].from).toBe("In Progress");
  });
});
