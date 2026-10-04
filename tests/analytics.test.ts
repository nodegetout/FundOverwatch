import { describe, expect, it } from "vitest";
import { calculateAnalytics, latestOnOrBefore, percentageChange } from "../src/lib/analytics";
import type { Quote } from "../src/lib/domain";

function quote(date: string, price: number | null, benchmarkPrice = price): Quote {
  return {
    fundId: "test",
    date,
    nav: price,
    price,
    benchmarkPrice,
    currency: "USD",
    quality: {
      status: "complete",
      source: "test",
      isSimulated: true,
      collectedAt: `${date}T13:00:00+08:00`,
      warnings: [],
      missingFields: []
    }
  };
}

describe("analytics", () => {
  it("handles zero bases and missing values", () => {
    expect(percentageChange(10, 0)).toBeNull();
    expect(percentageChange(null, 10)).toBeNull();
  });

  it("selects the latest observation on or before a boundary", () => {
    const quotes = [quote("2026-01-02", 10), quote("2026-01-05", 11)];
    expect(latestOnOrBefore(quotes, "2026-01-04")?.date).toBe("2026-01-02");
  });

  it("calculates returns, moving averages, volatility, and drawdown", () => {
    const quotes = Array.from({ length: 70 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      return quote(date, 100 + index);
    });
    const result = calculateAnalytics("test", quotes);
    expect(result?.returns.day).toBeCloseTo(1 / 168);
    expect(result?.movingAverages.day20).toBeCloseTo(159.5);
    expect(result?.movingAverages.day60).toBeCloseTo(139.5);
    expect(result?.annualizedVolatility).not.toBeNull();
    expect(result?.maxDrawdown).toBe(0);
  });
});
