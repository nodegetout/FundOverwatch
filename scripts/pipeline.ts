import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  holdingQuoteBatchSchema,
  holdingsSnapshotSchema,
  parseFunds,
  quoteSchema,
  siteIndexSchema,
  type Fund,
  type HoldingsSnapshot,
  type Quote
} from "../src/lib/domain";
import { calculateAnalytics } from "../src/lib/analytics";
import { EastmoneyNavProvider } from "../src/lib/eastmoney-provider";
import { DeterministicMockProvider } from "../src/lib/mock-provider";
import type { CollectionContext, FundDataProvider } from "../src/lib/provider";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockProvider = new DeterministicMockProvider();
const eastmoneyProvider = new EastmoneyNavProvider();

export type RunMode = "intraday" | "final";

interface RunRecord {
  runKey: string;
  date: string;
  mode: RunMode;
  completedAt: string;
}

interface PeriodSummary {
  period: "week" | "month" | "year";
  periodKey: string;
  fundId: string;
  startDate: string;
  endDate: string;
  startPrice: number | null;
  endPrice: number | null;
  return: number | null;
  observations: number;
}

async function readJson<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonIfChanged(file: string, value: unknown): Promise<boolean> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let previous = "";
  try {
    previous = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return true;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWorkday(date: string): boolean {
  const day = weekday(date);
  return day !== 0 && day !== 6;
}

function previousWorkday(date: string): string {
  let candidate = addDays(date, -1);
  while (!isWorkday(candidate)) candidate = addDays(candidate, -1);
  return candidate;
}

function nextWorkday(date: string): string {
  let candidate = addDays(date, 1);
  while (!isWorkday(candidate)) candidate = addDays(candidate, 1);
  return candidate;
}

export function getBoundaryPeriods(date: string): Array<"week" | "month" | "year"> {
  if (!isWorkday(date)) return [];
  const periods: Array<"week" | "month" | "year"> = [];
  if (weekday(date) === 5) periods.push("week");
  const next = nextWorkday(date);
  if (next.slice(0, 7) !== date.slice(0, 7)) periods.push("month");
  if (next.slice(0, 4) !== date.slice(0, 4)) periods.push("year");
  return periods;
}

function scheduledTimestamp(date: string, mode: RunMode): string {
  return `${date}T${mode === "intraday" ? "03:00:00" : "13:00:00"}+08:00`;
}

function periodKey(period: PeriodSummary["period"], date: string): string {
  if (period === "month") return date.slice(0, 7);
  if (period === "year") return date.slice(0, 4);
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function periodQuotes(period: PeriodSummary["period"], date: string, quotes: Quote[]): Quote[] {
  const key = periodKey(period, date);
  return quotes.filter((quote) => periodKey(period, quote.date) === key);
}

function buildPeriodSummary(
  period: PeriodSummary["period"],
  date: string,
  fundId: string,
  quotes: Quote[]
): PeriodSummary | null {
  const selected = periodQuotes(period, date, quotes);
  const first = selected.at(0);
  const last = selected.at(-1);
  if (!first || !last) return null;
  const startPrice = first.price ?? first.nav;
  const endPrice = last.price ?? last.nav;
  return {
    period,
    periodKey: periodKey(period, date),
    fundId,
    startDate: first.date,
    endDate: last.date,
    startPrice,
    endPrice,
    return:
      startPrice === null || endPrice === null || startPrice === 0
        ? null
        : endPrice / startPrice - 1,
    observations: selected.length
  };
}

async function loadAllQuotes(fundId: string): Promise<Quote[]> {
  const historyDir = path.join(root, "data", "history", fundId);
  const years = await readJson<string[]>(path.join(historyDir, "years.json"), []);
  const quotes: Quote[] = [];
  for (const year of years) {
    const partition = await readJson<unknown[]>(path.join(historyDir, `${year}.json`), []);
    quotes.push(...partition.map((quote) => quoteSchema.parse(quote)));
  }
  return quotes.sort((a, b) => a.date.localeCompare(b.date));
}

async function saveQuotes(fund: Fund, quotes: Quote[]): Promise<void> {
  const byYear = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const year = quote.date.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), quote]);
  }

  const years = [...byYear.keys()].sort();
  const historyDir = path.join(root, "data", "history", fund.id);
  const previousYears = await readJson<string[]>(path.join(historyDir, "years.json"), []);
  for (const year of years) {
    await writeJsonIfChanged(path.join(historyDir, `${year}.json`), byYear.get(year));
  }
  for (const year of previousYears.filter((year) => !byYear.has(year))) {
    try {
      await unlink(path.join(historyDir, `${year}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeJsonIfChanged(path.join(historyDir, "years.json"), years);
}

async function saveHoldingsSnapshot(
  snapshot: HoldingsSnapshot,
  preserveExisting = false
): Promise<void> {
  const file = path.join(root, "data", "holdings", snapshot.fundId, `${snapshot.date}.json`);
  const existing = await readJson<unknown | null>(file, null);
  if (existing) {
    if (preserveExisting) return;
    const parsed = holdingsSnapshotSchema.parse(existing);
    if (parsed.contentHash === snapshot.contentHash) return;
  }
  await writeJsonIfChanged(file, snapshot);
}

export function mergeQuotes(quotes: Quote[], incoming: Quote[]): Quote[] {
  const byDate = new Map(quotes.map((quote) => [quote.date, quote]));
  for (const quote of incoming) {
    const existing = byDate.get(quote.date);
    if (existing?.valuation === "final" && quote.valuation === "intraday") continue;
    byDate.set(quote.date, quote);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function providerForFund(fund: Fund): FundDataProvider {
  if (fund.providerRef.startsWith("eastmoney:")) return eastmoneyProvider;
  if (fund.providerRef.startsWith("mock:")) return mockProvider;
  throw new Error(`No provider configured for ${fund.id}: ${fund.providerRef}`);
}

export function retainQuotesForFund(fund: Fund, quotes: Quote[]): Quote[] {
  return fund.providerRef.startsWith("eastmoney:") ? quotes.slice(-260) : quotes;
}

async function updatePeriodSummaries(fund: Fund, date: string, quotes: Quote[]): Promise<void> {
  for (const period of getBoundaryPeriods(date)) {
    const summary = buildPeriodSummary(period, date, fund.id, quotes);
    if (!summary) continue;
    const file = path.join(root, "data", "summaries", `${period}ly`, `${fund.id}.json`);
    const existing = await readJson<PeriodSummary[]>(file, []);
    const updated = existing.filter((entry) => entry.periodKey !== summary.periodKey);
    updated.push(summary);
    updated.sort((a, b) => a.periodKey.localeCompare(b.periodKey));
    await writeJsonIfChanged(file, updated);
  }
}

export function shanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function runPipeline(date: string, mode: RunMode): Promise<{ skipped: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  if (!isWorkday(date)) {
    console.log(`Skipping ${date}: weekend calendar rule. Real exchange calendars are not yet enabled.`);
    return { skipped: true };
  }

  const runKey = `${date}:${mode}:mixed-v2`;
  const runsFile = path.join(root, "data", "runs.json");
  const runs = await readJson<RunRecord[]>(runsFile, []);
  if (mode === "intraday" && runs.some((run) => run.runKey === `${date}:final:mixed-v2`)) {
    console.log(`Skipping ${runKey}: final data already exists for this date.`);
    return { skipped: true };
  }
  if (runs.some((run) => run.runKey === runKey)) {
    console.log(`Run ${runKey} already completed; no files changed.`);
    return { skipped: true };
  }

  const funds = parseFunds(await readJson<unknown>(path.join(root, "data", "funds.json")));
  const collectedAt = scheduledTimestamp(date, mode);
  const context: CollectionContext = { date, mode, collectedAt, runKey };
  const staged = [];

  for (const fund of funds) {
    const provider = providerForFund(fund);
    const existingQuotes = await loadAllQuotes(fund.id);
    const collected = await provider.collectFund(fund, context);
    const incomingQuotes = collected.quotes.map((quote) => quoteSchema.parse(quote));
    if (!incomingQuotes.length) throw new Error(`${provider.name} returned no quotes for ${fund.id}`);
    const holdings = holdingsSnapshotSchema.parse(collected.holdings);
    if (!holdings.holdings.length && fund.providerRef.startsWith("eastmoney:")) {
      throw new Error(`${provider.name} returned empty real holdings for ${fund.id}`);
    }
    const historicalHoldings = collected.historicalHoldings.map((snapshot) =>
      holdingsSnapshotSchema.parse(snapshot)
    );
    const holdingQuotes = holdingQuoteBatchSchema.parse(collected.holdingQuotes);
    const mergedQuotes = mergeQuotes(existingQuotes, incomingQuotes);
    const quotes = retainQuotesForFund(fund, mergedQuotes);
    const latestQuote = quotes.at(-1);
    if (!latestQuote) throw new Error(`No normalized quotes available for ${fund.id}`);
    const analytics = calculateAnalytics(fund.id, quotes);
    staged.push({
      fund,
      quotes,
      latestQuote,
      analytics,
      holdings,
      historicalHoldings,
      holdingQuotes
    });
  }

  for (const { fund, quotes, holdings, historicalHoldings, holdingQuotes } of staged) {
    await saveQuotes(fund, quotes);
    for (const snapshot of historicalHoldings) await saveHoldingsSnapshot(snapshot, true);
    await saveHoldingsSnapshot(holdings);
    await writeJsonIfChanged(
      path.join(root, "data", "holding-quotes", fund.id, `${date}.json`),
      holdingQuotes
    );
    if (mode === "final") {
      const latestDate = quotes.at(-1)?.date;
      if (latestDate) await updatePeriodSummaries(fund, latestDate, quotes);
    }
    await writeJsonIfChanged(
      path.join(root, "public", "data", "series", `${fund.id}.json`),
      quotes.slice(-260).map(({ date: quoteDate, nav, price, benchmarkPrice }) => ({
        date: quoteDate,
        nav,
        price,
        benchmarkPrice
      }))
    );
  }

  const summaries = staged.map(
    ({ fund, latestQuote, analytics, holdings, holdingQuotes }) => ({
    fund,
    latestQuote,
    analytics,
    holdings,
    holdingQuotes
    })
  );
  const dataStatus = summaries.every(
    ({ latestQuote, holdings }) =>
      latestQuote.quality.status === "complete" && holdings.quality.status === "complete"
  )
    ? "complete"
    : "partial";
  const index = siteIndexSchema.parse({
    generatedAt: collectedAt,
    asOf: summaries
      .map(({ latestQuote }) => latestQuote.date)
      .sort()
      .at(-1) ?? date,
    mode,
    dataStatus,
    dataMode:
      new Set(summaries.map(({ latestQuote }) => latestQuote.quality.dataMode)).size > 1
        ? "mixed"
        : summaries[0]?.latestQuote.quality.dataMode ?? "simulated",
    summaries
  });
  await writeJsonIfChanged(path.join(root, "public", "data", "index.json"), index);
  runs.push({ runKey, date, mode, completedAt: collectedAt });
  await writeJsonIfChanged(runsFile, runs);
  console.log(`Completed ${runKey} for ${funds.length} funds.`);
  return { skipped: false };
}

export { previousWorkday };
