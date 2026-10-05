import { runPipeline, shanghaiDate, type RunPhase } from "./pipeline";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const date = argument("date") ?? shanghaiDate();
const phase = (argument("phase") ?? argument("mode") ?? "evening") as RunPhase;

if (!["morning", "evening", "weekly", "monthly", "yearly", "all"].includes(phase)) {
  throw new Error(`Invalid phase: ${phase}.`);
}

await runPipeline(date, phase);
