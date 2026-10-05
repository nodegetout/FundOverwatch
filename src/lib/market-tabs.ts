import type { Fund } from "./domain";

export type MarketFilter = Fund["market"] | "all";

export function filterFundIds(
  funds: Array<Pick<Fund, "id" | "market">>,
  market: MarketFilter
): string[] {
  return funds.filter((fund) => market === "all" || fund.market === market).map(({ id }) => id);
}

export function adjacentTabIndex(
  currentIndex: number,
  tabCount: number,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End"
): number {
  if (tabCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  const offset = key === "ArrowRight" ? 1 : -1;
  return (currentIndex + offset + tabCount) % tabCount;
}
