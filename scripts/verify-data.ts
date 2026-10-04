import { readFile } from "node:fs/promises";
import { siteIndexSchema } from "../src/lib/domain";

const raw = JSON.parse(await readFile("public/data/index.json", "utf8")) as unknown;
const index = siteIndexSchema.parse(raw);
if (!index.summaries.length) throw new Error("Generated index contains no funds.");
if (index.summaries.some(({ analytics }) => !analytics || analytics.observations < 2)) {
  throw new Error("Generated analytics do not contain enough observations.");
}
const expectedCnSymbols = [
  "025852",
  "002983",
  "005051",
  "018736",
  "001595",
  "161723",
  "018993",
  "017641"
];
const cn = index.summaries.filter(({ fund }) => fund.market === "CN");
if (cn.map(({ fund }) => fund.symbol).join(",") !== expectedCnSymbols.join(",")) {
  throw new Error("Generated index does not contain the exact CN fund registry.");
}
if (cn.some(({ latestQuote }) => latestQuote?.quality.dataMode !== "real")) {
  throw new Error("Generated CN summaries must use real data.");
}
if (
  cn.some(
    ({ holdings, holdingQuotes }) =>
      !holdings?.holdings.length ||
      holdings.quality.dataMode !== "real" ||
      !holdingQuotes ||
      holdingQuotes.fundId !== holdings.fundId
  )
) {
  throw new Error("Generated CN summaries must contain real disclosed holdings and quote status.");
}
if (
  cn.some(
    ({ holdings, holdingQuotes }) =>
      holdings?.contentHash === "legacy" ||
      !holdings?.previousDate ||
      holdings.holdings.some(({ country }) => country !== null) ||
      holdingQuotes?.quotes.some(
        ({ asOf, dayChange, status }) =>
          (status === "unavailable" && (asOf !== null || dayChange !== null)) ||
          (status !== "unavailable" && (asOf === null || dayChange === null))
      )
  )
) {
  throw new Error("Generated CN holding disclosure or quote quality semantics are invalid.");
}
const bondFund = cn.find(({ fund }) => fund.symbol === "018736");
if (
  !bondFund ||
  !["stock", "bond", "fund"].every((assetType) =>
    bondFund.holdings?.holdings.some((holding) => holding.assetType === assetType)
  )
) {
  throw new Error("Bond fund multi-asset holdings are incomplete.");
}
const feeder = cn.find(({ fund }) => fund.symbol === "001595");
if (!feeder?.holdings?.holdings.some(({ assetType }) => assetType === "target-etf")) {
  throw new Error("ETF feeder target holding is missing.");
}
if (index.summaries.some(({ fund }) => fund.id === "cn-510300")) {
  throw new Error("Legacy simulated CN fund is still present.");
}
console.log(`Validated index for ${index.summaries.length} funds as of ${index.asOf}.`);
