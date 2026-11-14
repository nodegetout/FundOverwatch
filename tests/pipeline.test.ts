import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  evaluatePrediction,
  catchUpPeriodGates,
  getBoundaryPeriods,
  isWorkday,
  lastCalendarDate,
  mergeQuotes,
  orderPeriodGates,
  periodReportForGate,
  periodCloseGates,
  providerForFund,
  resolveScheduledRun,
  retainQuotesForFund,
  shanghaiDate
} from "../scripts/pipeline";
import { parseFunds, type Quote } from "../src/lib/domain";
import {
  initialModelArtifact,
  type FundPrediction
} from "../src/lib/prediction-contract";
import {
  isMainlandTradingDay,
  tradingCalendarCoverage,
  tradingDayDecision
} from "../src/lib/trading-calendar";

function quote(date: string, nav: number): Quote {
  return {
    fundId: "cn-test",
    date,
    nav,
    price: null,
    benchmarkPrice: null,
    currency: "CNY",
    valuation: "final",
    quality: {
      status: "complete",
      source: "test-real-source",
      dataMode: "real",
      isSimulated: false,
      collectedAt: `${date}T22:30:00+08:00`,
      warnings: [],
      missingFields: []
    }
  };
}

const prediction: FundPrediction = {
  predictionKey: "cn-test:2026-10-05:cn-baseline-v1",
  fundId: "cn-test",
  predictionDate: "2026-10-05",
  targetTradeDate: "2026-10-05",
  predictedReturn: 0.01,
  direction: "up",
  confidence: 0.4,
  featureTimestamp: "2026-10-05T10:30:00+08:00",
  holdingsReportDate: null,
  featureCoverage: 0,
  modelVersion: "cn-baseline-v1",
  modelStatus: "cold-start",
  sampleCount: 0,
  dataQuality: "unavailable",
  contributions: [],
  warnings: []
};

describe("pipeline calendar and evaluation rules", () => {
  it("uses the Asia/Shanghai calendar date and weekday guard", () => {
    expect(shanghaiDate(new Date("2026-10-04T16:30:00Z"))).toBe("2026-10-05");
    expect(isWorkday("2026-10-03")).toBe(false);
    expect(isWorkday("2026-10-05")).toBe(true);
    expect(isMainlandTradingDay("2026-10-05")).toBe(false);
    expect(isMainlandTradingDay("2026-09-30")).toBe(true);
    expect(tradingCalendarCoverage("2026-10-05")).toBe("explicit");
    expect(tradingCalendarCoverage("2027-10-05")).toBe("unavailable");
    expect(tradingDayDecision("2027-10-05").status).toBe("calendar-unavailable");
    expect(tradingDayDecision("2027-10-05", { calendarOverride: true }).status).toBe("trading");
    expect(tradingDayDecision("2025-10-11")).toMatchObject({
      status: "closed",
      reason: "周末休市"
    });
  });

  it("handles Friday weekly, leap-year, month-end, and ordered overlapping gates", () => {
    expect(periodCloseGates("2026-10-09").map(({ period }) => period)).toEqual(["weekly"]);
    expect(periodCloseGates("2026-09-25")).toContainEqual(
      expect.objectContaining({
        period: "weekly",
        startDate: "2026-09-21",
        endDate: "2026-09-25"
      })
    );
    expect(lastCalendarDate(2024, 2)).toBe("2024-02-29");
    expect(periodCloseGates("2026-04-30").map(({ period }) => period)).toContain("monthly");
    expect(periodCloseGates("2026-07-31").map(({ period }) => period)).toEqual([
      "weekly",
      "monthly"
    ]);
    expect(getBoundaryPeriods("2026-12-31")).toEqual(["month", "year"]);
    expect(catchUpPeriodGates("2026-10-08")).toEqual(
      expect.arrayContaining([expect.objectContaining({ periodKey: "2026-09" })])
    );
    expect(
      orderPeriodGates([
        { period: "yearly", periodKey: "x", startDate: "2026-01-01", endDate: "2026-12-31", status: "final" },
        { period: "monthly", periodKey: "x", startDate: "2026-12-01", endDate: "2026-12-31", status: "final" },
        { period: "weekly", periodKey: "x", startDate: "2026-12-28", endDate: "2026-12-31", status: "final" }
      ]).map(({ period }) => period)
    ).toEqual(["weekly", "monthly", "yearly"]);
  });

  it("resolves delayed cron runs from UTC to the intended Shanghai business date", () => {
    expect(resolveScheduledRun("30 14 * * 1-5", new Date("2026-10-05T14:35:00Z"))).toMatchObject({
      phase: "evening",
      date: "2026-10-05",
      scheduledAt: "2026-10-05T22:30:00+08:00",
      delayedAcrossShanghaiDate: false
    });
    expect(resolveScheduledRun("30 14 * * 1-5", new Date("2026-10-05T17:00:00Z"))).toMatchObject({
      date: "2026-10-05",
      delayedAcrossShanghaiDate: true
    });
    expect(resolveScheduledRun("30 2 * * 1-5", new Date("2026-10-05T03:00:00Z"))).toMatchObject({
      phase: "morning",
      date: "2026-10-05"
    });
  });

  it("makes Friday reports provisional/final idempotently and marks empty holiday weeks no-data", () => {
    const gate = periodCloseGates("2026-10-09").find(({ period }) => period === "weekly")!;
    const pending = evaluatePrediction(
      { ...prediction, predictionDate: "2026-10-09", targetTradeDate: "2026-10-09" },
      [quote("2026-10-08", 1)],
      "2026-10-09T22:30:00+08:00"
    );
    const artifact = initialModelArtifact("2026-10-09T22:30:00+08:00");
    const provisional = periodReportForGate(gate, [pending], [prediction], artifact, pending.evaluatedAt);
    expect(provisional).toMatchObject({
      status: "provisional",
      missingNavCount: 1,
      lastTradingDate: "2026-10-09"
    });
    const evaluated = evaluatePrediction(
      { ...prediction, predictionDate: "2026-10-09", targetTradeDate: "2026-10-09" },
      [quote("2026-10-08", 1), quote("2026-10-09", 1.01)],
      "2026-10-12T22:30:00+08:00",
      pending
    );
    const final = periodReportForGate(gate, [evaluated], [prediction], artifact, evaluated.evaluatedAt);
    expect(final).toMatchObject({ reportKey: provisional.reportKey, status: "final", missingNavCount: 0 });

    const closedFridayGate = periodCloseGates("2026-09-25").find(({ period }) => period === "weekly")!;
    const closedFridaySample = {
      ...evaluated,
      evaluationKey: "closed-friday-sample",
      predictionKey: "closed-friday-prediction",
      targetTradeDate: "2026-09-24",
      actualStartDate: "2026-09-23",
      actualEndDate: "2026-09-24"
    };
    expect(
      periodReportForGate(
        closedFridayGate,
        [closedFridaySample],
        [{ ...prediction, predictionKey: "closed-friday-prediction", targetTradeDate: "2026-09-24" }],
        artifact,
        evaluated.evaluatedAt
      )
    ).toMatchObject({
      status: "final",
      lastTradingDate: "2026-09-24",
      tradingDateCount: 4,
      metrics: { sampleCount: 1 }
    });

    const holidayGate = periodCloseGates("2026-02-20").find(({ period }) => period === "weekly")!;
    expect(periodReportForGate(holidayGate, [], [], artifact, pending.evaluatedAt)).toMatchObject({
      status: "no-data",
      tradingDateCount: 0,
      lastTradingDate: null,
      metrics: { sampleCount: 0 },
      modelChange: { applied: false }
    });
  });

  it("contains only real Eastmoney providers and retains bounded history", async () => {
    const funds = parseFunds(JSON.parse(await readFile("data/funds.json", "utf8")));
    expect(funds).toHaveLength(8);
    expect(funds.every(({ market, providerRef }) => market === "CN" && providerRef.startsWith("eastmoney:"))).toBe(true);
    expect(providerForFund(funds[0]!).name).toBe("eastmoney-fund-v2");
    expect(retainQuotesForFund(funds[0]!, Array.from({ length: 300 }, (_, index) => quote(`2026-01-${String((index % 28) + 1).padStart(2, "0")}`, 1)))).toHaveLength(260);
  });

  it("merges quotes idempotently", () => {
    const existing = quote("2026-10-02", 1);
    const incoming = quote("2026-10-02", 1.1);
    expect(mergeQuotes([existing], [incoming])).toEqual([incoming]);
    expect(mergeQuotes([incoming], [incoming])).toEqual([incoming]);
  });

  it("keeps missing target NAV pending and evaluates it on a later run without duplicate identity", () => {
    const pending = evaluatePrediction(
      prediction,
      [quote("2026-10-02", 1)],
      "2026-10-05T22:30:00+08:00"
    );
    expect(pending).toMatchObject({ status: "pending", actualReturn: null });
    const evaluated = evaluatePrediction(
      prediction,
      [quote("2026-10-02", 1), quote("2026-10-05", 1.02)],
      "2026-10-06T22:30:00+08:00",
      pending
    );
    expect(evaluated).toMatchObject({
      evaluationKey: pending.evaluationKey,
      status: "evaluated",
      actualStartDate: "2026-10-02",
      actualEndDate: "2026-10-05"
    });
    expect(evaluated.actualReturn).toBeCloseTo(0.02);
  });
});
