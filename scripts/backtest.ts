import { readFile } from "node:fs/promises";
import { evaluationSchema, metricSet, predictionSchema } from "../src/lib/prediction-contract";

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

const predictionYears = await readJson<string[]>("data/predictions/years.json", []);
const evaluationYears = await readJson<string[]>("data/evaluations/years.json", []);
const predictions = (
  await Promise.all(
    predictionYears.map((year) =>
      readJson<unknown[]>(`data/predictions/${year}/predictions.json`, [])
    )
  )
).flat().map((value) => predictionSchema.parse(value));
const evaluations = (
  await Promise.all(
    evaluationYears.map((year) =>
      readJson<unknown[]>(`data/evaluations/${year}/evaluations.json`, [])
    )
  )
).flat().map((value) => evaluationSchema.parse(value));

const ordered = predictions.every(
  (prediction) =>
    prediction.featureTimestamp.slice(0, 10) <= prediction.predictionDate &&
    prediction.predictionDate <= prediction.targetTradeDate
);
if (!ordered) throw new Error("Walk-forward check failed: prediction timestamps are not ordered.");

console.log(
  JSON.stringify(
    {
      mode: "walk-forward-audit",
      predictions: predictions.length,
      evaluated: evaluations.filter(({ status }) => status === "evaluated").length,
      metrics: metricSet(evaluations),
      limitation:
        predictions.length === 0
          ? "No historical feature snapshots are available; retrospective predictions are intentionally not synthesized."
          : "Only persisted real-time feature snapshots are evaluated; no historical holdings are backfilled with future disclosures."
    },
    null,
    2
  )
);
