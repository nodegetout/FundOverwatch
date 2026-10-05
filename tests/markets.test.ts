import { describe, expect, it } from "vitest";
import { adjacentTabIndex, filterFundIds } from "../src/lib/market-tabs";
import { marketLabel, marketLabels } from "../src/lib/markets";

describe("market presentation", () => {
  it("uses centralized Chinese name-code labels", () => {
    expect(marketLabel("CN")).toBe("中国大陆-CN");
    expect(marketLabels).toEqual({
      CN: "中国大陆-CN",
      HK: "中国香港-HK",
      US: "美国-US",
      JP: "日本-JP",
      EU: "欧洲-EU",
      OTHER: "其他市场-OTHER"
    });
  });

  it("filters funds for all and individual market tabs", () => {
    const funds = [
      { id: "cn-a", market: "CN" as const },
      { id: "us-a", market: "US" as const }
    ];
    expect(filterFundIds(funds, "all")).toEqual(["cn-a", "us-a"]);
    expect(filterFundIds(funds, "CN")).toEqual(["cn-a"]);
  });

  it("supports wrapping arrow navigation plus Home and End", () => {
    expect(adjacentTabIndex(0, 4, "ArrowLeft")).toBe(3);
    expect(adjacentTabIndex(3, 4, "ArrowRight")).toBe(0);
    expect(adjacentTabIndex(2, 4, "Home")).toBe(0);
    expect(adjacentTabIndex(1, 4, "End")).toBe(3);
  });
});
