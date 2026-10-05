import type { Fund } from "./domain";

export const marketLabels: Record<Fund["market"], string> = {
  CN: "中国大陆-CN"
};

export function marketLabel(market: Fund["market"]): string {
  return marketLabels[market];
}
