import type { FundAnalytics, Quote } from "./domain";

function finite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

export function percentageChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return current / previous - 1;
}

export function latestOnOrBefore(quotes: Quote[], targetDate: string): Quote | null {
  for (let index = quotes.length - 1; index >= 0; index -= 1) {
    const quote = quotes[index];
    if (quote && quote.date <= targetDate) return quote;
  }
  return null;
}

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function average(values: Array<number | null>, window: number): number | null {
  const valid = values.filter((value): value is number => value !== null).slice(-window);
  if (valid.length < window) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function annualizedVolatility(values: Array<number | null>): number | null {
  const returns: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const change = percentageChange(values[index] ?? null, values[index - 1] ?? null);
    if (change !== null) returns.push(change);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function maxDrawdown(values: Array<number | null>): number | null {
  let peak: number | null = null;
  let drawdown = 0;
  let observations = 0;
  for (const value of values) {
    if (value === null || value <= 0) continue;
    observations += 1;
    peak = peak === null ? value : Math.max(peak, value);
    drawdown = Math.min(drawdown, value / peak - 1);
  }
  return observations ? drawdown : null;
}

export function calculateAnalytics(fundId: string, input: Quote[]): FundAnalytics | null {
  const quotes = [...input].sort((a, b) => a.date.localeCompare(b.date));
  const latest = quotes.at(-1);
  if (!latest) return null;
  const prices = quotes.map((quote) => finite(quote.price ?? quote.nav));
  const current = finite(latest.price ?? latest.nav);
  const benchmarkCurrent = finite(latest.benchmarkPrice);
  const previous = quotes.at(-2);
  const periodReturn = (days: number): number | null => {
    const base = latestOnOrBefore(quotes, subtractDays(latest.date, days));
    return percentageChange(current, finite(base?.price ?? base?.nav));
  };
  const yearBase = latestOnOrBefore(quotes, subtractDays(latest.date, 365));
  const benchmarkReturn = percentageChange(benchmarkCurrent, finite(yearBase?.benchmarkPrice));
  const yearReturn = periodReturn(365);

  return {
    fundId,
    asOf: latest.date,
    nav: finite(latest.nav),
    price: finite(latest.price),
    returns: {
      day: percentageChange(current, finite(previous?.price ?? previous?.nav)),
      week: periodReturn(7),
      month: periodReturn(30),
      year: yearReturn
    },
    annualizedVolatility: annualizedVolatility(prices),
    maxDrawdown: maxDrawdown(prices),
    movingAverages: {
      day20: average(prices, 20),
      day60: average(prices, 60)
    },
    benchmarkReturn,
    excessReturn:
      yearReturn === null || benchmarkReturn === null ? null : yearReturn - benchmarkReturn,
    observations: quotes.length
  };
}
