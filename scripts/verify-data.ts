import { readFile } from "node:fs/promises";
import { siteIndexSchema } from "../src/lib/domain";
import {
  evaluationSchema,
  metricSetSchema,
  predictionSchema
} from "../src/lib/prediction-contract";

const index = siteIndexSchema.parse(
  JSON.parse(await readFile("public/data/index.json", "utf8")) as unknown
);
const expectedSymbols = [
  "025852",
  "002983",
  "005051",
  "018736",
  "001595",
  "161723",
  "018993",
  "017641"
];
if (index.summaries.map(({ fund }) => fund.symbol).join(",") !== expectedSymbols.join(",")) {
  throw new Error("Generated index must contain exactly the eight configured China funds.");
}
if (
  index.dataMode !== "real" ||
  index.summaries.some(
    ({ fund, latestQuote }) =>
      fund.market !== "CN" ||
      !fund.providerRef.startsWith("eastmoney:") ||
      latestQuote?.quality.dataMode !== "real" ||
      latestQuote.quality.isSimulated
  )
) {
  throw new Error("Generated production output must contain only real China fund data.");
}
for (const summary of index.summaries) {
  if (!summary.analytics || summary.analytics.observations < 2) {
    throw new Error(`Insufficient analytics observations for ${summary.fund.id}.`);
  }
  if (!summary.holdings?.holdings.length || !summary.holdingQuotes) {
    throw new Error(`Missing disclosed holdings or quote status for ${summary.fund.id}.`);
  }
  if (summary.prediction !== null) predictionSchema.parse(summary.prediction);
  if (summary.evaluation !== null) evaluationSchema.parse(summary.evaluation);
  if (summary.rollingMetrics !== null) metricSetSchema.parse(summary.rollingMetrics);
}
const serialized = JSON.stringify(index);
if (/deterministic-mock|simulated|us-spy|hk-2800|jp-1321/.test(serialized)) {
  throw new Error("Legacy market or simulated production data remains in the public index.");
}
console.log(`Validated China-only prediction index for ${index.summaries.length} funds as of ${index.asOf}.`);
