import { z } from "zod";
import type { Fund, HoldingsSnapshot, Quote } from "./domain";
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

interface EastmoneyProviderOptions {
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  navEndpoint?: string;
  metadataEndpoint?: string;
}

const USER_AGENT = "FundOverwatch/0.1 (+https://github.com/nodegetout/FundOverwatch)";
const PAGE_SIZE = 20;
const MAX_NAV_OBSERVATIONS = 260;

export class EastmoneyNavProvider implements FundDataProvider {
  readonly name = "eastmoney-f10-nav-v1";
  private readonly request: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly navEndpoint: string;
  private readonly metadataEndpoint: string;

  constructor(options: EastmoneyProviderOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.navEndpoint =
      options.navEndpoint ?? "https://api.fund.eastmoney.com/f10/lsjz";
    this.metadataEndpoint =
      options.metadataEndpoint ??
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation";
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
  ): Promise<{ quotes: Quote[]; holdings: HoldingsSnapshot }> {
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
      isSimulated: false,
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
    const holdings: HoldingsSnapshot = {
      fundId: fund.id,
      date: sourceAsOf,
      holdings: [],
      sectors: [],
      countries: [],
      quality: {
        status: "partial",
        source: this.name,
        dataMode: "real",
        isSimulated: false,
        collectedAt: context.collectedAt,
        warnings: ["该公开接口仅用于单位净值历史，未提供可规范化的持仓快照。"],
        missingFields: ["holdings", "sectors", "countries"]
      }
    };
    return { quotes, holdings };
  }
}
