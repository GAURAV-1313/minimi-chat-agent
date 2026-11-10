// Combine several eval runs into per-scenario pass rates and averaged metrics. Single runs of the same code
// differed by up to 4/28 scenarios (DECISIONS.md #9), so decisions are made on rates across repeat runs, not on one run.
//
//   npx tsx eval/report.ts <label-substring>      e.g. npx tsx eval/report.ts iter3
import { existsSync, readdirSync, readFileSync } from "node:fs";

const filter = process.argv[2] ?? "";
const runs = readdirSync("eval/results")
  .filter((d) => d.includes(filter) && !d.includes("rejudge") && existsSync(`eval/results/${d}/results.json`))
  .map((d) => ({ dir: d, ...JSON.parse(readFileSync(`eval/results/${d}/results.json`, "utf8")) }));
if (!runs.length) throw new Error(`no runs match "${filter}"`);

const byId = new Map<string, { suite: string; pass: number; n: number; issues: string[] }>();
for (const r of runs)
  for (const x of (r.results as any[]).filter((x) => !x.skipped)) {
    const e = byId.get(x.id) ?? { suite: String(x.suite ?? "core"), pass: 0, n: 0, issues: [] as string[] };
    e.n++;
    if (x.pass) e.pass++;
    else e.issues.push(...((x.rules ?? []) as string[]), ...((x.majors ?? []) as string[]));
    byId.set(x.id, e);
  }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const passes = runs.map((r) => r.results.filter((x: any) => x.pass).length);
const graded = runs.map((r) => r.results.filter((x: any) => !x.skipped).length);
const total = runs[0].results.length;
console.log(`${runs.length} runs: ${runs.map((r) => r.dir).join(", ")}\n`);
console.log(`Pass per run: ${passes.map((p, i) => `${p}/${graded[i]}`).join(", ")}  ·  mean ${mean(passes).toFixed(1)}/${total}`);
for (const k of ["medianTotalMs", "p90TotalMs", "agentCostUsd"])
  console.log(`${k}: ${runs.map((r) => r.summary[k]).join(", ")}`);
for (const k of ["grounded", "fresh", "honest", "helpful", "concise", "best_in_class"])
  console.log(`${k}: ${mean(runs.map((r) => r.summary.avgScores[k])).toFixed(2)}`);
console.log(`guard flags: ${runs.map((r) => r.summary.guard?.flagged ?? "?").join(", ")}\n`);

console.log("Scenario".padEnd(26) + "suite    pass");
for (const [id, e] of [...byId].sort((a, b) => a[1].pass / a[1].n - b[1].pass / b[1].n))
  console.log(`${id.padEnd(26)}${e.suite.padEnd(9)}${e.pass}/${e.n}${e.issues.length ? "   " + e.issues[0].slice(0, 140) : ""}`);
