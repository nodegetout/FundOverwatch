import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { siteIndexSchema } from "../src/lib/domain";
import { businessHealth } from "../src/lib/business-health";
import { shanghaiDate, type RunPhase } from "../src/lib/run-timing";

const date = process.env.RUN_DATE || shanghaiDate();
const phase = (process.env.RUN_PHASE || "evening") as RunPhase;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["morning", "evening", "weekly", "monthly", "yearly", "all"].includes(phase)) {
  throw new Error("Invalid health-check business date or phase.");
}
const index = siteIndexSchema.parse(JSON.parse(await readFile("public/data/index.json", "utf8")));
const runs = z.array(z.object({ runKey: z.string() })).parse(JSON.parse(await readFile("data/runs.json", "utf8")));
const issues = businessHealth(index, date, phase, new Date(), runs.map(({ runKey }) => runKey));
const lines = [
  `### Business health: ${date} / ${phase}`,
  `NAV as of: ${index.asOf}; generated: ${index.generatedAt}; funds: ${index.summaries.length}`,
  ...(issues.length ? issues.map((issue) => `- ${issue}`) : ["- Healthy"])
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
if (issues.length) process.exitCode = 1;
