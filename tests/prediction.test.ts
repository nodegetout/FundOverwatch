import { describe, expect, it } from "vitest";
import type { Fund, HoldingQuoteBatch, HoldingsSnapshot, Quote } from "../src/lib/domain";
import {
  BaselinePredictionModel,
  initialModelArtifact,
  metricSet,
  type PredictionEvaluation
} from "../src/lib/prediction-contract";
import {
  evaluationDisplayState,
  predictionAvailability
} from "../src/lib/prediction-status";

const fund: Fund = {
  id: "cn-017641",
  symbol: "017641",
  name: "摩根标普500指数(QDII)人民币A",
  market: "CN",
  exchange: "中国公募基金",
  currency: "CNY",
  assetClass: "Equity",
  benchmark: "S&P 500",
  timezone: "Asia/Shanghai",
  inceptionDate: "2023-04-06",
  providerRef: "eastmoney:017641"
};
const quality = {
  status: "complete" as const,
  source: "test-real",
  dataMode: "real" as const,
  isSimulated: false as const,
  collectedAt: "2026-10-05T10:30:00+08:00",
  warnings: [],
  missingFields: []
};
const quotes: Quote[] = [
  { fundId: fund.id, date: "2026-09-29", nav: 1, price: null, benchmarkPrice: null, currency: "CNY", valuation: "final", quality },
  { fundId: fund.id, date: "2026-09-30", nav: 1.01, price: null, benchmarkPrice: null, currency: "CNY", valuation: "final", quality },
  { fundId: fund.id, date: "2026-10-02", nav: 1.02, price: null, benchmarkPrice: null, currency: "CNY", valuation: "final", quality }
];
const holdings: HoldingsSnapshot = {
  fundId: fund.id,
  date: "2026-06-30",
  previousDate: "2026-03-31",
  contentHash: "hash",
  holdings: [
    {
      name: "A",
      symbol: "A",
      assetType: "stock",
      source: "test",
      quoteRef: "1.A",
      weight: 0.2,
      previousWeight: 0.2,
      weightChange: 0,
      changeStatus: "unchanged",
      sector: null,
      country: null
    },
    {
      name: "Bond",
      symbol: "B",
      assetType: "bond",
      source: "test",
      quoteRef: null,
      weight: 0.4,
      previousWeight: 0.4,
      weightChange: 0,
      changeStatus: "unchanged",
      sector: null,
      country: null
    }
  ],
  sectors: [],
  countries: [],
  quality
};

function holdingQuotes(asOf: string): HoldingQuoteBatch {
  return {
    fundId: fund.id,
    collectedAt: "2026-10-05T10:30:00+08:00",
    quotes: [
      {
        assetKey: "stock:A",
        status: "available",
        dayChange: 0.02,
        asOf,
        source: "test-real",
        warnings: []
      },
      {
        assetKey: "bond:B",
        status: "unavailable",
        dayChange: null,
        asOf: null,
        source: "test-real",
        warnings: []
      }
    ]
  };
}

describe("baseline prediction model", () => {
  it("derives non-trading, not-run, source-error, and evaluation display states", () => {
    expect(predictionAvailability("2026-10-05", null)).toEqual({
      status: "non-trading",
      date: "2026-10-05",
      reason: "2026-10-05 为休市/非交易日，未生成上午预测。"
    });
    expect(predictionAvailability("2026-09-30", null).status).toBe("not-run");
    expect(predictionAvailability("2026-09-30", null, "HTTP 503").status).toBe(
      "source-error"
    );
    expect(evaluationDisplayState(null, null)).toEqual({
      status: "unavailable",
      reason: "暂无预测可评估。"
    });
  });

  it("strictly excludes quotes newer than the feature timestamp", () => {
    const model = new BaselinePredictionModel();
    const result = model.predict({
      fund,
      predictionDate: "2026-10-05",
      targetTradeDate: "2026-10-05",
      featureTimestamp: "2026-10-05T10:30:00+08:00",
      quotes,
      holdings,
      holdingQuotes: holdingQuotes("2026-10-05T15:00:00+08:00"),
      artifact: initialModelArtifact("2026-10-05T10:30:00+08:00")
    });
    expect(result.featureCoverage).toBe(0);
    expect(result.dataQuality).toBe("unavailable");
  });

  it("discounts confidence for low coverage, unavailable bonds, QDII, and cold start", () => {
    const model = new BaselinePredictionModel();
    const result = model.predict({
      fund,
      predictionDate: "2026-10-05",
      targetTradeDate: "2026-10-05",
      featureTimestamp: "2026-10-05T10:30:00+08:00",
      quotes,
      holdings,
      holdingQuotes: holdingQuotes("2026-10-05T10:00:00+08:00"),
      artifact: initialModelArtifact("2026-10-05T10:30:00+08:00")
    });
    expect(result.featureCoverage).toBe(0.2);
    expect(result.confidence).toBeLessThan(0.3);
    expect(result.modelStatus).toBe("cold-start");
    expect(result.warnings.join(" ")).toContain("QDII");
  });

  it("calibrates only new evaluated samples and respects parameter bounds/minimum samples", () => {
    const model = new BaselinePredictionModel();
    let artifact = initialModelArtifact("2026-10-05T22:30:00+08:00");
    const samples: PredictionEvaluation[] = Array.from({ length: 25 }, (_, index) => ({
      evaluationKey: `e-${index}`,
      predictionKey: `p-${index}`,
      fundId: fund.id,
      targetTradeDate: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
      status: "evaluated",
      evaluatedAt: "2026-10-05T22:30:00+08:00",
      actualStartDate: "2026-09-01",
      actualEndDate: "2026-09-02",
      actualReturn: 0.01,
      error: 1,
      absoluteError: 1,
      squaredError: 1,
      directionCorrect: true,
      confidence: 0.5,
      confidenceBin: "medium",
      trainingApplied: false,
      reason: null
    }));
    artifact = model.calibrate(artifact, samples, "2026-10-05T22:30:00+08:00");
    expect(artifact.bias).toBe(0.03);
    expect(artifact.scale).toBeGreaterThanOrEqual(0.5);
    expect(model.calibrate(artifact, samples, "2026-10-06T22:30:00+08:00")).toEqual(artifact);
  });

  it("computes period metrics", () => {
    const evaluations: PredictionEvaluation[] = [
      {
        evaluationKey: "e",
        predictionKey: "p",
        fundId: fund.id,
        targetTradeDate: "2026-10-05",
        status: "evaluated",
        evaluatedAt: "2026-10-05T22:30:00+08:00",
        actualStartDate: "2026-10-02",
        actualEndDate: "2026-10-05",
        actualReturn: 0.02,
        error: 0.01,
        absoluteError: 0.01,
        squaredError: 0.0001,
        directionCorrect: true,
        confidence: 0.5,
        confidenceBin: "medium",
        trainingApplied: true,
        reason: null
      }
    ];
    expect(metricSet(evaluations)).toEqual({
      sampleCount: 1,
      directionAccuracy: 1,
      mae: 0.01,
      rmse: 0.01,
      meanError: 0.01
    });
  });
});
