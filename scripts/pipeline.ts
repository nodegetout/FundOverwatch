import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  holdingQuoteBatchSchema,
  holdingsSnapshotSchema,
  parseFunds,
  quoteSchema,
  siteIndexSchema,
  type Fund,
  type HoldingQuoteBatch,
  type HoldingsSnapshot,
  type Quote
} from "../src/lib/domain";
import { calculateAnalytics } from "../src/lib/analytics";
import { EastmoneyNavProvider } from "../src/lib/eastmoney-provider";
import {
  BaselinePredictionModel,
  evaluationSchema,
  initialModelArtifact,
  metricSet,
  modelArtifactSchema,
  periodReportSchema,
  predictionSchema,
  type FundPrediction,
  type ModelArtifact,
  type PeriodReport,
  type PredictionEvaluation
} from "../src/lib/prediction-contract";
import type { CollectionContext, FundDataProvider } from "../src/lib/provider";
import { predictionAvailability } from "../src/lib/prediction-status";
import {
  addDays,
  isMainlandTradingDay,
  lastTradingDate,
  mainlandTradingCalendar,
  tradingDatesBetween,
  tradingDayDecision,
  type TradingDayDecision
} from "../src/lib/trading-calendar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eastmoneyProvider = new EastmoneyNavProvider();
const model = new BaselinePredictionModel();

export type RunPhase = "morning" | "evening" | "weekly" | "monthly" | "yearly" | "all";
export type RunMode = "intraday" | "final";

interface RunRecord {
  runKey: string;
  date: string;
  phase: RunPhase;
  scheduledAt: string;
  actualRunAt: string;
  completedAt: string;
  calendarStatus: TradingDayDecision["status"];
  outcome: "completed" | "skipped";
  reason: string;
}

interface PipelineOptions {
  provider?: FundDataProvider;
  calendarOverride?: boolean;
  scheduledAt?: string;
  actualRunAt?: string;
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
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
  return true;
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWorkday(date: string): boolean {
  const day = weekday(date);
  return day !== 0 && day !== 6;
}

export function previousWorkday(date: string): string {
  let candidate = addDays(date, -1);
  while (!isWorkday(candidate)) candidate = addDays(candidate, -1);
  return candidate;
}

export function nextWorkday(date: string): string {
  let candidate = addDays(date, 1);
  while (!isWorkday(candidate)) candidate = addDays(candidate, 1);
  return candidate;
}

export function lastCalendarDate(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export interface PeriodGate {
  period: "weekly" | "monthly" | "yearly";
  periodKey: string;
  startDate: string;
  endDate: string;
  status: "provisional" | "final";
}

function isoWeek(date: string): { key: string; start: string; end: string } {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  const start = addDays(date, 1 - day);
  const end = addDays(start, 4);
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { key: `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, start, end };
}

export function periodCloseGates(date: string): PeriodGate[] {
  const [year, month] = date.split("-").map(Number) as [number, number, number];
  const gates: PeriodGate[] = [];
  const week = isoWeek(date);
  if (weekday(date) === 5) {
    gates.push({
      period: "weekly",
      periodKey: week.key,
      startDate: week.start,
      endDate: week.end,
      status: "final"
    });
  }
  const monthEnd = lastCalendarDate(year, month);
  const lastMonthTradingDate = lastTradingDate(`${date.slice(0, 7)}-01`, monthEnd);
  if (date === lastMonthTradingDate) {
    gates.push({
      period: "monthly",
      periodKey: date.slice(0, 7),
      startDate: `${date.slice(0, 7)}-01`,
      endDate: monthEnd,
      status: date === monthEnd ? "final" : "provisional"
    });
  }
  const yearEnd = `${year}-12-31`;
  const lastYearTradingDate = lastTradingDate(`${year}-01-01`, yearEnd);
  if (date === lastYearTradingDate) {
    gates.push({
      period: "yearly",
      periodKey: String(year),
      startDate: `${year}-01-01`,
      endDate: yearEnd,
      status: date === yearEnd ? "final" : "provisional"
    });
  }
  return gates;
}

export function catchUpPeriodGates(date: string): PeriodGate[] {
  if (!isMainlandTradingDay(date)) return [];
  const monthStart = `${date.slice(0, 7)}-01`;
  const firstTradingDate = tradingDatesBetween(
    monthStart,
    `${date.slice(0, 7)}-10`
  ).at(0);
  if (date !== firstTradingDate) return [];
  const previousDate = addDays(monthStart, -1);
  const [year, month] = previousDate.split("-").map(Number) as [number, number, number];
  const gates: PeriodGate[] = [
    {
      period: "monthly",
      periodKey: previousDate.slice(0, 7),
      startDate: `${previousDate.slice(0, 7)}-01`,
      endDate: lastCalendarDate(year, month),
      status: "final"
    }
  ];
  if (date.slice(5, 7) === "01") {
    gates.push({
      period: "yearly",
      periodKey: String(year),
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      status: "final"
    });
  }
  return gates;
}

export function getBoundaryPeriods(date: string): Array<"week" | "month" | "year"> {
  return periodCloseGates(date).map(({ period }) =>
    period === "weekly" ? "week" : period === "monthly" ? "month" : "year"
  );
}

export function orderPeriodGates(gates: PeriodGate[]): PeriodGate[] {
  const order = { weekly: 0, monthly: 1, yearly: 2 } as const;
  return [...gates].sort((left, right) => order[left.period] - order[right.period]);
}

export function scheduledTimestamp(date: string, phase: RunPhase): string {
  return `${date}T${phase === "morning" ? "10:30:00" : "22:30:00"}+08:00`;
}

export interface ScheduledRun {
  phase: "morning" | "evening";
  date: string;
  scheduledAt: string;
  actualRunAt: string;
  delayedAcrossShanghaiDate: boolean;
}

export function resolveScheduledRun(schedule: string, now = new Date()): ScheduledRun {
  const config =
    schedule === "30 2 * * 1-5"
      ? { phase: "morning" as const, hour: 2 }
      : schedule === "30 14 * * 1-5"
        ? { phase: "evening" as const, hour: 14 }
        : null;
  if (!config) throw new Error(`Unsupported workflow schedule: ${schedule}`);
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCHours(config.hour, 30, 0, 0);
  if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 1);
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  const date = shanghaiDate(candidate);
  return {
    phase: config.phase,
    date,
    scheduledAt: scheduledTimestamp(date, config.phase),
    actualRunAt: now.toISOString(),
    delayedAcrossShanghaiDate: shanghaiDate(now) !== date
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
  return quotes.sort((left, right) => left.date.localeCompare(right.date));
}

async function saveQuotes(fund: Fund, quotes: Quote[]): Promise<void> {
  const byYear = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const year = quote.date.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), quote]);
  }
  const historyDir = path.join(root, "data", "history", fund.id);
  const previousYears = await readJson<string[]>(path.join(historyDir, "years.json"), []);
  for (const [year, values] of byYear) {
    await writeJsonIfChanged(path.join(historyDir, `${year}.json`), values);
  }
  for (const year of previousYears.filter((year) => !byYear.has(year))) {
    try {
      await unlink(path.join(historyDir, `${year}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeJsonIfChanged(path.join(historyDir, "years.json"), [...byYear.keys()].sort());
}

async function saveHoldings(snapshot: HoldingsSnapshot, preserveExisting = false): Promise<void> {
  const file = path.join(root, "data", "holdings", snapshot.fundId, `${snapshot.date}.json`);
  const existing = await readJson<unknown | null>(file, null);
  if (existing) {
    if (preserveExisting) return;
    if (holdingsSnapshotSchema.parse(existing).contentHash === snapshot.contentHash) return;
  }
  await writeJsonIfChanged(file, snapshot);
}

export function mergeQuotes(existing: Quote[], incoming: Quote[]): Quote[] {
  const byDate = new Map(existing.map((quote) => [quote.date, quote]));
  for (const quote of incoming) byDate.set(quote.date, quote);
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-260);
}

export function providerForFund(fund: Fund): FundDataProvider {
  if (fund.providerRef.startsWith("eastmoney:")) return eastmoneyProvider;
  throw new Error(`No real provider configured for ${fund.id}: ${fund.providerRef}`);
}

export function retainQuotesForFund(_fund: Fund, quotes: Quote[]): Quote[] {
  return quotes.slice(-260);
}

export function evaluatePrediction(
  prediction: FundPrediction,
  quotes: Quote[],
  evaluatedAt: string,
  previous?: PredictionEvaluation
): PredictionEvaluation {
  const sorted = quotes.filter(({ nav }) => nav !== null).sort((a, b) => a.date.localeCompare(b.date));
  const actual = sorted.find(({ date }) => date === prediction.targetTradeDate);
  const prior = sorted.filter(({ date }) => date < prediction.targetTradeDate).at(-1);
  if (!actual?.nav || !prior?.nav) {
    return evaluationSchema.parse({
      evaluationKey: prediction.predictionKey,
      predictionKey: prediction.predictionKey,
      fundId: prediction.fundId,
      targetTradeDate: prediction.targetTradeDate,
      status: "pending",
      evaluatedAt,
      actualStartDate: prior?.date ?? null,
      actualEndDate: null,
      actualReturn: null,
      error: null,
      absoluteError: null,
      squaredError: null,
      directionCorrect: null,
      confidence: prediction.confidence,
      confidenceBin: prediction.confidence < 0.34 ? "low" : prediction.confidence < 0.67 ? "medium" : "high",
      trainingApplied: previous?.trainingApplied ?? false,
      reason: `目标净值 ${prediction.targetTradeDate} 尚未披露，将在后续晚间运行补评。`
    });
  }
  const actualReturn = actual.nav / prior.nav - 1;
  const error = actualReturn - prediction.predictedReturn;
  const actualDirection = actualReturn > 0.0005 ? "up" : actualReturn < -0.0005 ? "down" : "flat";
  return evaluationSchema.parse({
    evaluationKey: prediction.predictionKey,
    predictionKey: prediction.predictionKey,
    fundId: prediction.fundId,
    targetTradeDate: prediction.targetTradeDate,
    status: "evaluated",
    evaluatedAt,
    actualStartDate: prior.date,
    actualEndDate: actual.date,
    actualReturn,
    error,
    absoluteError: Math.abs(error),
    squaredError: error ** 2,
    directionCorrect: actualDirection === prediction.direction,
    confidence: prediction.confidence,
    confidenceBin: prediction.confidence < 0.34 ? "low" : prediction.confidence < 0.67 ? "medium" : "high",
    trainingApplied: previous?.trainingApplied ?? false,
    reason: null
  });
}

function groupMetrics(
  evaluations: PredictionEvaluation[],
  key: (evaluation: PredictionEvaluation) => string
): Record<string, ReturnType<typeof metricSet>> {
  const groups = new Map<string, PredictionEvaluation[]>();
  for (const evaluation of evaluations) {
    const value = key(evaluation);
    groups.set(value, [...(groups.get(value) ?? []), evaluation]);
  }
  return Object.fromEntries([...groups].map(([group, values]) => [group, metricSet(values)]));
}

async function allPredictions(): Promise<FundPrediction[]> {
  const years = await readJson<string[]>(path.join(root, "data", "predictions", "years.json"), []);
  const result: FundPrediction[] = [];
  for (const year of years) {
    const values = await readJson<unknown[]>(path.join(root, "data", "predictions", year, "predictions.json"), []);
    result.push(...values.map((value) => predictionSchema.parse(value)));
  }
  return result;
}

async function allEvaluations(): Promise<PredictionEvaluation[]> {
  const years = await readJson<string[]>(path.join(root, "data", "evaluations", "years.json"), []);
  const result: PredictionEvaluation[] = [];
  for (const year of years) {
    const values = await readJson<unknown[]>(path.join(root, "data", "evaluations", year, "evaluations.json"), []);
    result.push(...values.map((value) => evaluationSchema.parse(value)));
  }
  return result;
}

async function saveYearPartition<T>(
  base: "predictions" | "evaluations",
  date: string,
  fileName: string,
  values: T[]
): Promise<void> {
  const year = date.slice(0, 4);
  await writeJsonIfChanged(path.join(root, "data", base, year, fileName), values);
  const yearsFile = path.join(root, "data", base, "years.json");
  const years = await readJson<string[]>(yearsFile, []);
  await writeJsonIfChanged(yearsFile, [...new Set([...years, year])].sort());
}

async function loadArtifact(at: string): Promise<ModelArtifact> {
  const file = path.join(root, "data", "models", "cn-baseline-v1.json");
  const raw = await readJson<unknown | null>(file, null);
  return raw ? modelArtifactSchema.parse(raw) : initialModelArtifact(at);
}

async function createReports(
  gates: PeriodGate[],
  evaluations: PredictionEvaluation[],
  predictions: FundPrediction[],
  artifact: ModelArtifact,
  generatedAt: string
): Promise<PeriodReport[]> {
  const reports: PeriodReport[] = [];
  for (const gate of gates) {
    const report = periodReportForGate(gate, evaluations, predictions, artifact, generatedAt);
    const file = path.join(root, "data", "reports", gate.period, `${gate.periodKey}.json`);
    await writeJsonIfChanged(file, report);
    reports.push(report);
  }
  return reports;
}

export function periodReportForGate(
  gate: PeriodGate,
  evaluations: PredictionEvaluation[],
  predictions: FundPrediction[],
  artifact: ModelArtifact,
  generatedAt: string
): PeriodReport {
  const predictionByKey = new Map(predictions.map((prediction) => [prediction.predictionKey, prediction]));
  const tradingDates = tradingDatesBetween(gate.startDate, gate.endDate);
  const selected = evaluations.filter(
    ({ targetTradeDate }) => targetTradeDate >= gate.startDate && targetTradeDate <= gate.endDate
  );
  const evaluated = selected.filter(({ status }) => status === "evaluated");
  const pending = selected.filter(({ status }) => status === "pending");
  const sorted = [...evaluated].sort(
    (left, right) => (left.absoluteError ?? Infinity) - (right.absoluteError ?? Infinity)
  );
  const status =
    selected.length === 0
      ? "no-data"
      : pending.length > 0 || gate.status === "provisional"
        ? "provisional"
        : "final";
  return periodReportSchema.parse({
    reportKey: `${gate.period}:${gate.periodKey}`,
    period: gate.period,
    periodKey: gate.periodKey,
    startDate: gate.startDate,
    endDate: gate.endDate,
    lastTradingDate: tradingDates.at(-1) ?? null,
    status,
    statusReason:
      status === "no-data"
        ? "报告期内没有预测/评估交易样本，已跳过模型与指标更新。"
        : status === "provisional"
          ? `仍有 ${pending.length} 个目标 NAV 未披露；后续晚间运行将幂等替换本报告。`
          : "报告期内预测样本均已完成 NAV 对齐。",
    generatedAt,
    modelVersion: model.version,
    metrics: metricSet(evaluated),
    missingRate: selected.length ? selected.filter(({ status }) => status !== "evaluated").length / selected.length : 1,
    missingNavCount: pending.length,
    tradingDateCount: tradingDates.length,
    calendarSource: mainlandTradingCalendar.market,
    calendarAsOf: mainlandTradingCalendar.asOf,
    byFund: groupMetrics(evaluated, ({ fundId }) => fundId),
    byConfidence: groupMetrics(evaluated, ({ confidenceBin }) => confidenceBin),
    byCoverage: groupMetrics(evaluated, (evaluation) => {
      const coverage = predictionByKey.get(evaluation.predictionKey)?.featureCoverage ?? 0;
      return coverage < 0.3 ? "low" : coverage < 0.7 ? "medium" : "high";
    }),
    bestCase: sorted.at(0)?.evaluationKey ?? null,
    worstCase: sorted.at(-1)?.evaluationKey ?? null,
    modelChange: {
      previousBias: artifact.bias,
      newBias: artifact.bias,
      previousScale: artifact.scale,
      newScale: artifact.scale,
      applied: false
    }
  });
}

async function loadPeriodReports(): Promise<PeriodReport[]> {
  const reports: PeriodReport[] = [];
  for (const period of ["weekly", "monthly", "yearly"] as const) {
    const directory = path.join(root, "data", "reports", period);
    let files: string[] = [];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of files.filter((value) => value.endsWith(".json")).sort()) {
      reports.push(
        periodReportSchema.parse(await readJson<unknown>(path.join(directory, file)))
      );
    }
  }
  return reports.sort((left, right) =>
    `${left.endDate}:${left.period}`.localeCompare(`${right.endDate}:${right.period}`)
  );
}

async function outstandingPeriodGates(date: string): Promise<PeriodGate[]> {
  const reports = await loadPeriodReports();
  return reports
    .filter((report) => report.status === "provisional" && report.endDate < date)
    .map(({ period, periodKey, startDate, endDate }) => ({
      period,
      periodKey,
      startDate,
      endDate,
      status: "final"
    }));
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

async function recordRun(record: RunRecord): Promise<void> {
  const file = path.join(root, "data", "runs.json");
  const runs = await readJson<RunRecord[]>(file, []);
  await writeJsonIfChanged(
    file,
    [...runs.filter(({ runKey }) => runKey !== record.runKey), record].sort((left, right) =>
      left.runKey.localeCompare(right.runKey)
    )
  );
}

async function persistSkippedRun(
  date: string,
  phase: RunPhase,
  scheduledAt: string,
  actualRunAt: string,
  decision: TradingDayDecision,
  reason: string
): Promise<void> {
  const runKey = `${date}:${phase}:cn-loop-v2`;
  await recordRun({
    runKey,
    date,
    phase,
    scheduledAt,
    actualRunAt,
    completedAt: actualRunAt,
    calendarStatus: decision.status,
    outcome: "skipped",
    reason
  });
  const file = path.join(root, "public", "data", "index.json");
  const previous = await readJson<Record<string, unknown> | null>(file, null);
  if (!previous || !Array.isArray(previous.summaries)) return;
  const summaries = previous.summaries.map((raw) => {
    const summary = raw as Record<string, unknown>;
    return {
      ...summary,
      predictionAvailability: predictionAvailability(
        date,
        (summary.prediction as FundPrediction | null) ?? null
      )
    };
  });
  const previousStatus = previous.dataStatus;
  const index = siteIndexSchema.parse({
    ...previous,
    generatedAt: actualRunAt,
    phase,
    dataStatus:
      decision.status === "calendar-unavailable" || decision.status === "source-error"
        ? "error"
        : previousStatus,
    calendar: decision,
    runTiming: {
      scheduledAt,
      actualRunAt,
      delayedAcrossShanghaiDate: shanghaiDate(new Date(actualRunAt)) !== date
    },
    summaries
  });
  await writeJsonIfChanged(file, index);
}

export async function runPipeline(
  date: string,
  phase: RunPhase,
  options: PipelineOptions = {}
): Promise<{ skipped: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  const actualRunAt = options.actualRunAt ?? new Date().toISOString();
  const scheduledAt = options.scheduledAt ?? scheduledTimestamp(date, phase);
  const decision = tradingDayDecision(date, {
    calendarOverride: options.calendarOverride
  });
  const runKey = `${date}:${phase}:cn-loop-v2`;
  const delayedAcrossShanghaiDate = shanghaiDate(new Date(actualRunAt)) !== date;
  const skipReason =
    decision.status === "calendar-unavailable" || decision.status === "source-error"
      ? decision.reason
      : decision.status === "closed" && (weekday(date) === 0 || weekday(date) === 6)
        ? decision.reason
        : phase === "morning" && decision.status === "closed"
          ? decision.reason
          : phase === "morning" && delayedAcrossShanghaiDate
            ? "延迟的上午任务已跨上海业务日期；为防止前视偏差，不回填预测"
            : null;
  if (skipReason) {
    await persistSkippedRun(date, phase, scheduledAt, actualRunAt, decision, skipReason);
    console.log(`Skipping ${date} ${phase}: ${skipReason}.`);
    return { skipped: true };
  }

  const collectedAt = actualRunAt;
  const funds = parseFunds(await readJson<unknown>(path.join(root, "data", "funds.json")));
  const artifact = await loadArtifact(collectedAt);
  const shouldCollect = ["morning", "evening", "all"].includes(phase);
  const previousPublicIndex = shouldCollect
    ? null
    : await readJson<{
        summaries: Array<{
          fund: Fund;
          holdings: HoldingsSnapshot;
          holdingQuotes: HoldingQuoteBatch;
        }>;
      }>(path.join(root, "public", "data", "index.json"));
  const staged: Array<{
    fund: Fund;
    quotes: Quote[];
    holdings: HoldingsSnapshot;
    historicalHoldings: HoldingsSnapshot[];
    holdingQuotes: HoldingQuoteBatch;
  }> = [];

  for (const fund of funds) {
    const existingQuotes = await loadAllQuotes(fund.id);
    let quotes = existingQuotes;
    let holdings: HoldingsSnapshot;
    let historicalHoldings: HoldingsSnapshot[] = [];
    let holdingQuotes: HoldingQuoteBatch;
    if (shouldCollect) {
      const provider = options.provider ?? providerForFund(fund);
      const context: CollectionContext = {
        date,
        mode: phase === "morning" ? "intraday" : "final",
        collectedAt,
        runKey
      };
      const collected = await provider.collectFund(fund, context);
      quotes = mergeQuotes(existingQuotes, collected.quotes.map((value) => quoteSchema.parse(value)));
      holdings = holdingsSnapshotSchema.parse(collected.holdings);
      historicalHoldings = collected.historicalHoldings.map((snapshot) =>
        holdingsSnapshotSchema.parse(snapshot)
      );
      holdingQuotes = holdingQuoteBatchSchema.parse(collected.holdingQuotes);
      if (!holdings.holdings.length) throw new Error(`${provider.name} returned empty holdings for ${fund.id}`);
    } else {
      const publicSummary = previousPublicIndex?.summaries.find(
        (summary) => summary.fund.id === fund.id
      );
      if (!publicSummary) throw new Error(`No persisted public summary available for ${fund.id}`);
      holdings = holdingsSnapshotSchema.parse(publicSummary.holdings);
      holdingQuotes = holdingQuoteBatchSchema.parse(publicSummary.holdingQuotes);
    }
    staged.push({ fund, quotes, holdings, historicalHoldings, holdingQuotes });
  }

  let predictions = await allPredictions();
  if ((phase === "morning" || phase === "all") && isMainlandTradingDay(date)) {
    const created = staged.map(({ fund, quotes, holdings, holdingQuotes }) =>
      model.predict({
        fund,
        predictionDate: date,
        targetTradeDate: date,
        featureTimestamp: scheduledAt,
        quotes,
        holdings,
        holdingQuotes,
        artifact
      })
    );
    const keys = new Set(created.map(({ predictionKey }) => predictionKey));
    predictions = [...predictions.filter(({ predictionKey }) => !keys.has(predictionKey)), ...created].sort(
      (left, right) => left.predictionKey.localeCompare(right.predictionKey)
    );
    await saveYearPartition("predictions", date, "predictions.json", predictions.filter(({ predictionDate }) => predictionDate.startsWith(date.slice(0, 4))));
  }

  if (shouldCollect) {
    for (const { fund, quotes, holdings, historicalHoldings, holdingQuotes } of staged) {
      await saveQuotes(fund, quotes);
      for (const historical of historicalHoldings) await saveHoldings(historical, true);
      await saveHoldings(holdings);
      await writeJsonIfChanged(
        path.join(root, "data", "holding-quotes", fund.id, `${date}.json`),
        holdingQuotes
      );
    }
  }

  let evaluations = await allEvaluations();
  if (phase === "evening" || phase === "all") {
    const existingByKey = new Map(evaluations.map((evaluation) => [evaluation.evaluationKey, evaluation]));
    const updated = predictions.map((prediction) => {
      const fundQuotes = staged.find(({ fund }) => fund.id === prediction.fundId)?.quotes ?? [];
      return evaluatePrediction(prediction, fundQuotes, collectedAt, existingByKey.get(prediction.predictionKey));
    });
    const keys = new Set(updated.map(({ evaluationKey }) => evaluationKey));
    evaluations = [...evaluations.filter(({ evaluationKey }) => !keys.has(evaluationKey)), ...updated].sort(
      (left, right) => left.evaluationKey.localeCompare(right.evaluationKey)
    );
    const years = new Set(evaluations.map(({ targetTradeDate }) => targetTradeDate.slice(0, 4)));
    for (const year of years) {
      await saveYearPartition("evaluations", `${year}-01-01`, "evaluations.json", evaluations.filter(({ targetTradeDate }) => targetTradeDate.startsWith(year)));
    }
    const calibrated = model.calibrate(artifact, evaluations, collectedAt);
    const applied = new Set(calibrated.appliedEvaluationKeys);
    evaluations = evaluations.map((evaluation) =>
      applied.has(evaluation.evaluationKey) && evaluation.status === "evaluated"
        ? { ...evaluation, trainingApplied: true }
        : evaluation
    );
    for (const year of years) {
      await saveYearPartition("evaluations", `${year}-01-01`, "evaluations.json", evaluations.filter(({ targetTradeDate }) => targetTradeDate.startsWith(year)));
    }
    await writeJsonIfChanged(path.join(root, "data", "models", "cn-baseline-v1.json"), calibrated);
  }

  const requestedGates = orderPeriodGates(
    phase === "weekly"
      ? periodCloseGates(date).filter(({ period }) => period === "weekly")
      : phase === "monthly"
        ? periodCloseGates(date).filter(({ period }) => period === "monthly")
        : phase === "yearly"
          ? periodCloseGates(date).filter(({ period }) => period === "yearly")
          : phase === "evening" || phase === "all"
            ? [
                ...periodCloseGates(date),
                ...catchUpPeriodGates(date),
                ...(await outstandingPeriodGates(date))
              ].filter(
                ({ period }, index, values) =>
                  values.findIndex((value) => value.period === period && value.periodKey === values[index]?.periodKey) === index
              )
            : []
  );
  await createReports(requestedGates, evaluations, predictions, artifact, collectedAt);
  const reports = await loadPeriodReports();

  for (const { fund, quotes } of staged) {
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
  const summaries = staged.map(({ fund, quotes, holdings, holdingQuotes }) => {
    const fundPredictions = predictions.filter(({ fundId }) => fundId === fund.id);
    const prediction = fundPredictions.at(-1) ?? null;
    const evaluation = prediction
      ? evaluations.find(({ predictionKey }) => predictionKey === prediction.predictionKey) ?? null
      : null;
    const fundEvaluations = evaluations.filter(({ fundId }) => fundId === fund.id);
    return {
      fund,
      latestQuote: quotes.at(-1) ?? null,
      analytics: calculateAnalytics(fund.id, quotes),
      holdings,
      holdingQuotes,
      prediction,
      predictionAvailability: predictionAvailability(date, prediction),
      evaluation,
      rollingMetrics: metricSet(fundEvaluations.slice(-60))
    };
  });
  const index = siteIndexSchema.parse({
    generatedAt: collectedAt,
    asOf: summaries.map(({ latestQuote }) => latestQuote?.date ?? "").sort().at(-1) ?? date,
    phase,
    dataStatus: summaries.every(({ latestQuote }) => latestQuote?.quality.status === "complete") ? "complete" : "partial",
    dataMode: "real",
    calendar: decision,
    runTiming: {
      scheduledAt,
      actualRunAt,
      delayedAcrossShanghaiDate
    },
    summaries,
    reports
  });
  await writeJsonIfChanged(path.join(root, "public", "data", "index.json"), index);
  await recordRun({
    runKey,
    date,
    phase,
    scheduledAt,
    actualRunAt,
    completedAt: actualRunAt,
    calendarStatus: decision.status,
    outcome: "completed",
    reason: decision.reason
  });
  console.log(`Completed ${runKey} for ${funds.length} China funds.`);
  return { skipped: false };
}
