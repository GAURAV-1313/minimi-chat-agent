// Offline: re-run the number guard over the cited evidence stored in every eval run. No API calls.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { checkNumbers, numbersIn, canon } from "../src/guard.ts";
let v1 = 0, v2 = 0, ver = 0, unv = 0, turns = 0, turnsV1 = 0, turnsV2 = 0;
const flagged: string[] = [];
for (const d of readdirSync("eval/results").filter((d) => existsSync(`eval/results/${d}/results.json`))) {
  const r = JSON.parse(readFileSync(`eval/results/${d}/results.json`, "utf8"));
  if (r.summary.rejudgeOf) continue;
  for (const x of r.results)
    for (const t of x.turns) {
      turns++;
      const spans = (t.evidence ?? []).map((e: any) => ({ ...e, sourceIds: [] }));
      // v1: flag every number not visible in the excerpts
      let n1 = 0;
      for (const s of spans) {
        const seen = new Set(s.citedTexts.flatMap((c: string) => [...c.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => canon(m[0]))));
        n1 += numbersIn(s.text).filter((v) => !seen.has(canon(v))).length;
      }
      const g = checkNumbers(spans);
      v1 += n1; v2 += g.flagged.length; ver += g.verified; unv += g.unverifiable;
      if (n1) turnsV1++;
      if (g.flagged.length) turnsV2++;
      for (const f of g.flagged) flagged.push(`${x.id}: ${f.value} | ${f.sentence.slice(0, 80)}`);
    }
}
console.log({ turns, v1Flags: v1, v1TurnsFlagged: turnsV1, v2Flags: v2, v2TurnsFlagged: turnsV2, verified: ver, unverifiable: unv });
console.log(flagged.join("\n"));
