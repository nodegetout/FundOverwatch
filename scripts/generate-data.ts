import {
  resolveScheduledRun,
  runPipeline,
  scheduledTimestamp,
  shanghaiDate,
  type RunPhase
} from "./pipeline";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const schedule = argument("schedule");
const actualRunAt = argument("actual-time") ?? new Date().toISOString();
const scheduled = schedule ? resolveScheduledRun(schedule, new Date(actualRunAt)) : null;
const date = argument("date") ?? scheduled?.date ?? shanghaiDate(new Date(actualRunAt));
const phase = (argument("phase") ?? argument("mode") ?? scheduled?.phase ?? "evening") as RunPhase;

if (!["morning", "evening", "weekly", "monthly", "yearly", "all"].includes(phase)) {
  throw new Error(`Invalid phase: ${phase}.`);
}

await runPipeline(date, phase, {
  actualRunAt,
  scheduledAt: scheduled?.scheduledAt ?? scheduledTimestamp(date, phase),
  calendarOverride: process.argv.includes("--calendar-override")
});
