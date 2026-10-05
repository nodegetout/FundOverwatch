import type { Fund, HoldingQuoteBatch, HoldingsSnapshot, Quote } from "./domain";

export interface CollectionContext {
  date: string;
  collectedAt: string;
  mode: "intraday" | "final";
  runKey: string;
}

export interface FundDataProvider {
  readonly name: string;
  collectFund(fund: Fund, context: CollectionContext): Promise<{
    quotes: Quote[];
    holdings: HoldingsSnapshot;
    historicalHoldings: HoldingsSnapshot[];
    holdingQuotes: HoldingQuoteBatch;
  }>;
}
