import { describe, expect, it } from "vitest";
import { assertMorningWindow, resolveSchedule, scheduledTimestamp } from "../src/lib/run-timing";
import { runPipeline } from "../scripts/pipeline";

describe("business time semantics", () => {
  it("keeps a delayed evening run on its scheduled date, including reruns", () => {
    expect(resolveSchedule("30 14 * * 1-5", "2026-10-13T20:18:10Z")).toEqual({
      date: "2026-10-13", phase: "evening", scheduledAt: "2026-10-13T22:30:00+08:00"
    });
    expect(resolveSchedule("30 14 * * 1-5", "2026-10-16T20:18:10Z").date).toBe("2026-10-16");
    expect(resolveSchedule("30 14 * * 1-5", "2026-10-19T00:00:00Z").date).toBe("2026-10-16");
  });

  it("resolves morning and weekly phases and rejects unknown schedules", () => {
    expect(resolveSchedule("30 2 * * 1-5", "2026-10-13T09:37:59Z").phase).toBe("morning");
    expect(resolveSchedule("30 2 * * 6", "2026-10-10T08:48:41Z").date).toBe("2026-10-10");
    expect(scheduledTimestamp("2026-10-10", "weekly")).toBe("2026-10-10T10:30:00+08:00");
    expect(() => resolveSchedule("bad", "2026-10-10T08:48:41Z")).toThrow("Unsupported");
    expect(() => resolveSchedule("30 2 * * 6", "invalid")).toThrow("Invalid");
  });

  it("refuses retrospective or after-market predictions before touching data", async () => {
    expect(() => assertMorningWindow("2026-10-13", new Date("2026-10-13T02:30:00Z"))).not.toThrow();
    expect(() => assertMorningWindow("2026-10-13", new Date("2026-10-13T01:00:00Z"))).toThrow("morning window");
    await expect(runPipeline("2026-10-13", "morning", {
      now: () => new Date("2026-10-13T09:37:59Z")
    })).rejects.toThrow("no retrospective prediction");
    await expect(runPipeline("2026-10-13", "all", {
      now: () => new Date("2026-10-14T02:00:00Z")
    })).rejects.toThrow("morning window");
  });
});
