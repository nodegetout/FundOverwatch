import type { Fund, HoldingsSnapshot, Quote } from "./domain";
import type { CollectionContext, FundDataProvider } from "./provider";

const profiles: Record<string, { base: number; drift: number; amplitude: number }> = {
  "us-spy": { base: 440, drift: 0.00038, amplitude: 8 },
  "hk-2800": { base: 19, drift: 0.00012, amplitude: 0.8 },
  "cn-510300": { base: 3.7, drift: 0.0002, amplitude: 0.2 },
  "jp-1321": { base: 33000, drift: 0.0003, amplitude: 900 }
};

const holdingsByMarket: Record<Fund["market"], Array<[string, string, string, string, number]>> = {
  US: [
    ["Apple", "AAPL", "Technology", "United States", 0.071],
    ["Microsoft", "MSFT", "Technology", "United States", 0.067],
    ["NVIDIA", "NVDA", "Technology", "United States", 0.061]
  ],
  HK: [
    ["Tencent", "0700", "Communication", "China", 0.082],
    ["AIA", "1299", "Financials", "Hong Kong", 0.073],
    ["HSBC", "0005", "Financials", "United Kingdom", 0.069]
  ],
  CN: [
    ["贵州茅台", "600519", "Consumer Staples", "China", 0.052],
    ["宁德时代", "300750", "Industrials", "China", 0.031],
    ["中国平安", "601318", "Financials", "China", 0.028]
  ],
  JP: [
    ["Fast Retailing", "9983", "Consumer Discretionary", "Japan", 0.105],
    ["Tokyo Electron", "8035", "Technology", "Japan", 0.073],
    ["SoftBank Group", "9984", "Communication", "Japan", 0.046]
  ],
  EU: [],
  OTHER: []
};

function daysSinceEpoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function round(value: number, precision = 4): number {
  return Number(value.toFixed(precision));
}

function groupAllocations(
  holdings: HoldingsSnapshot["holdings"],
  field: "sector" | "country"
): Array<{ name: string; weight: number }> {
  const grouped = new Map<string, number>();
  for (const holding of holdings) {
    grouped.set(holding[field], (grouped.get(holding[field]) ?? 0) + holding.weight);
  }
  const allocated = [...grouped.values()].reduce((sum, value) => sum + value, 0);
  grouped.set("Other", Math.max(0, 1 - allocated));
  return [...grouped.entries()]
    .map(([name, weight]) => ({ name, weight: round(weight) }))
    .sort((a, b) => b.weight - a.weight);
}

export class DeterministicMockProvider implements FundDataProvider {
  readonly name = "deterministic-mock-v1";

  async collectQuote(fund: Fund, context: CollectionContext): Promise<Quote> {
    const profile = profiles[fund.id];
    if (!profile) {
      throw new Error(`No deterministic profile configured for ${fund.id}`);
    }
    const day = daysSinceEpoch(context.date);
    const seasonal = Math.sin(day / 11 + fund.symbol.length) * profile.amplitude;
    const trend = (day - 19_000) * profile.drift * profile.base;
    const nav = Math.max(profile.base * 0.35, profile.base + trend + seasonal);
    const intradayFactor = context.mode === "intraday" ? 1 + Math.sin(day) * 0.0008 : 1;
    const price = nav * (1 + Math.cos(day / 7) * 0.0015) * intradayFactor;
    const benchmarkPrice = nav / profile.base * 100 * (1 - Math.sin(day / 29) * 0.002);
    return {
      fundId: fund.id,
      date: context.date,
      nav: round(nav),
      price: round(price),
      benchmarkPrice: round(benchmarkPrice),
      currency: fund.currency,
      quality: {
        status: "complete",
        source: this.name,
        isSimulated: true,
        collectedAt: context.collectedAt,
        warnings: ["Deterministic simulated data; not a live market quote."],
        missingFields: []
      }
    };
  }

  async collectHoldings(fund: Fund, context: CollectionContext): Promise<HoldingsSnapshot> {
    const holdings = (holdingsByMarket[fund.market] ?? []).map(
      ([name, symbol, sector, country, weight]) => ({ name, symbol, sector, country, weight })
    );
    return {
      fundId: fund.id,
      date: context.date,
      holdings,
      sectors: groupAllocations(holdings, "sector"),
      countries: groupAllocations(holdings, "country"),
      quality: {
        status: holdings.length ? "complete" : "partial",
        source: this.name,
        isSimulated: true,
        collectedAt: context.collectedAt,
        warnings: ["Illustrative top holdings; weights outside the top holdings are grouped as Other."],
        missingFields: holdings.length ? [] : ["holdings"]
      }
    };
  }
}
