import { z } from "zod";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const timestamp = z.string().datetime({ offset: true });

export const fundSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  symbol: z.string().min(1),
  name: z.string().min(1),
  market: z.enum(["US", "HK", "CN", "JP", "EU", "OTHER"]),
  exchange: z.string().min(1),
  currency: z.string().length(3),
  assetClass: z.enum(["Equity", "Bond", "Mixed", "Commodity", "Money Market", "Other"]),
  benchmark: z.string().min(1),
  timezone: z.string().min(1),
  inceptionDate: z.string().regex(isoDate),
  providerRef: z.string().min(1)
});

export const qualitySchema = z.object({
  status: z.enum(["complete", "partial", "stale", "error"]),
  source: z.string().min(1),
  dataMode: z.enum(["real", "simulated"]).default("simulated"),
  isSimulated: z.boolean(),
  collectedAt: timestamp,
  warnings: z.array(z.string()),
  missingFields: z.array(z.string())
});

export const quoteSchema = z.object({
  fundId: z.string().min(1),
  date: z.string().regex(isoDate),
  nav: z.number().positive().nullable(),
  price: z.number().positive().nullable(),
  benchmarkPrice: z.number().positive().nullable(),
  currency: z.string().length(3),
  valuation: z.enum(["intraday", "final"]).default("final"),
  quality: qualitySchema
});

const allocationSchema = z.object({
  name: z.string().min(1),
  weight: z.number().min(0).max(1)
});

export const holdingSchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),
  weight: z.number().min(0).max(1),
  sector: z.string().min(1),
  country: z.string().min(1)
});

export const holdingsSnapshotSchema = z.object({
  fundId: z.string().min(1),
  date: z.string().regex(isoDate),
  holdings: z.array(holdingSchema),
  sectors: z.array(allocationSchema),
  countries: z.array(allocationSchema),
  quality: qualitySchema
});

export const periodReturnSchema = z.object({
  day: z.number().nullable(),
  week: z.number().nullable(),
  month: z.number().nullable(),
  year: z.number().nullable()
});

export const analyticsSchema = z.object({
  fundId: z.string(),
  asOf: z.string().regex(isoDate),
  nav: z.number().nullable(),
  price: z.number().nullable(),
  returns: periodReturnSchema,
  annualizedVolatility: z.number().nullable(),
  maxDrawdown: z.number().nullable(),
  movingAverages: z.object({
    day20: z.number().nullable(),
    day60: z.number().nullable()
  }),
  benchmarkReturn: z.number().nullable(),
  excessReturn: z.number().nullable(),
  observations: z.number().int().nonnegative()
});

export const fundSummarySchema = z.object({
  fund: fundSchema,
  latestQuote: quoteSchema.nullable(),
  analytics: analyticsSchema.nullable(),
  holdings: holdingsSnapshotSchema.nullable()
});

export const siteIndexSchema = z.object({
  generatedAt: timestamp,
  asOf: z.string().regex(isoDate),
  mode: z.enum(["intraday", "final"]),
  dataStatus: z.enum(["complete", "partial", "error"]),
  dataMode: z.enum(["real", "simulated", "mixed"]),
  summaries: z.array(fundSummarySchema)
});

export type Fund = z.infer<typeof fundSchema>;
export type DataQuality = z.infer<typeof qualitySchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type HoldingsSnapshot = z.infer<typeof holdingsSnapshotSchema>;
export type FundAnalytics = z.infer<typeof analyticsSchema>;
export type SiteIndex = z.infer<typeof siteIndexSchema>;

export function parseFunds(input: unknown): Fund[] {
  const funds = z.array(fundSchema).parse(input);
  const ids = new Set<string>();
  for (const fund of funds) {
    if (ids.has(fund.id)) {
      throw new Error(`Duplicate fund id: ${fund.id}`);
    }
    ids.add(fund.id);
  }
  return funds;
}
