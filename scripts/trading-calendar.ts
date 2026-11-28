import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { addDays, mainlandTradingCalendar, tradingDayDecision } from "../src/lib/trading-calendar";

const calendarFile = "data/calendars/cn-exchange.json";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function verifyCalendar(): void {
  const years = new Set(mainlandTradingCalendar.coverage.years);
  if (years.size !== mainlandTradingCalendar.years.length) {
    throw new Error("Calendar coverage years and year records must be one-to-one.");
  }
  if (!years.has(2026)) throw new Error("Production calendar must cover all of 2026.");
  for (const year of mainlandTradingCalendar.years) {
    const exchanges = new Set(year.sources.map(({ exchange }) => exchange));
    if (!exchanges.has("SSE") || !exchanges.has("SZSE")) {
      throw new Error(`${year.year} must have both SSE and SZSE official sources.`);
    }
    const seen = new Set<string>();
    for (const closure of year.closures) {
      if (!closure.date.startsWith(`${year.year}-`)) {
        throw new Error(`${closure.date} is outside its calendar year.`);
      }
      if (seen.has(closure.date)) throw new Error(`Duplicate closure ${closure.date}.`);
      seen.add(closure.date);
      const day = new Date(`${closure.date}T00:00:00Z`).getUTCDay();
      if (day === 0 || day === 6) {
        throw new Error(`${closure.date} is a weekend and must be closed algorithmically.`);
      }
      if (tradingDayDecision(closure.date).status !== "closed") {
        throw new Error(`${closure.date} is not resolved as closed.`);
      }
    }
  }
  const nextYear = new Date().getUTCFullYear() + 1;
  if (!years.has(nextYear)) {
    console.warn(
      `WARNING: official SSE/SZSE calendar for ${nextYear} is not committed; scheduled runs will fail closed.`
    );
  }
  console.log(
    `Verified SSE/SZSE calendar coverage ${mainlandTradingCalendar.coverage.start} through ${mainlandTradingCalendar.coverage.end}.`
  );
}

export function textFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, "");
}

export function weekdayClosures(text: string, year: number): Array<{ date: string; reason: string }> {
  const closures: Array<{ date: string; reason: string }> = [];
  const pattern =
    /（[一二三四五六七八九十]+）([^：]+)：(\d{1,2})月(\d{1,2})日（星期[一二三四五六日]）(?:至(\d{1,2})月(\d{1,2})日（星期[一二三四五六日]）)?休市/g;
  for (const match of text.matchAll(pattern)) {
    const [, reason, startMonth, startDay, endMonth, endDay] = match;
    if (!reason || !startMonth || !startDay) continue;
    const start = `${year}-${startMonth.padStart(2, "0")}-${startDay.padStart(2, "0")}`;
    const end = endMonth && endDay
      ? `${year}-${endMonth.padStart(2, "0")}-${endDay.padStart(2, "0")}`
      : start;
    if (end < start) throw new Error(`Reversed closure range ${start}..${end}.`);
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (day !== 0 && day !== 6) closures.push({ date, reason });
    }
  }
  const reasons = new Set(closures.map(({ reason }) => reason));
  if (closures.length === 0 || reasons.size < 6) {
    throw new Error(`Could not parse a complete ${year} exchange holiday schedule.`);
  }
  return closures;
}

const sseSchema = z.object({
  docId: z.string().min(1),
  publishdate: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  content: z.string().min(1)
});
const szseSchema = z.object({
  code: z.union([z.literal(0), z.literal("0")]),
  data: z.object({
    docId: z.coerce.string().min(1),
    title: z.string().min(1),
    pubTime: z.union([z.string().min(1), z.number().positive()]),
    url: z.string().min(1),
    content: z.string().min(1)
  })
});

export async function fetchJson(
  url: string,
  fetcher: typeof fetch = fetch
): Promise<{ raw: string; value: unknown }> {
  const response = await fetcher(url, {
    headers: { "User-Agent": "FundOverwatch calendar maintainer (GitHub Actions)" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const raw = await response.text();
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new Error(`${url} did not return valid JSON.`);
  }
}

function publishedAt(value: string | number): string {
  if (typeof value === "number") {
    return `${new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, -1)}+08:00`;
  }
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) throw new Error(`Unrecognized publication timestamp: ${value}`);
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

async function refreshCalendar(): Promise<void> {
  const year = Number(argument("year"));
  const sseUrl = argument("sse-url");
  const szseUrl = argument("szse-url");
  if (!Number.isInteger(year) || !sseUrl || !szseUrl) {
    throw new Error("Refresh requires --year, --sse-url, and --szse-url from official notices.");
  }
  const [sseResult, szseResult] = await Promise.all([fetchJson(sseUrl), fetchJson(szseUrl)]);
  const sse = sseSchema.parse(sseResult.value);
  const szse = szseSchema.parse(szseResult.value).data;
  const expectedTitle = `${year}年部分节假日休市安排`;
  if (!sse.title.includes(expectedTitle) || !szse.title.includes(expectedTitle)) {
    throw new Error(`Both official notices must target ${expectedTitle}.`);
  }
  const sseText = textFromHtml(sse.content);
  const szseText = textFromHtml(szse.content);
  const sseClosures = weekdayClosures(sseText, year);
  const szseClosures = weekdayClosures(szseText, year);
  if (JSON.stringify(sseClosures) !== JSON.stringify(szseClosures)) {
    throw new Error("SSE and SZSE normalized calendars disagree; manual review required.");
  }
  const notice = (text: string, prefix: string) => {
    const match = text.match(new RegExp(`${prefix}〔\\d{4}〕\\d+号`));
    if (!match) throw new Error(`Could not parse ${prefix} notice number.`);
    return match[0];
  };
  const yearRecord = {
    year,
    sources: [
      {
        exchange: "SSE",
        notice: notice(sseText, "上证公告"),
        publishedAt: publishedAt(sse.publishdate),
        url: sse.url.replace(/^http:/, "https:"),
        jsonUrl: sseUrl,
        sha256: createHash("sha256").update(sseResult.raw).digest("hex")
      },
      {
        exchange: "SZSE",
        notice: notice(szseText, "深证会"),
        publishedAt: publishedAt(szse.pubTime),
        url: szse.url.startsWith("http") ? szse.url : new URL(szse.url, "https://www.szse.cn").href,
        jsonUrl: szseUrl,
        sha256: createHash("sha256").update(szseResult.raw).digest("hex")
      }
    ],
    closures: sseClosures
  };
  const current = JSON.parse(await readFile(calendarFile, "utf8")) as typeof mainlandTradingCalendar;
  const nextYears = [
    ...current.years.filter((entry) => entry.year !== year),
    yearRecord
  ].sort((left, right) => left.year - right.year);
  const next = {
    ...current,
    asOf: yearRecord.sources.map(({ publishedAt: value }) => value.slice(0, 10)).sort().at(-1),
    generatedAt: new Date().toISOString(),
    coverage: {
      start: `${nextYears[0]?.year}-01-01`,
      end: `${nextYears.at(-1)?.year}-12-31`,
      years: nextYears.map(({ year: value }) => value)
    },
    years: nextYears
  };
  const committed = current.years.find((entry) => entry.year === year);
  if (flag("check")) {
    if (!committed || JSON.stringify(committed.closures) !== JSON.stringify(yearRecord.closures)) {
      throw new Error(`Committed ${year} calendar does not match current official sources.`);
    }
    console.log(`Official SSE/SZSE ${year} sources agree with the committed calendar.`);
    return;
  }
  const temporary = `${calendarFile}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, calendarFile);
  console.log(`Refreshed ${year} SSE/SZSE calendar from matching official notices.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("refresh")) {
    await refreshCalendar();
  } else {
    verifyCalendar();
  }
}
