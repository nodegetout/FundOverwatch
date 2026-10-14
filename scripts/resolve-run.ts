import { appendFile } from "node:fs/promises";
import { resolveSchedule, scheduledTimestamp, shanghaiDate, type RunPhase } from "../src/lib/run-timing";

let date = process.env.INPUT_DATE || shanghaiDate();
let phase = (process.env.INPUT_PHASE || "all") as RunPhase;
if (process.env.EVENT_NAME === "schedule") {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !runId || !/^\d+$/.test(runId)) {
    throw new Error("Missing or invalid workflow identity.");
  }
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: ["Bearer", process.env.GITHUB_TOKEN ?? ""].join(" "),
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Cannot resolve original workflow creation time: HTTP ${response.status}`);
  const run = await response.json() as { created_at: string };
  ({ date, phase } = resolveSchedule(process.env.SCHEDULE ?? "", run.created_at));
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["morning", "evening", "weekly", "monthly", "yearly", "all"].includes(phase)) {
  throw new Error("Invalid business date or phase.");
}
const scheduledAt = scheduledTimestamp(date, phase);
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
await appendFile(process.env.GITHUB_OUTPUT, `date=${date}\nphase=${phase}\nscheduled_at=${scheduledAt}\n`);
console.log(`Business date=${date}, phase=${phase}, scheduledAt=${scheduledAt}, resolvedAt=${new Date().toISOString()}`);
