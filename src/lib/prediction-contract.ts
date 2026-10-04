import { z } from "zod";

export const predictionInputSchema = z.object({
  fundId: z.string().min(1),
  asOf: z.string().date(),
  modelVersion: z.string().min(1),
  features: z.object({
    trailingReturns: z.array(z.number()),
    volatility: z.number().nonnegative(),
    maxDrawdown: z.number().nonpositive(),
    benchmarkExcessReturn: z.number(),
    sectorWeights: z.record(z.number()),
    countryWeights: z.record(z.number())
  })
});

export type PredictionInput = z.infer<typeof predictionInputSchema>;

export interface PredictionModel {
  readonly version: string;
  predict(input: PredictionInput): Promise<{ expectedReturn: number; confidence: number }>;
}

// No model is implemented in the initial release. This contract isolates future training and inference.
