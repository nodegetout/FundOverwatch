import { describe, expect, it } from "vitest";
import { getBoundaryPeriods, isWorkday, shanghaiDate } from "../scripts/pipeline";

describe("pipeline calendar rules", () => {
  it("uses the Asia/Shanghai calendar date", () => {
    expect(shanghaiDate(new Date("2026-10-04T16:30:00Z"))).toBe("2026-10-05");
  });

  it("skips weekends", () => {
    expect(isWorkday("2026-10-03")).toBe(false);
    expect(isWorkday("2026-10-05")).toBe(true);
  });

  it("detects weekly, monthly, and yearly boundaries", () => {
    expect(getBoundaryPeriods("2026-10-09")).toEqual(["week"]);
    expect(getBoundaryPeriods("2026-10-30")).toEqual(["week", "month"]);
    expect(getBoundaryPeriods("2026-12-31")).toEqual(["month", "year"]);
  });
});
