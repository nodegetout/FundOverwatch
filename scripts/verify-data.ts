import { readFile } from "node:fs/promises";
import { siteIndexSchema } from "../src/lib/domain";

const raw = JSON.parse(await readFile("public/data/index.json", "utf8")) as unknown;
const index = siteIndexSchema.parse(raw);
if (!index.summaries.length) throw new Error("Generated index contains no funds.");
if (index.summaries.some(({ analytics }) => !analytics || analytics.observations < 200)) {
  throw new Error("Generated analytics do not contain enough observations.");
}
console.log(`Validated index for ${index.summaries.length} funds as of ${index.asOf}.`);
