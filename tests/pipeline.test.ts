import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  evaluatePrediction,
  catchUpPeriodGates,
  getBoundaryPeriods,
  isWorkday,
  mergeQuotes,
  periodCloseGates,
  providerForFund,
  retainQuotesForFund,
  shanghaiDate
} from "../scripts/pipeline";
import { parseFunds, type Quote } from "../src/lib/domain";
import type { FundPrediction } from "../src/lib/prediction-contract";
import { isMainlandTradingDay, tradingCalendarCoverage } from "../src/lib/trading-calendar";

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
    expect(tradingCalendarCoverage("2027-10-05")).toBe("weekday-fallback");
  });

  it("handles weekly, leap-year, 30/31-day, weekend month-end, and year gates", () => {
    expect(periodCloseGates("2026-10-10").map(({ period }) => period)).toEqual(["weekly"]);
    expect(periodCloseGates("2024-02-29").map(({ period }) => period)).toContain("monthly");
    expect(periodCloseGates("2026-04-30").map(({ period }) => period)).toContain("monthly");
    expect(periodCloseGates("2026-07-31").map(({ period }) => period)).toContain("monthly");
    expect(periodCloseGates("2026-10-30")).toContainEqual(
      expect.objectContaining({ period: "monthly", endDate: "2026-10-31", status: "provisional" })
    );
    expect(getBoundaryPeriods("2026-12-31")).toEqual(["month", "year"]);
    expect(catchUpPeriodGates("2027-01-04")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ period: "monthly", periodKey: "2026-12" }),
        expect.objectContaining({ period: "yearly", periodKey: "2026" })
      ])
    );
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
