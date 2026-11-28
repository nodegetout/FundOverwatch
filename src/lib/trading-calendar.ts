import { z } from "zod";
import rawCalendar from "../../data/calendars/cn-exchange.json";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const sourceSchema = z.object({
  exchange: z.enum(["SSE", "SZSE"]),
  notice: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  url: z.string().url(),
  jsonUrl: z.string().url()
});
const calendarSchema = z.object({
  schemaVersion: z.literal(1),
  market: z.literal("SSE/SZSE"),
  timezone: z.literal("Asia/Shanghai"),
  asOf: z.string().regex(isoDate),
  generatedAt: z.string().datetime({ offset: true }),
  coverage: z.object({
    start: z.string().regex(isoDate),
    end: z.string().regex(isoDate),
    years: z.array(z.number().int()).min(1)
  }),
  years: z.array(
    z.object({
      year: z.number().int(),
      sources: z.array(sourceSchema).length(2),
      closures: z.array(
        z.object({
          date: z.string().regex(isoDate),
          reason: z.string().min(1)
        })
      )
    })
  )
});

export const mainlandTradingCalendar = calendarSchema.parse(rawCalendar);
const years = new Map(mainlandTradingCalendar.years.map((year) => [year.year, year]));

export type TradingDayStatus =
  | "trading"
  | "closed"
  | "calendar-unavailable"
  | "source-error";

export interface TradingDayDecision {
  date: string;
  status: TradingDayStatus;
  reason: string;
  source: string;
  asOf: string;
  coverage: { start: string; end: string };
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function tradingDayDecision(
  date: string,
  options: { calendarOverride?: boolean; sourceConflict?: string } = {}
): TradingDayDecision {
  const metadata = {
    date,
    source: options.calendarOverride
      ? "manual-workflow-override"
      : mainlandTradingCalendar.market,
    asOf: mainlandTradingCalendar.asOf,
    coverage: {
      start: mainlandTradingCalendar.coverage.start,
      end: mainlandTradingCalendar.coverage.end
    }
  };
  const day = weekday(date);
  if (day === 0 || day === 6) {
    return { ...metadata, status: "closed", reason: "周末休市" };
  }
  if (options.sourceConflict) {
    return {
      ...metadata,
      status: "source-error",
      reason: `交易日历与实时市场状态冲突：${options.sourceConflict}`
    };
  }
  const year = years.get(Number(date.slice(0, 4)));
  if (!year) {
    if (options.calendarOverride) {
      return {
        ...metadata,
        status: "trading",
        reason: "手动回放已明确覆盖缺失的交易日历；仅限本次运行"
      };
    }
    return {
      ...metadata,
      status: "calendar-unavailable",
      reason: `SSE/SZSE 交易日历未覆盖 ${date.slice(0, 4)} 年`
    };
  }
  const closure = year.closures.find((entry) => entry.date === date);
  return closure
    ? { ...metadata, status: "closed", reason: `${closure.reason}休市` }
    : { ...metadata, status: "trading", reason: "SSE/SZSE 已发布日历：交易日" };
}

export function isMainlandTradingDay(
  date: string,
  options?: { calendarOverride?: boolean; sourceConflict?: string }
): boolean {
  return tradingDayDecision(date, options).status === "trading";
}

export function tradingCalendarCoverage(date: string): "explicit" | "unavailable" {
  return years.has(Number(date.slice(0, 4))) ? "explicit" : "unavailable";
}

export function tradingDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (tradingDayDecision(date).status === "trading") dates.push(date);
  }
  return dates;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function lastTradingDate(startDate: string, endDate: string): string | null {
  return tradingDatesBetween(startDate, endDate).at(-1) ?? null;
}
