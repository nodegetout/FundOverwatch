import { describe, expect, it, vi } from "vitest";
import { EastmoneyNavProvider, holdingKey } from "../src/lib/eastmoney-provider";
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
  runKey: "2026-10-05:intraday:mixed-v2",
  collectedAt: "2026-10-05T03:00:00+08:00"
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

const stock = (
  code: string,
  name: string,
  weight: string,
  exchange: string | null,
  sector = "电子"
) => ({
  GPDM: code,
  GPJC: name,
  JZBL: weight,
  NEWTEXCH: exchange,
  INDEXNAME: sector
});

function positionPayload(
  date: string,
  options: {
    stocks?: ReturnType<typeof stock>[];
    bonds?: Array<{ ZQDM: string; ZQMC: string; ZJZBL: string }>;
    funds?: Array<{ TZJJDM: string; TZJJMC: string; ZJZBL: string }>;
    target?: [string, string] | null;
  }
) {
  return {
    Success: true,
    ErrCode: 0,
    ErrMsg: null,
    Expansion: date,
    Datas: {
      fundStocks: options.stocks ?? [],
      fundboods: options.bonds ?? [],
      fundfofs: options.funds ?? [],
      ETFCODE: options.target?.[0] ?? null,
      ETFSHORTNAME: options.target?.[1] ?? null
    }
  };
}

const currentPositions = positionPayload("2026-06-30", {
  stocks: [
    stock("600001", "当前股票", "10", "1"),
    stock("NOQUOTE", "无行情股票", "5", null, "--")
  ],
  bonds: [{ ZQDM: "BOND1", ZQMC: "示例债券", ZJZBL: "3" }],
  funds: [{ TZJJDM: "FUND1", TZJJMC: "示例基金", ZJZBL: "2" }],
  target: ["515290", "银行ETF天弘"]
});

const previousPositions = positionPayload("2026-03-31", {
  stocks: [
    stock("600001", "当前股票", "8", "1"),
    stock("600002", "退出股票", "4", "1")
  ],
  bonds: [{ ZQDM: "BOND1", ZQMC: "示例债券", ZJZBL: "3" }],
  funds: [{ TZJJDM: "FUND1", TZJJMC: "示例基金", ZJZBL: "2" }],
  target: ["515290", "银行ETF天弘"]
});

function navPayload() {
  return {
    ErrCode: 0,
    TotalCount: 2,
    Data: {
      LSJZList: [
        { FSRQ: "2026-09-30", DWJZ: "0.8979" },
        { FSRQ: "2026-09-29", DWJZ: "0.8924" }
      ]
    }
  };
}

function successfulFetch(quoteTimestamp = Date.parse("2026-10-05T07:00:00Z") / 1000) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("FundMNDetailInformation")) {
      return jsonResponse({ Datas: { FCODE: "025852", SHORTNAME: fund.name } });
    }
    if (url.pathname.includes("FundMNInverstPosition")) {
      return jsonResponse(url.searchParams.has("DATE") ? previousPositions : currentPositions);
    }
    if (url.hostname === "push2.eastmoney.com") {
      return jsonResponse({
        data: { f57: "600001", f58: "当前股票", f86: quoteTimestamp, f170: 123 }
      });
    }
    return jsonResponse(navPayload());
  });
}

describe("EastmoneyNavProvider", () => {
  it("normalizes stocks, bonds, funds, target ETF, and disclosure changes", async () => {
    const result = await new EastmoneyNavProvider({
      fetch: successfulFetch(),
      retries: 0
    }).collectFund(fund, context);

    expect(result.quotes.at(-1)).toMatchObject({
      date: "2026-09-30",
      valuation: "final",
      quality: { status: "stale", dataMode: "real", isSimulated: false }
    });
    expect(result.holdings).toMatchObject({
      date: "2026-06-30",
      previousDate: "2026-03-31",
      quality: { status: "complete" }
    });
    expect(result.historicalHoldings).toHaveLength(1);
    expect(new Set(result.holdings.holdings.map(({ assetType }) => assetType))).toEqual(
      new Set(["stock", "bond", "fund", "target-etf"])
    );

    const byKey = new Map(result.holdings.holdings.map((holding) => [holdingKey(holding), holding]));
    expect(byKey.get("stock:600001")).toMatchObject({
      weight: 0.1,
      previousWeight: 0.08,
      weightChange: 0.02,
      changeStatus: "increased",
      sector: "电子",
      country: null
    });
    expect(byKey.get("stock:NOQUOTE")).toMatchObject({
      previousWeight: 0,
      changeStatus: "new",
      quoteRef: null
    });
    expect(byKey.get("stock:600002")).toMatchObject({
      weight: 0,
      previousWeight: 0.04,
      weightChange: -0.04,
      changeStatus: "exited"
    });
    expect(byKey.get("target-etf:515290")).toMatchObject({
      weight: null,
      changeStatus: "unavailable"
    });
  });

  it("records successful, stale, and unavailable per-asset quotes without faking values", async () => {
    const available = await new EastmoneyNavProvider({
      fetch: successfulFetch(),
      retries: 0
    }).collectFund(fund, context);
    expect(available.holdingQuotes.quotes.find(({ assetKey }) => assetKey === "stock:600001"))
      .toMatchObject({ status: "available", dayChange: 0.0123 });
    expect(available.holdingQuotes.quotes.find(({ assetKey }) => assetKey === "bond:BOND1"))
      .toMatchObject({ status: "unavailable", dayChange: null, asOf: null });

    const stale = await new EastmoneyNavProvider({
      fetch: successfulFetch(Date.parse("2026-10-02T07:00:00Z") / 1000),
      retries: 0
    }).collectFund(fund, context);
    expect(stale.holdingQuotes.quotes.find(({ assetKey }) => assetKey === "stock:600001"))
      .toMatchObject({ status: "stale", dayChange: 0.0123 });
  });

  it("produces a stable disclosure hash for the same report content", async () => {
    const first = await new EastmoneyNavProvider({
      fetch: successfulFetch(),
      retries: 0
    }).collectFund(fund, context);
    const second = await new EastmoneyNavProvider({
      fetch: successfulFetch(),
      retries: 0
    }).collectFund(fund, { ...context, collectedAt: "2026-10-05T13:00:00+08:00" });
    expect(second.holdings.contentHash).toBe(first.holdings.contentHash);
  });

  it("rejects code mismatches, empty holdings, and malformed holdings", async () => {
    const mismatch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ Datas: { FCODE: "000001", SHORTNAME: "wrong" } })
    );
    await expect(
      new EastmoneyNavProvider({ fetch: mismatch, retries: 0 }).collectFund(fund, context)
    ).rejects.toThrow("fund code mismatch");

    const empty = successfulFetch();
    empty.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("FundMNDetailInformation")) {
        return jsonResponse({ Datas: { FCODE: "025852", SHORTNAME: fund.name } });
      }
      if (url.pathname.includes("FundMNInverstPosition")) {
        return jsonResponse(positionPayload("2026-06-30", {}));
      }
      return jsonResponse(navPayload());
    });
    await expect(
      new EastmoneyNavProvider({ fetch: empty, retries: 0 }).collectFund(fund, context)
    ).rejects.toThrow("empty current holdings");

    const malformed = successfulFetch();
    malformed.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("FundMNDetailInformation")) {
        return jsonResponse({ Datas: { FCODE: "025852", SHORTNAME: fund.name } });
      }
      if (url.pathname.includes("FundMNInverstPosition")) return jsonResponse({ bad: true });
      return jsonResponse(navPayload());
    });
    await expect(
      new EastmoneyNavProvider({ fetch: malformed, retries: 0 }).collectFund(fund, context)
    ).rejects.toThrow();
  });
});
