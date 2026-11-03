export type RunPhase = "morning" | "evening" | "weekly" | "monthly" | "yearly" | "all";

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

export function scheduledTimestamp(date: string, phase: RunPhase): string {
  return `${date}T${phase === "morning" || phase === "weekly" ? "10:30:00" : "22:30:00"}+08:00`;
}

export function resolveSchedule(schedule: string, createdAt: string) {
  const phase: RunPhase =
    schedule === "30 2 * * 6" ? "weekly" :
      schedule === "30 2 * * 1-5" ? "morning" : "evening";
  if (!["30 2 * * 6", "30 2 * * 1-5", "30 14 * * 1-5"].includes(schedule)) {
    throw new Error(`Unsupported schedule: ${schedule}`);
  }
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) throw new Error("Invalid workflow creation time.");
  const candidate = new Date(created);
  candidate.setUTCHours(phase === "evening" ? 14 : 2, 30, 0, 0);
  for (let days = 0; days < 8; days += 1) {
    const weekday = candidate.getUTCDay();
    const matches = phase === "weekly" ? weekday === 6 : weekday >= 1 && weekday <= 5;
    if (matches && candidate <= created) {
      const date = shanghaiDate(candidate);
      return { date, phase, scheduledAt: scheduledTimestamp(date, phase) };
    }
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  throw new Error("Cannot resolve scheduled business date.");
}

export function assertMorningWindow(date: string, now: Date): void {
  const open = Date.parse(`${date}T09:30:00+08:00`);
  const close = Date.parse(`${date}T11:30:00+08:00`);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid actual collection time.");
  if (now.getTime() < open || now.getTime() > close) {
    throw new Error(`Missed morning window for ${date}: actual time ${now.toISOString()}; no retrospective prediction created.`);
  }
}
