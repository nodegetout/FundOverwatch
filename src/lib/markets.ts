import type { Fund } from "./domain";

export const marketLabels: Record<Fund["market"], string> = {
  CN: "中国大陆-CN",
  HK: "中国香港-HK",
  US: "美国-US",
  JP: "日本-JP",
  EU: "欧洲-EU",
  OTHER: "其他市场-OTHER"
};

export function marketLabel(market: Fund["market"]): string {
  return marketLabels[market];
}
