import { runPipeline, shanghaiDate, type RunMode } from "./pipeline";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const date = argument("date") ?? shanghaiDate();
const mode = (argument("mode") ?? "final") as RunMode;

if (mode !== "intraday" && mode !== "final") {
  throw new Error(`Invalid mode: ${mode}. Expected intraday or final.`);
}

await runPipeline(date, mode);
