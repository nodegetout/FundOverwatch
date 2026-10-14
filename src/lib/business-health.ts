import type { SiteIndex } from "./domain";
import { predictionSchema } from "./prediction-contract";
import { isMainlandTradingDay } from "./trading-calendar";
import type { RunPhase } from "./run-timing";

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function businessHealth(
  index: SiteIndex,
  date: string,
  phase: RunPhase,
  now = new Date(),
  completedRunKeys: readonly string[] = []
): string[] {
  const issues: string[] = [];
  if (index.summaries.length !== 8) issues.push(`Expected 8 funds, found ${index.summaries.length}.`);
  if (Date.parse(index.generatedAt) > now.getTime()) issues.push("Index generation time is in the future.");
  if (["morning", "evening", "all"].includes(phase) &&
      (phase !== "morning" || isMainlandTradingDay(date)) &&
      !completedRunKeys.includes(`${date}:${phase}:cn-loop-v2`)) {
    issues.push(`No completed ${phase} collection for business date ${date}.`);
  }
  let expected = date;
  while (!isMainlandTradingDay(expected)) expected = addDays(expected, -1);
  for (const summary of index.summaries) {
    const prediction = predictionSchema.safeParse(summary.prediction);
    if (!prediction.success || prediction.data.predictionDate !== expected) {
      issues.push(`${summary.fund.id}: missing prediction for trading day ${expected}.`);
    }
    const latest = summary.latestQuote;
    if (!latest?.nav || latest.date > date) {
      issues.push(`${summary.fund.id}: missing or future NAV.`);
      continue;
    }
    let lag = 0;
    for (let day = addDays(latest.date, 1); day <= date; day = addDays(day, 1)) {
      if (isMainlandTradingDay(day)) lag += 1;
    }
    const allowance = summary.fund.name.includes("QDII") ? 3 : 1;
    if (lag > allowance) issues.push(`${summary.fund.id}: NAV ${latest.date} is ${lag} trading days old (limit ${allowance}).`);
  }
  return issues;
}
