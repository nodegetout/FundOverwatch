import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../scripts/pipeline";
import type { Fund, SiteIndex } from "../src/lib/domain";
import type { CollectionContext, FundDataProvider } from "../src/lib/provider";
import type { FundPrediction, PredictionEvaluation } from "../src/lib/prediction-contract";
import { resolveSchedule } from "../src/lib/run-timing";

const filesystem = vi.hoisted(() => {
  const files = new Map<string, string>();
  const missing = (file: string) =>
    Object.assign(new Error(`Missing fixture: ${file}`), { code: "ENOENT" });
  return {
    files,
    readFile: vi.fn(async (file: string) => {
      const content = files.get(file);
      if (content === undefined) throw missing(file);
      return content;
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (file: string, content: string) => {
      files.set(file, content);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) throw missing(from);
      files.set(to, content);
      files.delete(from);
    }),
    unlink: vi.fn(async (file: string) => {
      if (!files.delete(file)) throw missing(file);
    })
  };
});

vi.mock("node:fs/promises", () => filesystem);

const root = fileURLToPath(new URL("..", import.meta.url));
const businessDate = "2026-10-13";
const fund: Fund = {
  id: "cn-timing",
  symbol: "025852",
  name: "Timing test fund",
  market: "CN",
  exchange: "中国公募基金",
  currency: "CNY",
  assetClass: "Mixed",
  benchmark: "benchmark",
  timezone: "Asia/Shanghai",
  inceptionDate: "2025-12-12",
  providerRef: "eastmoney:025852"
};

function seed(file: string, value: unknown): void {
  filesystem.files.set(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function read<T>(file: string): T {
  const content = filesystem.files.get(path.join(root, file));
  expect(content, `Expected persisted ${file}`).toBeDefined();
  return JSON.parse(content!) as T;
}

function collectResult(item: Fund, context: CollectionContext) {
  const quality = {
    status: "complete" as const,
    source: "integration-fixture",
    dataMode: "real" as const,
    isSimulated: false as const,
    collectedAt: context.collectedAt,
    warnings: [],
    missingFields: []
  };
  return {
    quotes: [
      { date: "2026-10-12", nav: 1 },
      { date: businessDate, nav: 1.02 }
    ].map((value) => ({
      ...value,
      fundId: item.id,
      price: null,
      benchmarkPrice: null,
      currency: "CNY",
      valuation: "final" as const,
      quality
    })),
    holdings: {
      fundId: item.id,
      date: "2026-06-30",
      previousDate: null,
      contentHash: "timing-test-disclosure",
      holdings: [{
        name: "Disclosed asset",
        symbol: "600001",
        assetType: "stock" as const,
        source: "integration-fixture",
        quoteRef: "1.600001",
        weight: 0.1,
        previousWeight: null,
        weightChange: null,
        changeStatus: "unavailable" as const,
        sector: null,
        country: null
      }],
      sectors: [],
      countries: [],
      quality
    },
    historicalHoldings: [],
    holdingQuotes: {
      fundId: item.id,
      collectedAt: context.collectedAt,
      quotes: []
    }
  };
}

function provider() {
  return {
    name: "integration-fixture",
    collectFund: vi.fn<FundDataProvider["collectFund"]>(async (item, context) =>
      collectResult(item, context)
    )
  };
}

const delayedTimes = {
  started: "2026-10-13T20:18:10.000Z",
  collected: "2026-10-13T20:19:00.000Z",
  collectionFinished: "2026-10-13T20:20:00.000Z",
  generated: "2026-10-13T20:21:00.000Z",
  completed: "2026-10-13T20:22:00.000Z"
};

function delayedClock() {
  return vi.fn<() => Date>()
    .mockReturnValueOnce(new Date(delayedTimes.started))
    .mockReturnValueOnce(new Date(delayedTimes.collected))
    .mockReturnValueOnce(new Date(delayedTimes.collectionFinished))
    .mockReturnValueOnce(new Date(delayedTimes.generated))
    .mockReturnValue(new Date(delayedTimes.completed));
}

function expectNoMutations(previous: Map<string, string>): void {
  expect(filesystem.files).toEqual(previous);
  expect(filesystem.mkdir).not.toHaveBeenCalled();
  expect(filesystem.writeFile).not.toHaveBeenCalled();
  expect(filesystem.rename).not.toHaveBeenCalled();
  expect(filesystem.unlink).not.toHaveBeenCalled();
}

describe("pipeline business-date and publication integration", () => {
  beforeEach(() => {
    filesystem.files.clear();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    seed("data/funds.json", [fund]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a delayed evening's business date while persisting actual lifecycle times", async () => {
    const schedule = resolveSchedule("30 14 * * 1-5", delayedTimes.started);
    const prediction: FundPrediction = {
      predictionKey: `${fund.id}:${businessDate}:cn-baseline-v1`,
      fundId: fund.id,
      predictionDate: businessDate,
      targetTradeDate: businessDate,
      predictedReturn: 0.01,
      direction: "up",
      confidence: 0.4,
      featureTimestamp: `${businessDate}T10:30:00+08:00`,
      holdingsReportDate: null,
      featureCoverage: 0,
      modelVersion: "cn-baseline-v1",
      modelStatus: "cold-start",
      sampleCount: 0,
      dataQuality: "unavailable",
      contributions: [],
      warnings: []
    };
    seed("data/predictions/years.json", ["2026"]);
    seed("data/predictions/2026/predictions.json", [prediction]);
    const source = provider();
    await expect(runPipeline(schedule.date, schedule.phase, {
      provider: source, now: delayedClock()
    })).resolves.toEqual({ skipped: false });

    expect(schedule.date).toBe(businessDate);
    expect(source.collectFund).toHaveBeenCalledExactlyOnceWith(fund, {
      date: businessDate,
      mode: "final",
      collectedAt: delayedTimes.collected,
      runKey: `${businessDate}:evening:cn-loop-v2`
    });
    const index = read<SiteIndex>("public/data/index.json");
    expect(index).toMatchObject({
      businessDate,
      phase: "evening",
      scheduledAt: `${businessDate}T22:30:00+08:00`,
      startedAt: delayedTimes.started,
      generatedAt: delayedTimes.generated,
      asOf: businessDate
    });
    expect(index.summaries[0]?.latestQuote?.quality.collectedAt).toBe(delayedTimes.collected);
    expect(index.summaries[0]?.holdingQuotes?.collectedAt).toBe(delayedTimes.collected);
    expect(read<PredictionEvaluation[]>("data/evaluations/2026/evaluations.json")[0])
      .toMatchObject({
        targetTradeDate: businessDate,
        status: "evaluated",
        evaluatedAt: delayedTimes.collectionFinished
      });
    expect(read("data/runs.json")).toEqual([{
      runKey: `${businessDate}:evening:cn-loop-v2`,
      date: businessDate,
      phase: "evening",
      scheduledAt: `${businessDate}T22:30:00+08:00`,
      startedAt: delayedTimes.started,
      completedAt: delayedTimes.completed
    }]);
    expect(filesystem.files.has(
      path.join(root, `data/holding-quotes/${fund.id}/${businessDate}.json`)
    )).toBe(true);
    expect([...filesystem.files.keys()].some((file) => file.includes("2026-10-14"))).toBe(false);
  });

  it("does not let an incorrectly timestamped legacy v1 completion block a v2 recovery", async () => {
    const legacy = {
      runKey: `${businessDate}:evening:cn-loop-v1`,
      date: businessDate,
      phase: "evening",
      completedAt: `${businessDate}T22:30:00+08:00`
    };
    seed("data/runs.json", [legacy]);
    const source = provider();
    await expect(runPipeline(businessDate, "evening", {
      provider: source, now: delayedClock()
    })).resolves.toEqual({ skipped: false });
    expect(source.collectFund).toHaveBeenCalledTimes(1);
    expect(read("data/runs.json")).toEqual([
      legacy,
      expect.objectContaining({ runKey: `${businessDate}:evening:cn-loop-v2` })
    ]);
    expect(read<SiteIndex>("public/data/index.json").generatedAt).toBe(delayedTimes.generated);
  });

  it("makes a repeated v2 evening run idempotent without collecting or rewriting anything", async () => {
    const source = provider();
    await runPipeline(businessDate, "evening", { provider: source, now: delayedClock() });
    const published = new Map(filesystem.files);
    vi.clearAllMocks();
    await expect(runPipeline(businessDate, "evening", {
      provider: source, now: () => new Date("2026-10-14T04:00:00Z")
    })).resolves.toEqual({ skipped: true });
    expect(source.collectFund).not.toHaveBeenCalled();
    expectNoMutations(published);
  });

  it("skips a completed v2 morning rerun after 11:30 without collecting or rewriting", async () => {
    const source = provider();
    await expect(runPipeline(businessDate, "morning", {
      provider: source,
      now: () => new Date(`${businessDate}T02:30:00Z`)
    })).resolves.toEqual({ skipped: false });
    expect(read("data/runs.json")).toEqual([
      expect.objectContaining({ runKey: `${businessDate}:morning:cn-loop-v2` })
    ]);
    const published = new Map(filesystem.files);
    vi.clearAllMocks();
    await expect(runPipeline(businessDate, "morning", {
      provider: source,
      now: () => new Date(`${businessDate}T03:30:01Z`)
    })).resolves.toEqual({ skipped: true });
    expect(source.collectFund).not.toHaveBeenCalled();
    expectNoMutations(published);
  });

  it.each(["morning", "all"] as const)(
    "rejects %s collection finishing past 11:30 before any filesystem mutation",
    async (phase) => {
      let actualTime = new Date(`${businessDate}T03:29:59Z`);
      const source = provider();
      source.collectFund.mockImplementation(async (item, context) => {
        actualTime = new Date(`${businessDate}T03:30:01Z`);
        return collectResult(item, context);
      });
      seed("public/data/index.json", { generatedAt: "previous-publication" });
      seed("data/runs.json", []);
      const previous = new Map(filesystem.files);
      await expect(runPipeline(businessDate, phase, {
        provider: source, now: () => actualTime
      })).rejects.toThrow("no retrospective prediction created");
      expect(source.collectFund).toHaveBeenCalledTimes(1);
      expectNoMutations(previous);
    }
  );

  it("preserves all previous data when a later fund's source fails after staging a first fund", async () => {
    const secondFund = { ...fund, id: "cn-timing-second", symbol: "002983" };
    seed("data/funds.json", [fund, secondFund]);
    const previousContext: CollectionContext = {
      date: "2026-10-12",
      collectedAt: "2026-10-12T14:30:00Z",
      mode: "final",
      runKey: "2026-10-12:evening:cn-loop-v2"
    };
    const oldData = collectResult(fund, previousContext);
    seed("data/history/cn-timing/years.json", ["2026"]);
    seed("data/history/cn-timing/2026.json", [oldData.quotes[0]]);
    seed("data/holdings/cn-timing/2026-06-30.json", oldData.holdings);
    seed("data/holding-quotes/cn-timing/2026-10-12.json", oldData.holdingQuotes);
    seed("public/data/index.json", { generatedAt: previousContext.collectedAt });
    seed("public/data/series/cn-timing.json", [{ date: "2026-10-12", nav: 1 }]);
    seed("data/runs.json", [{ runKey: previousContext.runKey }]);
    const previous = new Map(filesystem.files);
    const failure = new Error("Eastmoney source exhausted its retries");
    const source = provider();
    source.collectFund.mockImplementation(async (item, context) => {
      if (item.id === secondFund.id) throw failure;
      return collectResult(item, context);
    });
    await expect(runPipeline(businessDate, "evening", {
      provider: source, now: () => new Date(delayedTimes.started)
    })).rejects.toBe(failure);
    expect(source.collectFund).toHaveBeenCalledTimes(2);
    expectNoMutations(previous);
  });
});
