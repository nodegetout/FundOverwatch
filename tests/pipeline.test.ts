import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  getBoundaryPeriods,
  isWorkday,
  mergeQuotes,
  providerForFund,
  retainQuotesForFund,
  shanghaiDate
} from "../scripts/pipeline";
import { parseFunds, type Quote } from "../src/lib/domain";

function quote(valuation: Quote["valuation"], nav: number): Quote {
  return {
    fundId: "test",
    date: "2026-10-02",
    nav,
    price: null,
    benchmarkPrice: null,
    currency: "CNY",
    valuation,
    quality: {
      status: "complete",
      source: "test",
      dataMode: "simulated",
      isSimulated: true,
      collectedAt: "2026-10-02T13:00:00+08:00",
      warnings: [],
      missingFields: []
    }
  };
}

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

  it("routes real CN funds and simulated markets to different providers", async () => {
    const funds = parseFunds(JSON.parse(await readFile("data/funds.json", "utf8")));
    expect(providerForFund(funds.find(({ id }) => id === "cn-025852")!).name).toBe(
      "eastmoney-fund-v2"
    );
    expect(providerForFund(funds.find(({ id }) => id === "us-spy")!).name).toBe(
      "deterministic-mock-v1"
    );
    const cnFund = funds.find(({ id }) => id === "cn-025852")!;
    expect(retainQuotesForFund(cnFund, Array.from({ length: 300 }, () => quote("final", 1)))).toHaveLength(
      260
    );
  });

  it("is idempotent and never lets intraday data replace a final value", () => {
    const final = quote("final", 1.25);
    expect(mergeQuotes([final], [final])).toEqual([final]);
    expect(mergeQuotes([final], [quote("intraday", 9.99)])).toEqual([final]);
    expect(mergeQuotes([quote("intraday", 1.2)], [final])).toEqual([final]);
  });
});
