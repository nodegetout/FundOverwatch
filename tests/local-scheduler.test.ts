import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  emptyState,
  expectedSlots,
  loadState,
  runScheduler,
  safeError,
  shanghaiDate,
  type SchedulerConfig,
  type SchedulerDependencies,
  type WorkflowRun
} from "../scripts/local-scheduler";

const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const directory of temporaryPaths.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function config(): SchedulerConfig {
  return {
    repository: "nodegetout/FundOverwatch",
    workflow: "data-refresh.yml",
    ref: "main",
    ghPath: "/usr/local/bin/gh",
    stateFile: "/tmp/state.json",
    lockDirectory: "/tmp/lock",
    graceMinutes: 15,
    scanDays: 3,
    maxBackfillDays: 7,
    sourceCommit: "test"
  };
}

function run(
  overrides: Partial<SchedulerDependencies> = {},
  now = "2026-10-09T02:46:00Z"
) {
  const dispatch = vi.fn(async () => undefined);
  const dependencies: SchedulerDependencies = {
    now: () => new Date(now),
    listRuns: async () => [],
    dispatch,
    resolveDispatchRun: async () => ({
      id: 42,
      event: "workflow_dispatch",
      created_at: now,
      status: "queued",
      conclusion: null,
      head_branch: "main",
      html_url: "https://github.com/nodegetout/FundOverwatch/actions/runs/42"
    }),
    log: vi.fn(),
    ...overrides
  };
  return { dependencies, dispatch };
}

describe("local scheduler slots", () => {
  it("handles Shanghai dates across UTC boundaries", () => {
    expect(shanghaiDate(new Date("2026-10-08T16:30:00Z"))).toBe("2026-10-09");
    expect(shanghaiDate(new Date("2026-10-08T15:59:59Z"))).toBe("2026-10-08");
  });

  it("skips holiday mornings but keeps weekday and closed-Friday evenings", () => {
    const nationalDay = expectedSlots("2026-10-05", "2026-10-05");
    expect(nationalDay.map(({ phase }) => phase)).toEqual(["evening"]);
    const closedFriday = expectedSlots("2026-09-25", "2026-09-25");
    expect(closedFriday).toHaveLength(1);
    expect(closedFriday[0]).toMatchObject({
      phase: "evening",
      reason: expect.stringContaining("Friday weekly close")
    });
    expect(expectedSlots("2026-10-03", "2026-10-04")).toEqual([]);
  });

  it("observes an on-time schedule run without dispatching", async () => {
    const existing: WorkflowRun = {
      id: 1,
      event: "schedule",
      created_at: "2026-10-09T02:30:30Z",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      html_url: "https://github.com/run/1"
    };
    const { dependencies, dispatch } = run({
      listRuns: async () => [existing]
    });
    const state = await runScheduler(
      config(),
      emptyState("test"),
      dependencies,
      { dryRun: false, date: "2026-10-09" }
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.slots["2026-10-09:morning"]).toMatchObject({
      status: "observed",
      dispatchRunId: 1
    });
  });

  it("dispatches a missing slot after grace and does not storm", async () => {
    const { dependencies, dispatch } = run();
    const first = await runScheduler(
      config(),
      emptyState("test"),
      dependencies,
      { dryRun: false, date: "2026-10-09" }
    );
    expect(dispatch).toHaveBeenCalledWith("morning", "2026-10-09");
    expect(first.slots["2026-10-09:morning"]).toMatchObject({
      status: "dispatched",
      dispatchRunId: 42,
      attempts: 1
    });
    const lateSchedule: WorkflowRun = {
      id: 99,
      event: "schedule",
      created_at: "2026-10-09T09:00:00Z",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      html_url: "https://github.com/run/99"
    };
    const dispatchSuccess = {
      id: 42,
      event: "workflow_dispatch",
      created_at: "2026-10-09T02:46:00Z",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      html_url: "https://github.com/run/42"
    };
    const next = run({
      listRuns: async () => [lateSchedule, dispatchSuccess]
    }, "2026-10-09T09:05:00Z");
    const second = await runScheduler(
      config(),
      first,
      next.dependencies,
      { dryRun: false, date: "2026-10-09" }
    );
    expect(next.dispatch).not.toHaveBeenCalled();
    expect(second.slots["2026-10-09:morning"]!.status).toBe("success");
  });

  it("catches up all eligible slots after sleep", async () => {
    const { dependencies, dispatch } = run({}, "2026-10-09T15:00:00Z");
    await runScheduler(
      config(),
      emptyState("test"),
      dependencies,
      { dryRun: false, backfill: { start: "2026-10-08", end: "2026-10-09" } }
    );
    expect(dispatch.mock.calls).toEqual([
      ["morning", "2026-10-08"],
      ["evening", "2026-10-08"],
      ["morning", "2026-10-09"],
      ["evening", "2026-10-09"]
    ]);
  });

  it("refuses automatic backfills older than seven days", async () => {
    const { dependencies } = run({}, "2026-10-09T15:00:00Z");
    await expect(
      runScheduler(
        config(),
        emptyState("test"),
        dependencies,
        { dryRun: false, backfill: { start: "2026-10-01", end: "2026-10-02" } }
      )
    ).rejects.toThrow("exceeds the 7-day automatic limit");
  });

  it("backs off network failures without recording success or leaking tokens", async () => {
    const secret = "gho_secretvalue";
    const { dependencies, dispatch } = run({
      dispatch: vi.fn(async () => {
        throw new Error(`network failed ${secret}`);
      })
    });
    const state = await runScheduler(
      config(),
      emptyState("test"),
      dependencies,
      { dryRun: false, date: "2026-10-09" }
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.slots["2026-10-09:morning"]).toMatchObject({
      status: "failed",
      attempts: 1,
      nextAttemptAt: expect.any(String)
    });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(safeError(new Error(secret))).toBe("[REDACTED]");
  });

  it("dry-run reports decisions without dispatching", async () => {
    const { dependencies, dispatch } = run();
    const state = await runScheduler(
      config(),
      emptyState("test"),
      dependencies,
      { dryRun: true, date: "2026-10-09" }
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.slots["2026-10-09:morning"]!.decision).toBe("dry-run-dispatch");
  });
});

describe("local scheduler state and lock", () => {
  it("fails explicitly on corrupt state", async () => {
    const directory = path.join(os.tmpdir(), `fund-scheduler-${process.pid}-${Date.now()}`);
    temporaryPaths.push(directory);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "state.json");
    await writeFile(file, "{broken", "utf8");
    await expect(loadState(file, "test")).rejects.toThrow("corrupt JSON");
  });

  it("prevents concurrent runs and replaces stale locks", async () => {
    const directory = path.join(os.tmpdir(), `fund-scheduler-lock-${process.pid}-${Date.now()}`);
    temporaryPaths.push(directory);
    const firstNow = new Date();
    const release = await acquireLock(directory, firstNow);
    await expect(
      acquireLock(directory, new Date(firstNow.getTime() + 60_000))
    ).rejects.toThrow("already held");
    await release();
    await mkdir(directory, { recursive: true });
    const old = new Date("2026-10-08T00:00:00Z");
    await utimes(directory, old, old);
    const releaseStale = await acquireLock(
      directory,
      new Date("2026-10-09T00:00:00Z")
    );
    expect(JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"))).toHaveProperty("pid");
    await releaseStale();
  });
});
