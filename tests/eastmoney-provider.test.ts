import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Eastmoney request retries", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
      vi.spyOn(Math, "random").mockReturnValue(0);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each([408, 429, 500, 502, 503, 599])(
      "retries HTTP %i and returns only recovered real data",
      async (status) => {
        const request = successfulFetch();
        request.mockResolvedValueOnce(new Response(null, { status }));
        const pending = new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context);
        await vi.advanceTimersByTimeAsync(124);
        expect(request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        expect(result.quotes.at(-1)?.nav).toBe(0.8979);
        expect(result.quotes.at(-1)?.quality.isSimulated).toBe(false);
        expect(request).toHaveBeenCalledTimes(6);
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it.each([
      new TypeError("fetch failed"),
      new DOMException("request timed out", "TimeoutError"),
      new DOMException("request aborted", "AbortError")
    ])("retries transport failure $name with exponential backoff", async (cause) => {
      const request = successfulFetch();
      request.mockRejectedValueOnce(cause).mockRejectedValueOnce(cause);
      const pending = new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context);
      await vi.advanceTimersByTimeAsync(124);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(249);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).quotes).toHaveLength(2);
      expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([0, 0.5, 0.996])("applies bounded jitter at random=%s", async (random) => {
      vi.mocked(Math.random).mockReturnValue(random);
      const request = successfulFetch();
      request.mockRejectedValueOnce(new TypeError("offline"));
      const pending = new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context);
      const delay = 250 * (0.5 + random * 0.5);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(request).toHaveBeenCalledTimes(6);
    });

    it.each([
      ["2", 2_000],
      ["0.5", 500],
      ["Mon, 05 Oct 2026 00:00:03 GMT", 3_000],
      ["999999999999999999999999999999999999", 30_000],
      ["Tue, 05 Oct 2027 00:00:00 GMT", 30_000],
      ["invalid", 125],
      ["-1", 125],
      ["0", 125],
      ["Sun, 04 Oct 2026 00:00:00 GMT", 125]
    ])("bounds Retry-After %s to %i ms", async (header, delay) => {
      const request = successfulFetch();
      request.mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": header } })
      );
      const pending = new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(request).toHaveBeenCalledTimes(6);
    });

    it.each([400, 401, 403, 404, 409, 422])(
      "does not retry permanent HTTP %i and includes endpoint/fund/status diagnostics",
      async (status) => {
        const request = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, { status, headers: { "Retry-After": "30" } })
        );
        const error = await new EastmoneyNavProvider({ fetch: request })
          .collectFund(fund, context).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: expect.stringContaining(`HTTP ${status}`),
          cause: expect.objectContaining({ message: expect.stringContaining(`HTTP ${status}`) })
        });
        expect((error as Error).message).toContain("metadata for fund 025852 (cn-025852)");
        expect((error as Error).message).toContain(
          "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation"
        );
        expect((error as Error).message).toContain("after 1 attempt:");
        expect(request).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it("exhausts the retry budget and preserves the last original network cause", async () => {
      const cause = new TypeError("connection reset");
      const request = vi.fn<typeof fetch>().mockRejectedValue(cause);
      const pending = new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context)
        .catch((failure: unknown) => failure);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({
        message: expect.stringContaining("after 3 attempts: connection reset"),
        cause
      });
      expect((error as Error).cause).toBe(cause);
      expect(request).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("uses a fresh timeout signal on each bounded attempt", async () => {
      const signals: AbortSignal[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        const controller = new AbortController();
        signals.push(controller.signal);
        setTimeout(() => {
          controller.abort(new DOMException("request timed out", "TimeoutError"));
        }, milliseconds);
        return controller.signal;
      });
      const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const pending = new EastmoneyNavProvider({ fetch: request, timeoutMs: 10 })
        .collectFund(fund, context).catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(9);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 + 125 + 10 + 250);
      expect(request).toHaveBeenCalledTimes(3);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect((error as Error).cause).toBe(signals[2]?.reason);
      expect((error as Error).message).toContain("after 3 attempts: request timed out");
      expect(new Set(signals).size).toBe(3);
      expect(AbortSignal.timeout).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds an explicit maximum retry budget and stops immediately after exhaustion", async () => {
      const request = vi.fn<typeof fetch>().mockImplementation(async () =>
        new Response("unavailable", { status: 503, headers: { "Retry-After": "999999" } })
      );
      const pending = new EastmoneyNavProvider({ fetch: request, retries: 5 })
        .collectFund(fund, context).catch((failure: unknown) => failure);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await vi.advanceTimersByTimeAsync(29_999);
        expect(request).toHaveBeenCalledTimes(attempt);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect((await pending as Error).message).toContain("after 6 attempts: HTTP 503");
      expect(request).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not retry or replace the original malformed JSON cause", async () => {
      const cause = new SyntaxError("Unexpected token in JSON");
      const response = jsonResponse({});
      vi.spyOn(response, "json").mockRejectedValue(cause);
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context)
        .catch((failure: unknown) => failure);
      expect((error as Error).cause).toBe(cause);
      expect((error as Error).message).toContain("Unexpected token in JSON");
      expect(request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not retry JSON schema validation failures", async () => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ bad: true }));
      await expect(new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context))
        .rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retries a connection failure while reading the response body", async () => {
      const response = jsonResponse({});
      vi.spyOn(response, "json").mockRejectedValue(new TypeError("terminated"));
      const request = successfulFetch();
      request.mockResolvedValueOnce(response);
      const pending = new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context);
      await vi.runAllTimersAsync();
      expect((await pending).quotes).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(6);
    });

    it("reports exhausted HTTP status with the configured NAV endpoint and page", async () => {
      const request = successfulFetch();
      const fallback = request.getMockImplementation()!;
      request.mockImplementation(async (input, init) => {
        if (new URL(String(input)).pathname === "/nav") {
          return new Response(null, { status: 503, statusText: "Service Unavailable" });
        }
        return fallback(input, init);
      });
      const pending = new EastmoneyNavProvider({
        fetch: request,
        navEndpoint: "https://example.test/nav"
      }).collectFund(fund, context).catch((failure: unknown) => failure);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect((error as Error).message).toContain("NAV page 1 for fund 025852 (cn-025852)");
      expect((error as Error).message).toContain("https://example.test/nav");
      expect((error as Error).message).toContain("after 3 attempts: HTTP 503 Service Unavailable");
      expect(request).toHaveBeenCalledTimes(4);
    });

    it("retains honest unavailable historical holdings with request diagnostics", async () => {
      const request = successfulFetch();
      const fallback = request.getMockImplementation()!;
      request.mockImplementation(async (input, init) => {
        if (new URL(String(input)).searchParams.has("DATE")) {
          return new Response(null, { status: 404 });
        }
        return fallback(input, init);
      });
      const result = await new EastmoneyNavProvider({ fetch: request }).collectFund(fund, context);
      expect(result.historicalHoldings).toEqual([]);
      expect(result.holdings.previousDate).toBeNull();
      expect(result.holdings.quality.warnings.join(" ")).toContain(
        "holdings for fund 025852 on 2026-03-31"
      );
      expect(result.holdings.quality.warnings.join(" ")).toContain("HTTP 404");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("evicts rejected shared quote promises so a subsequent collection can recover", async () => {
      const request = successfulFetch();
      const fallback = request.getMockImplementation()!;
      let quoteRequests = 0;
      request.mockImplementation(async (input, init) => {
        if (new URL(String(input)).hostname === "push2.eastmoney.com") {
          quoteRequests += 1;
          if (quoteRequests <= 3) throw new TypeError("quote connection reset");
        }
        return fallback(input, init);
      });
      const provider = new EastmoneyNavProvider({ fetch: request });
      const pending = Promise.all([
        provider.collectFund(fund, context),
        provider.collectFund(fund, context)
      ]);
      await vi.runAllTimersAsync();
      for (const result of await pending) {
        const quote = result.holdingQuotes.quotes.find(({ assetKey }) => assetKey === "stock:600001");
        expect(quote).toMatchObject({ status: "unavailable", dayChange: null, asOf: null });
        expect(quote?.warnings.join(" ")).toContain("quote 1.600001 for fund 025852");
        expect(quote?.warnings.join(" ")).toContain("https://push2.eastmoney.com/api/qt/stock/get");
        expect(quote?.warnings.join(" ")).toContain("after 3 attempts: quote connection reset");
      }
      expect(quoteRequests).toBe(3);
      const recovered = await provider.collectFund(fund, context);
      expect(recovered.holdingQuotes.quotes.find(({ assetKey }) => assetKey === "stock:600001"))
        .toMatchObject({ status: "available", dayChange: 0.0123 });
      await provider.collectFund(fund, context);
      expect(quoteRequests).toBe(4);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("honors retries=0 without scheduling backoff", async () => {
      const cause = new TypeError("offline");
      const request = vi.fn<typeof fetch>().mockRejectedValue(cause);
      await expect(new EastmoneyNavProvider({ fetch: request, retries: 0 })
        .collectFund(fund, context)).rejects.toMatchObject({ cause });
      expect(request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([-1, 0.5, 6, Infinity, NaN])("rejects unbounded/invalid retry budget %s", (retries) => {
      expect(() => new EastmoneyNavProvider({ retries })).toThrow(RangeError);
    });
});

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
