import type { Fund, HoldingsSnapshot, Quote } from "./domain";

export interface CollectionContext {
  date: string;
  collectedAt: string;
  mode: "intraday" | "final";
  runKey: string;
}

export interface FundDataProvider {
  readonly name: string;
  collectQuote(fund: Fund, context: CollectionContext): Promise<Quote>;
  collectHoldings(fund: Fund, context: CollectionContext): Promise<HoldingsSnapshot>;
}
