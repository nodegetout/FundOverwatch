import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Fund,
  Holding,
  HoldingQuote,
  HoldingQuoteBatch,
  HoldingsSnapshot,
  Quote
} from "./domain";
import type { CollectionContext, FundDataProvider } from "./provider";

const metadataSchema = z.object({
  Datas: z.object({
    FCODE: z.string(),
    SHORTNAME: z.string()
  })
});

const navSchema = z.object({
  ErrCode: z.number(),
  ErrMsg: z.string().nullable().optional(),
  TotalCount: z.number().int().nonnegative(),
  Data: z
    .object({
      LSJZList: z.array(
        z.object({
          FSRQ: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          DWJZ: z.string()
        })
      )
    })
    .nullable()
});

const stockPositionSchema = z.object({
  GPDM: z.string().min(1),
  GPJC: z.string().min(1),
  JZBL: z.string(),
  NEWTEXCH: z.string().nullable().optional(),
  INDEXNAME: z.string().nullable().optional()
});

const bondPositionSchema = z.object({
  ZQDM: z.string().min(1),
  ZQMC: z.string().min(1),
  ZJZBL: z.string()
});

const fundPositionSchema = z.object({
  TZJJDM: z.string().min(1),
  TZJJMC: z.string().min(1),
  ZJZBL: z.string()
});

const positionSchema = z.object({
  Success: z.boolean(),
  ErrCode: z.number(),
  ErrMsg: z.string().nullable().optional(),
  Expansion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  Datas: z
    .object({
      fundStocks: z.array(stockPositionSchema).nullable(),
      fundboods: z.array(bondPositionSchema).nullable(),
      fundfofs: z.array(fundPositionSchema).nullable(),
      ETFCODE: z.string().nullable(),
      ETFSHORTNAME: z.string().nullable()
    })
    .nullable()
});

const assetQuoteSchema = z.object({
  data: z
    .object({
      f57: z.string(),
      f58: z.string(),
      f86: z.number(),
      f170: z.number()
    })
    .nullable()
});

interface EastmoneyProviderOptions {
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  navEndpoint?: string;
  metadataEndpoint?: string;
  positionEndpoint?: string;
  quoteEndpoint?: string;
}

const USER_AGENT = "FundOverwatch/0.1 (+https://github.com/nodegetout/FundOverwatch)";
const PAGE_SIZE = 20;
const MAX_NAV_OBSERVATIONS = 260;
const HOLDINGS_SOURCE = "eastmoney-position-v1";

type PositionPayload = z.infer<typeof positionSchema>;

export function holdingKey(holding: Pick<Holding, "assetType" | "symbol">): string {
  return `${holding.assetType}:${holding.symbol}`;
}

function parseWeight(value: string, label: string): number {
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error(`Invalid Eastmoney holding weight for ${label}: ${value}`);
  }
  return percentage / 100;
}

function previousQuarterEnd(date: string): string {
  const [yearValue, monthValue] = date.split("-").map(Number);
  const year = yearValue ?? 0;
  const month = monthValue ?? 0;
  if (month === 3) return `${year - 1}-12-31`;
  if (month === 6) return `${year}-03-31`;
  if (month === 9) return `${year}-06-30`;
  if (month === 12) return `${year}-09-30`;
  throw new Error(`Unsupported holdings report date: ${date}`);
}

function baseHolding(
  input: Pick<Holding, "name" | "symbol" | "assetType" | "weight" | "sector" | "quoteRef">
): Holding {
  return {
    ...input,
    source: HOLDINGS_SOURCE,
    previousWeight: null,
    weightChange: null,
    changeStatus: "unavailable",
    country: null
  };
}

function positionsFromPayload(payload: PositionPayload): Holding[] {
  if (!payload.Datas) return [];
  const positions: Holding[] = [
    ...(payload.Datas.fundStocks ?? []).map((position) =>
      baseHolding({
        name: position.GPJC,
        symbol: position.GPDM,
        assetType: "stock",
        weight: parseWeight(position.JZBL, position.GPDM),
        sector:
          position.INDEXNAME && position.INDEXNAME !== "--" ? position.INDEXNAME : null,
        quoteRef:
          position.NEWTEXCH && /^\d+$/.test(position.NEWTEXCH)
            ? `${position.NEWTEXCH}.${position.GPDM}`
            : null
      })
    ),
    ...(payload.Datas.fundboods ?? []).map((position) =>
      baseHolding({
        name: position.ZQMC,
        symbol: position.ZQDM,
        assetType: "bond",
        weight: parseWeight(position.ZJZBL, position.ZQDM),
        sector: null,
        quoteRef: null
      })
    ),
    ...(payload.Datas.fundfofs ?? []).map((position) =>
      baseHolding({
        name: position.TZJJMC,
        symbol: position.TZJJDM,
        assetType: "fund",
        weight: parseWeight(position.ZJZBL, position.TZJJDM),
        sector: null,
        quoteRef: null
      })
    )
  ];
  if (payload.Datas.ETFCODE && payload.Datas.ETFSHORTNAME) {
    positions.push(
      baseHolding({
        name: payload.Datas.ETFSHORTNAME,
        symbol: payload.Datas.ETFCODE,
        assetType: "target-etf",
        weight: null,
        sector: null,
        quoteRef: null
      })
    );
  }

  const deduplicated = new Map<string, Holding>();
  for (const position of positions) {
    const key = holdingKey(position);
    const existing = deduplicated.get(key);
    if (!existing) {
      deduplicated.set(key, position);
      continue;
    }
    const weight =
      existing.weight === null || position.weight === null
        ? existing.weight ?? position.weight
        : existing.weight + position.weight;
    if (weight !== null && weight > 1) throw new Error(`Combined holding weight exceeds 100%: ${key}`);
    deduplicated.set(key, { ...existing, weight });
  }
  return [...deduplicated.values()].sort((left, right) =>
    holdingKey(left).localeCompare(holdingKey(right))
  );
}

function holdingsHash(holdings: Holding[]): string {
  const disclosure = holdings.map(
    ({ assetType, name, quoteRef, sector, source, symbol, weight }) => ({
      assetType,
      name,
      quoteRef,
      sector,
      source,
      symbol,
      weight
    })
  );
  return createHash("sha256").update(JSON.stringify(disclosure)).digest("hex");
}

export function compareHoldings(current: Holding[], previous: Holding[] | null): Holding[] {
  if (!previous) return current;
  const previousByKey = new Map(previous.map((holding) => [holdingKey(holding), holding]));
  const compared = current.map((holding) => {
    const prior = previousByKey.get(holdingKey(holding));
    previousByKey.delete(holdingKey(holding));
    if (!prior) {
      return holding.weight === null
        ? holding
        : {
            ...holding,
            previousWeight: 0,
            weightChange: holding.weight,
            changeStatus: "new" as const
          };
    }
    if (holding.weight === null || prior.weight === null) return holding;
    const change = Number((holding.weight - prior.weight).toFixed(8));
    const changeStatus =
      Math.abs(change) < 0.000_001
        ? ("unchanged" as const)
        : change > 0
          ? ("increased" as const)
          : ("decreased" as const);
    return {
      ...holding,
      previousWeight: prior.weight,
      weightChange: change,
      changeStatus
    };
  });
  for (const prior of previousByKey.values()) {
    if (prior.weight === null) continue;
    compared.push({
      ...prior,
      weight: 0,
      previousWeight: prior.weight,
      weightChange: -prior.weight,
      changeStatus: "exited"
    });
  }
  return compared.sort((left, right) => (right.weight ?? -1) - (left.weight ?? -1));
}

function buildHoldingsSnapshot(
  fundId: string,
  reportDate: string,
  positions: Holding[],
  previous: Holding[] | null,
  previousDate: string | null,
  collectedAt: string,
  warnings: string[] = []
): HoldingsSnapshot {
  const compared = compareHoldings(positions, previous);
  const sectors = new Map<string, number>();
  for (const holding of positions) {
    if (holding.assetType !== "stock" || !holding.sector || holding.weight === null) continue;
    sectors.set(holding.sector, (sectors.get(holding.sector) ?? 0) + holding.weight);
  }
  return {
    fundId,
    date: reportDate,
    previousDate,
    contentHash: createHash("sha256")
      .update(`${holdingsHash(positions)}:${previous ? holdingsHash(previous) : "none"}`)
      .digest("hex"),
    holdings: compared,
    sectors: [...sectors.entries()]
      .map(([name, weight]) => ({ name, weight }))
      .sort((left, right) => right.weight - left.weight),
    countries: [],
    quality: {
      status: "complete",
      source: HOLDINGS_SOURCE,
      dataMode: "real",
      isSimulated: false as const,
      collectedAt,
      warnings: [
        "定期报告持仓，非实时仓位；权重为占基金净值比例。",
        "地域未由源数据可靠披露，因此不做推断。",
        ...warnings
      ],
      missingFields: ["countries"]
    }
  };
}

export class EastmoneyNavProvider implements FundDataProvider {
  readonly name = "eastmoney-fund-v2";
  private readonly request: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly navEndpoint: string;
  private readonly metadataEndpoint: string;
  private readonly positionEndpoint: string;
  private readonly quoteEndpoint: string;
  private readonly quoteCache = new Map<string, Promise<unknown>>();

  constructor(options: EastmoneyProviderOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.navEndpoint =
      options.navEndpoint ?? "https://api.fund.eastmoney.com/f10/lsjz";
    this.metadataEndpoint =
      options.metadataEndpoint ??
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation";
    this.positionEndpoint =
      options.positionEndpoint ??
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition";
    this.quoteEndpoint =
      options.quoteEndpoint ?? "https://push2.eastmoney.com/api/qt/stock/get";
  }

  private async fetchPositions(code: string, date?: string) {
    const url = new URL(this.positionEndpoint);
    url.search = new URLSearchParams({
      FCODE: code,
      ...(date ? { DATE: date } : {}),
      deviceid: "FundOverwatch",
      plat: "Wap",
      product: "EFund",
      version: "2.0.0"
    }).toString();
    const payload = positionSchema.parse(await this.getJson(url));
    if (!payload.Success || payload.ErrCode !== 0) {
      throw new Error(`Eastmoney holdings error for ${code}: ${payload.ErrMsg ?? payload.ErrCode}`);
    }
    return payload;
  }

  private async collectAssetQuote(
    holding: Holding,
    context: CollectionContext
  ): Promise<HoldingQuote> {
    const assetKey = holdingKey(holding);
    if (!holding.quoteRef) {
      return {
        assetKey,
        status: "unavailable",
        dayChange: null,
        asOf: null,
        source: "eastmoney-push2-v1",
        warnings: ["源持仓未提供可靠行情市场标识。"]
      };
    }
    try {
      let request = this.quoteCache.get(holding.quoteRef);
      if (!request) {
        const url = new URL(this.quoteEndpoint);
        url.search = new URLSearchParams({
          secid: holding.quoteRef,
          fields: "f57,f58,f86,f170"
        }).toString();
        request = this.getJson(url);
        this.quoteCache.set(holding.quoteRef, request);
      }
      const payload = assetQuoteSchema.parse(await request);
      if (!payload.data || payload.data.f57 !== holding.symbol || payload.data.f86 <= 0) {
        throw new Error(`Quote identity or timestamp mismatch for ${holding.quoteRef}`);
      }
      const asOf = new Date(payload.data.f86 * 1000).toISOString();
      const stale = asOf.slice(0, 10) < context.date;
      return {
        assetKey,
        status: stale ? "stale" : "available",
        dayChange: payload.data.f170 / 10_000,
        asOf,
        source: "eastmoney-push2-v1",
        warnings: stale ? [`最新可用行情时间为 ${asOf}。`] : []
      };
    } catch (error) {
      return {
        assetKey,
        status: "unavailable",
        dayChange: null,
        asOf: null,
        source: "eastmoney-push2-v1",
        warnings: [error instanceof Error ? error.message : "标的行情请求失败。"]
      };
    }
  }

  private async getJson(url: URL): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.request(url, {
          headers: {
            Accept: "application/json",
            Referer: "https://fund.eastmoney.com/",
            "User-Agent": USER_AGENT
          },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    }
    throw new Error(`Eastmoney request failed after ${this.retries + 1} attempts`, {
      cause: lastError
    });
  }

  async collectFund(
    fund: Fund,
    context: CollectionContext
  ): Promise<{
    quotes: Quote[];
    holdings: HoldingsSnapshot;
    historicalHoldings: HoldingsSnapshot[];
    holdingQuotes: HoldingQuoteBatch;
  }> {
    const code = fund.providerRef.replace(/^eastmoney:/, "");
    if (!/^\d{6}$/.test(code)) {
      throw new Error(`Invalid Eastmoney providerRef for ${fund.id}: ${fund.providerRef}`);
    }

    const metadataUrl = new URL(this.metadataEndpoint);
    metadataUrl.search = new URLSearchParams({
      FCODE: code,
      deviceid: "FundOverwatch",
      plat: "Wap",
      product: "EFund",
      version: "2.0.0"
    }).toString();
    const metadata = metadataSchema.parse(await this.getJson(metadataUrl));
    if (metadata.Datas.FCODE !== code) {
      throw new Error(
        `Eastmoney fund code mismatch: requested ${code}, received ${metadata.Datas.FCODE}`
      );
    }

    const fetchPage = async (pageIndex: number) => {
      const navUrl = new URL(this.navEndpoint);
      navUrl.search = new URLSearchParams({
        fundCode: code,
        pageIndex: String(pageIndex),
        pageSize: String(PAGE_SIZE),
        startDate: "",
        endDate: ""
      }).toString();
      const payload = navSchema.parse(await this.getJson(navUrl));
      if (payload.ErrCode !== 0) {
        throw new Error(`Eastmoney NAV error for ${code}: ${payload.ErrMsg ?? payload.ErrCode}`);
      }
      return payload;
    };
    const firstPage = await fetchPage(1);
    const firstRows = firstPage.Data?.LSJZList ?? [];
    if (!firstRows.length || firstPage.TotalCount === 0) {
      throw new Error(`Eastmoney returned no NAV history for ${code}`);
    }
    const expectedCount = Math.min(firstPage.TotalCount, MAX_NAV_OBSERVATIONS);
    const pageCount = Math.ceil(expectedCount / PAGE_SIZE);
    const rows = [...firstRows];
    for (let page = 2; page <= pageCount; page += 1) {
      const payload = await fetchPage(page);
      const pageRows = payload.Data?.LSJZList ?? [];
      if (!pageRows.length) {
        throw new Error(`Eastmoney returned an empty NAV page ${page} for ${code}`);
      }
      rows.push(...pageRows);
    }

    const normalized = rows
      .filter(({ FSRQ }) => FSRQ <= context.date)
      .map(({ FSRQ, DWJZ }) => {
        const nav = Number(DWJZ);
        if (!Number.isFinite(nav) || nav <= 0) {
          throw new Error(`Eastmoney returned invalid unit NAV for ${code} on ${FSRQ}`);
        }
        return { date: FSRQ, nav };
      })
      .sort((left, right) => left.date.localeCompare(right.date));
    if (!normalized.length) {
      throw new Error(`Eastmoney returned no valid NAV values for ${code} on or before ${context.date}`);
    }

    const sourceAsOf = normalized.at(-1)?.date;
    if (!sourceAsOf) throw new Error(`Unable to determine source date for ${code}`);
    const stale = sourceAsOf < context.date;
    const warnings = [
      "日终单位净值，不是盘中估值或交易价格。",
      ...(stale ? [`最近已公布净值日期为 ${sourceAsOf}。`] : []),
      ...(metadata.Datas.SHORTNAME === fund.name
        ? []
        : [`数据源名称为“${metadata.Datas.SHORTNAME}”，展示名称按项目基金清单维护。`])
    ];
    const quality = {
      status: stale ? ("stale" as const) : ("partial" as const),
      source: this.name,
      dataMode: "real" as const,
      isSimulated: false as const,
      collectedAt: context.collectedAt,
      warnings,
      missingFields: ["price", "benchmarkPrice"]
    };
    const quotes: Quote[] = normalized.map(({ date, nav }) => ({
      fundId: fund.id,
      date,
      nav,
      price: null,
      benchmarkPrice: null,
      currency: fund.currency,
      valuation: "final",
      quality
    }));

    const currentPayload = await this.fetchPositions(code);
    const reportDate = currentPayload.Expansion;
    const currentPositions = positionsFromPayload(currentPayload);
    if (!reportDate || !currentPositions.length) {
      throw new Error(`Eastmoney returned empty current holdings for ${code}`);
    }

    const expectedPreviousDate = previousQuarterEnd(reportDate);
    let previousPositions: Holding[] | null = null;
    let previousDate: string | null = null;
    const holdingsWarnings: string[] = [];
    try {
      const previousPayload = await this.fetchPositions(code, expectedPreviousDate);
      const normalizedPrevious = positionsFromPayload(previousPayload);
      if (previousPayload.Expansion === expectedPreviousDate && normalizedPrevious.length) {
        previousPositions = normalizedPrevious;
        previousDate = expectedPreviousDate;
      } else {
        holdingsWarnings.push(`暂无 ${expectedPreviousDate} 上一披露期持仓数据。`);
      }
    } catch (error) {
      holdingsWarnings.push(
        `上一披露期持仓不可用：${error instanceof Error ? error.message : "未知错误"}`
      );
    }

    const holdings = buildHoldingsSnapshot(
      fund.id,
      reportDate,
      currentPositions,
      previousPositions,
      previousDate,
      context.collectedAt,
      holdingsWarnings
    );
    const historicalHoldings = previousPositions && previousDate
      ? [
          buildHoldingsSnapshot(
            fund.id,
            previousDate,
            previousPositions,
            null,
            null,
            context.collectedAt,
            ["该快照作为当前披露期的比较基准保存。"]
          )
        ]
      : [];
    const holdingQuotes: HoldingQuoteBatch = {
      fundId: fund.id,
      collectedAt: context.collectedAt,
      quotes: await Promise.all(
        currentPositions.map((holding) => this.collectAssetQuote(holding, context))
      )
    };
    return { quotes, holdings, historicalHoldings, holdingQuotes };
  }
}
