import { describe, expect, it } from "vitest";
import { siteIndexSchema, type SiteIndex } from "../src/lib/domain";
import { businessHealth as checkBusinessHealth } from "../src/lib/business-health";
import { BaselinePredictionModel, initialModelArtifact, predictionSchema } from "../src/lib/prediction-contract";
import { predictionAvailability } from "../src/lib/prediction-status";
import type { RunPhase } from "../src/lib/run-timing";

function businessHealth(value: SiteIndex, date: string, phase: RunPhase, now: Date) {
  return checkBusinessHealth(value, date, phase, now, [`${value.businessDate}:${value.phase}:cn-loop-v2`]);
}

function index(date = "2026-10-13", navDate = "2026-10-12") {
  return siteIndexSchema.parse({
    businessDate: date, phase: "evening", generatedAt: "2026-10-13T14:31:00Z",
    asOf: navDate, dataStatus: "complete", dataMode: "real",
    summaries: Array.from({ length: 8 }, (_, number) => {
      const fund = {
        id: `cn-test-${number}`, symbol: "025852", name: "Mainland fund",
        market: "CN" as const, exchange: "中国公募基金", currency: "CNY",
        assetClass: "Mixed" as const, benchmark: "benchmark", timezone: "Asia/Shanghai",
        inceptionDate: "2025-12-12", providerRef: "eastmoney:025852"
      };
      return {
        fund, analytics: null, holdings: null,
        predictionAvailability: { status: "available", date, reason: "Test prediction" },
        latestQuote: {
          fundId: fund.id, date: navDate, nav: 1, price: null, benchmarkPrice: null,
          currency: "CNY", valuation: "final",
          quality: {
            status: "complete", source: "test", dataMode: "real", isSimulated: false,
            collectedAt: "2026-10-13T14:31:00Z", warnings: [], missingFields: []
          }
        },
        prediction: new BaselinePredictionModel().predict({
          fund, predictionDate: date, targetTradeDate: date,
          featureTimestamp: `${date}T10:30:00+08:00`, quotes: [], holdings: null,
          holdingQuotes: null, artifact: initialModelArtifact(`${date}T09:30:00+08:00`)
        })
      };
    })
  });
}
const now = new Date("2026-10-13T20:18:10Z");

describe("business health, independent of workflow success", () => {
  it("accepts an overnight evening collection for the original date", () => {
    expect(businessHealth(index(), "2026-10-13", "evening", now)).toEqual([]);
  });

  it("recognizes completed morning replays after evening replaces the public index", () => {
    const value = index();
    expect(checkBusinessHealth(value, "2026-10-13", "morning", now, [
      "2026-10-13:morning:cn-loop-v2", "2026-10-13:evening:cn-loop-v2"
    ])).toEqual([]);
    expect(checkBusinessHealth(value, "2026-10-13", "morning", now, [
      "2026-10-13:morning:cn-loop-v1"
    ])).toContain("No completed morning collection for business date 2026-10-13.");
  });

  it("detects missing predictions and does not call old predictions current", () => {
    const value = index();
    const summary = value.summaries[0]!;
    const prediction = predictionSchema.parse(summary.prediction);
    summary.prediction = { ...prediction, predictionDate: "2026-10-12" };
    expect(businessHealth(value, "2026-10-13", "evening", now)).toContain(
      `${summary.fund.id}: missing prediction for trading day 2026-10-13.`
    );
    expect(predictionAvailability("2026-10-14", prediction).status).toBe("not-run");
  });

  it("counts trading-day NAV lag and allows extra QDII disclosure latency", () => {
    const value = index("2026-10-13", "2026-10-09");
    expect(businessHealth(value, "2026-10-13", "evening", now)).toHaveLength(8);
    for (const summary of value.summaries) summary.fund.name = "QDII fund";
    expect(businessHealth(value, "2026-10-13", "evening", now)).toEqual([]);
    value.summaries[0]!.latestQuote!.date = "2026-09-29";
    expect(businessHealth(value, "2026-10-13", "evening", now)).toHaveLength(1);
  });

  it("checks Friday predictions on a weekly run and excludes exchange holidays", () => {
    const value = index("2026-10-09", "2026-10-09");
    expect(businessHealth(value, "2026-10-10", "weekly", now)).toEqual([]);
    const holiday = index("2026-09-30", "2026-09-30");
    expect(businessHealth(holiday, "2026-10-05", "morning", now)).toEqual([]);
  });

  it("detects failed collections, future timestamps, missing NAV and fund loss", () => {
    const value = index();
    value.businessDate = "2026-10-14";
    value.generatedAt = "2026-10-14T22:30:00+08:00";
    value.summaries[0]!.latestQuote = null;
    value.summaries.pop();
    expect(businessHealth(value, "2026-10-13", "evening", now)).toEqual(expect.arrayContaining([
      "Expected 8 funds, found 7.",
      "Index generation time is in the future.",
      "No completed evening collection for business date 2026-10-13."
    ]));
    expect(businessHealth(value, "2026-10-13", "evening", now).some((issue) => issue.includes("missing or future NAV"))).toBe(true);
  });
});
