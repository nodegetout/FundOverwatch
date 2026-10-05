import { z } from "zod";
import type { Fund, HoldingQuoteBatch, HoldingsSnapshot, Quote } from "./domain";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const timestamp = z.string().datetime({ offset: true });

export const modelArtifactSchema = z.object({
  modelVersion: z.literal("cn-baseline-v1"),
  updatedAt: timestamp,
  trainingCutoff: z.string().regex(isoDate).nullable(),
  sampleCount: z.number().int().nonnegative(),
  bias: z.number().min(-0.03).max(0.03),
  scale: z.number().min(0.5).max(1.5),
  directionAccuracy: z.number().min(0).max(1).nullable(),
  mae: z.number().nonnegative().nullable(),
  rmse: z.number().nonnegative().nullable(),
  appliedEvaluationKeys: z.array(z.string())
});

export const contributionSchema = z.object({
  feature: z.string().min(1),
  value: z.number(),
  contribution: z.number(),
  note: z.string().min(1)
});

export const predictionSchema = z.object({
  predictionKey: z.string().min(1),
  fundId: z.string().min(1),
  predictionDate: z.string().regex(isoDate),
  targetTradeDate: z.string().regex(isoDate),
  predictedReturn: z.number().min(-0.1).max(0.1),
  direction: z.enum(["up", "down", "flat"]),
  confidence: z.number().min(0).max(1),
  featureTimestamp: timestamp,
  holdingsReportDate: z.string().regex(isoDate).nullable(),
  featureCoverage: z.number().min(0).max(1),
  modelVersion: z.literal("cn-baseline-v1"),
  modelStatus: z.enum(["cold-start", "calibrated"]),
  sampleCount: z.number().int().nonnegative(),
  dataQuality: z.enum(["available", "partial", "stale", "unavailable"]),
  contributions: z.array(contributionSchema),
  warnings: z.array(z.string())
});

export const evaluationSchema = z.object({
  evaluationKey: z.string().min(1),
  predictionKey: z.string().min(1),
  fundId: z.string().min(1),
  targetTradeDate: z.string().regex(isoDate),
  status: z.enum(["pending", "evaluated", "unavailable"]),
  evaluatedAt: timestamp,
  actualStartDate: z.string().regex(isoDate).nullable(),
  actualEndDate: z.string().regex(isoDate).nullable(),
  actualReturn: z.number().nullable(),
  error: z.number().nullable(),
  absoluteError: z.number().nonnegative().nullable(),
  squaredError: z.number().nonnegative().nullable(),
  directionCorrect: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
  confidenceBin: z.enum(["low", "medium", "high"]),
  trainingApplied: z.boolean(),
  reason: z.string().nullable()
});

export const metricSetSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  directionAccuracy: z.number().min(0).max(1).nullable(),
  mae: z.number().nonnegative().nullable(),
  rmse: z.number().nonnegative().nullable(),
  meanError: z.number().nullable()
});

export const periodReportSchema = z.object({
  reportKey: z.string().min(1),
  period: z.enum(["weekly", "monthly", "yearly"]),
  periodKey: z.string().min(1),
  startDate: z.string().regex(isoDate),
  endDate: z.string().regex(isoDate),
  status: z.enum(["provisional", "final"]),
  generatedAt: timestamp,
  modelVersion: z.literal("cn-baseline-v1"),
  metrics: metricSetSchema,
  missingRate: z.number().min(0).max(1),
  byFund: z.record(z.string(), metricSetSchema),
  byConfidence: z.record(z.string(), metricSetSchema),
  byCoverage: z.record(z.string(), metricSetSchema),
  bestCase: z.string().nullable(),
  worstCase: z.string().nullable(),
  modelChange: z.object({
    previousBias: z.number(),
    newBias: z.number(),
    previousScale: z.number(),
    newScale: z.number(),
    applied: z.boolean()
  })
});

export const predictionInputSchema = z.object({
  fund: z.custom<Fund>(),
  predictionDate: z.string().regex(isoDate),
  targetTradeDate: z.string().regex(isoDate),
  featureTimestamp: timestamp,
  quotes: z.array(z.custom<Quote>()),
  holdings: z.custom<HoldingsSnapshot>().nullable(),
  holdingQuotes: z.custom<HoldingQuoteBatch>().nullable(),
  artifact: modelArtifactSchema
});

export type ModelArtifact = z.infer<typeof modelArtifactSchema>;
export type FundPrediction = z.infer<typeof predictionSchema>;
export type PredictionEvaluation = z.infer<typeof evaluationSchema>;
export type MetricSet = z.infer<typeof metricSetSchema>;
export type PeriodReport = z.infer<typeof periodReportSchema>;
export type PredictionInput = z.infer<typeof predictionInputSchema>;

export interface PredictionModel {
  readonly version: FundPrediction["modelVersion"];
  predict(input: PredictionInput): FundPrediction;
  calibrate(artifact: ModelArtifact, evaluations: PredictionEvaluation[], updatedAt: string): ModelArtifact;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function nextDirection(value: number): FundPrediction["direction"] {
  if (value > 0.0005) return "up";
  if (value < -0.0005) return "down";
  return "flat";
}

function returns(quotes: Quote[]): number[] {
  const values = quotes
    .filter(({ nav }) => nav !== null)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-21);
  const result: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]?.nav;
    const current = values[index]?.nav;
    if (previous && current) result.push(current / previous - 1);
  }
  return result;
}

export class BaselinePredictionModel implements PredictionModel {
  readonly version = "cn-baseline-v1" as const;

  predict(raw: PredictionInput): FundPrediction {
    const input = predictionInputSchema.parse(raw);
    const cutoff = Date.parse(input.featureTimestamp);
    const quoteByKey = new Map(
      input.holdingQuotes?.quotes
        .filter(({ asOf }) => asOf !== null && Date.parse(asOf) <= cutoff)
        .map((quote) => [quote.assetKey, quote]) ?? []
    );
    let disclosedWeight = 0;
    let quotedWeight = 0;
    let holdingSignal = 0;
    for (const holding of input.holdings?.holdings ?? []) {
      if (holding.weight === null || holding.weight <= 0) continue;
      disclosedWeight += holding.weight;
      const quote = quoteByKey.get(`${holding.assetType}:${holding.symbol}`);
      if (!quote || quote.dayChange === null || quote.status === "unavailable") continue;
      quotedWeight += holding.weight;
      holdingSignal += holding.weight * quote.dayChange;
    }
    const coverage = clamp(quotedWeight, 0, 1);
    const normalizedHoldingSignal = quotedWeight > 0 ? holdingSignal / quotedWeight : 0;
    const navReturns = returns(input.quotes.filter(({ date }) => date < input.predictionDate));
    const momentum =
      navReturns.length >= 3 ? navReturns.slice(-5).reduce((sum, value) => sum + value, 0) / Math.min(5, navReturns.length) : 0;
    const volatility =
      navReturns.length >= 5
        ? Math.sqrt(
            navReturns.reduce((sum, value) => sum + (value - momentum) ** 2, 0) /
              Math.max(1, navReturns.length - 1)
          )
        : 0.02;
    const rawReturn =
      normalizedHoldingSignal * 0.65 * coverage +
      momentum * 0.2 +
      input.artifact.bias;
    const predictedReturn = clamp(rawReturn * input.artifact.scale, -0.1, 0.1);
    const recencyFactor =
      input.holdingQuotes?.quotes.some(
        ({ asOf, status }) => status === "available" && asOf && Date.parse(asOf) <= cutoff
      )
        ? 1
        : 0.65;
    const sampleFactor = Math.min(1, input.artifact.sampleCount / 30);
    const confidence = clamp(
      (0.12 + coverage * 0.55 + sampleFactor * 0.2) * recencyFactor * (1 - Math.min(0.5, volatility * 8)),
      0.05,
      0.85
    );
    const warnings = [
      ...(disclosedWeight < 0.8
        ? [`披露持仓仅覆盖基金净值的 ${(disclosedWeight * 100).toFixed(1)}%，不代表完整组合。`]
        : []),
      ...(coverage < 0.3 ? ["可报价持仓覆盖率低，预测已显著降权。"] : []),
      ...(input.fund.name.includes("QDII") ? ["QDII 净值与境外市场/汇率存在时差，上午行情覆盖有限。"] : []),
      ...(input.fund.assetClass === "Bond" ? ["债券与场外资产缺少可靠上午行情，预测可信度较低。"] : []),
      ...(input.artifact.sampleCount < 20 ? [`冷启动：仅有 ${input.artifact.sampleCount} 个已评估样本。`] : [])
    ];
    return predictionSchema.parse({
      predictionKey: `${input.fund.id}:${input.predictionDate}:${this.version}`,
      fundId: input.fund.id,
      predictionDate: input.predictionDate,
      targetTradeDate: input.targetTradeDate,
      predictedReturn,
      direction: nextDirection(predictedReturn),
      confidence,
      featureTimestamp: input.featureTimestamp,
      holdingsReportDate: input.holdings?.date ?? null,
      featureCoverage: coverage,
      modelVersion: this.version,
      modelStatus: input.artifact.sampleCount < 20 ? "cold-start" : "calibrated",
      sampleCount: input.artifact.sampleCount,
      dataQuality:
        coverage === 0 ? "unavailable" : coverage < 0.5 ? "partial" : recencyFactor < 1 ? "stale" : "available",
      contributions: [
        {
          feature: "disclosed-holdings",
          value: normalizedHoldingSignal,
          contribution: normalizedHoldingSignal * 0.65 * coverage,
          note: "已披露持仓权重内归一，并按可报价覆盖率折扣"
        },
        {
          feature: "nav-momentum",
          value: momentum,
          contribution: momentum * 0.2,
          note: "仅使用预测日前已经披露的最近净值"
        },
        {
          feature: "online-bias",
          value: input.artifact.bias,
          contribution: input.artifact.bias,
          note: "仅由历史已评估预测更新，参数有界"
        }
      ],
      warnings
    });
  }

  calibrate(
    artifact: ModelArtifact,
    evaluations: PredictionEvaluation[],
    updatedAt: string
  ): ModelArtifact {
    const fresh = evaluations.filter(
      (evaluation) =>
        evaluation.status === "evaluated" &&
        evaluation.error !== null &&
        !artifact.appliedEvaluationKeys.includes(evaluation.evaluationKey)
    );
    if (fresh.length === 0) return artifact;
    const allKeys = [...artifact.appliedEvaluationKeys, ...fresh.map(({ evaluationKey }) => evaluationKey)];
    const errors = fresh.map(({ error }) => error ?? 0);
    const newCount = artifact.sampleCount + fresh.length;
    const meanError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    const bias =
      newCount < 10
        ? artifact.bias
        : clamp(artifact.bias + meanError * 0.1, -0.03, 0.03);
    const evaluated = fresh.filter(({ directionCorrect }) => directionCorrect !== null);
    const accuracy = evaluated.length
      ? evaluated.filter(({ directionCorrect }) => directionCorrect).length / evaluated.length
      : null;
    const mae = errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length;
    const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length);
    const scale =
      newCount < 20
        ? artifact.scale
        : clamp(artifact.scale * (mae > 0.03 ? 0.95 : 1.01), 0.5, 1.5);
    return modelArtifactSchema.parse({
      ...artifact,
      updatedAt,
      trainingCutoff: fresh.map(({ targetTradeDate }) => targetTradeDate).sort().at(-1) ?? artifact.trainingCutoff,
      sampleCount: newCount,
      bias,
      scale,
      directionAccuracy: accuracy,
      mae,
      rmse,
      appliedEvaluationKeys: allKeys
    });
  }
}

export function initialModelArtifact(updatedAt: string): ModelArtifact {
  return modelArtifactSchema.parse({
    modelVersion: "cn-baseline-v1",
    updatedAt,
    trainingCutoff: null,
    sampleCount: 0,
    bias: 0,
    scale: 1,
    directionAccuracy: null,
    mae: null,
    rmse: null,
    appliedEvaluationKeys: []
  });
}

export function metricSet(evaluations: PredictionEvaluation[]): MetricSet {
  const valid = evaluations.filter(
    (evaluation) => evaluation.status === "evaluated" && evaluation.error !== null
  );
  if (!valid.length) {
    return { sampleCount: 0, directionAccuracy: null, mae: null, rmse: null, meanError: null };
  }
  const errors = valid.map(({ error }) => error ?? 0);
  return metricSetSchema.parse({
    sampleCount: valid.length,
    directionAccuracy:
      valid.filter(({ directionCorrect }) => directionCorrect).length / valid.length,
    mae: errors.reduce((sum, value) => sum + Math.abs(value), 0) / valid.length,
    rmse: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / valid.length),
    meanError: errors.reduce((sum, value) => sum + value, 0) / valid.length
  });
}
