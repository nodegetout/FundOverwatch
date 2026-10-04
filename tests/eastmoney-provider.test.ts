import { describe, expect, it, vi } from "vitest";
import { EastmoneyNavProvider } from "../src/lib/eastmoney-provider";
import type { Fund } from "../src/lib/domain";

const fund: Fund = {
  id: "cn-025852",
  symbol: "025852",
  name: "富国港股精选混合(QDII)人民币",
  market: "CN",
  exchange: "中国公募基金",
  currency: "CNY",
  assetClass: "Mixed",
  benchmark: "benchmark",
  timezone: "Asia/Shanghai",
  inceptionDate: "2025-12-12",
  providerRef: "eastmoney:025852"
};

const context = {
  date: "2026-10-05",
  mode: "intraday" as const,
  runKey: "2026-10-05:intraday:mixed-v1",
  collectedAt: "2026-10-05T03:00:00+08:00"
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("FundMNDetailInformation")) {
      return jsonResponse({ Datas: { FCODE: "025852", SHORTNAME: fund.name } });
    }
    return jsonResponse({
      ErrCode: 0,
      TotalCount: 2,
      Data: {
        LSJZList: [
          { FSRQ: "2026-09-30", DWJZ: "0.8979" },
          { FSRQ: "2026-09-29", DWJZ: "0.8924" }
        ]
      }
    });
  });
}

describe("EastmoneyNavProvider", () => {
  it("normalizes historical unit NAV and marks an intraday refresh as stale final data", async () => {
    const request = successfulFetch();
    const result = await new EastmoneyNavProvider({ fetch: request, retries: 0 }).collectFund(
      fund,
      context
    );
    expect(result.quotes.map(({ date, nav }) => [date, nav])).toEqual([
      ["2026-09-29", 0.8924],
      ["2026-09-30", 0.8979]
    ]);
    expect(result.quotes.at(-1)).toMatchObject({
      valuation: "final",
      quality: { status: "stale", dataMode: "real", isSimulated: false }
    });
    expect(result.holdings.quality.missingFields).toContain("holdings");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched fund code", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      jsonResponse({ Datas: { FCODE: "000001", SHORTNAME: "wrong" } })
    );
    await expect(
      new EastmoneyNavProvider({ fetch: request, retries: 0 }).collectFund(fund, context)
    ).rejects.toThrow("fund code mismatch");
  });

  it("rejects empty and malformed NAV responses instead of returning a fallback", async () => {
    const emptyFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("FundMNDetailInformation")
        ? jsonResponse({ Datas: { FCODE: "025852", SHORTNAME: fund.name } })
        : jsonResponse({ ErrCode: 0, TotalCount: 0, Data: { LSJZList: [] } })
    );
    await expect(
      new EastmoneyNavProvider({ fetch: emptyFetch, retries: 0 }).collectFund(fund, context)
    ).rejects.toThrow("no NAV history");

    const malformedFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("FundMNDetailInformation")
        ? jsonResponse({ Datas: { FCODE: "025852", SHORTNAME: fund.name } })
        : jsonResponse({ unexpected: true })
    );
    await expect(
      new EastmoneyNavProvider({ fetch: malformedFetch, retries: 0 }).collectFund(fund, context)
    ).rejects.toThrow();
  });
});
