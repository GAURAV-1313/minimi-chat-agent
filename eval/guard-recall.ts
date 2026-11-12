// Offline: how many WRONG numbers would the guard catch? (Precision is measured by replay-guard.ts.) No API calls.
//
// Method: every price or percentage in a cited sentence, across every stored eval run, is corrupted one at a time,
// and the real checkNumbers() runs on the corrupted sentence with the real excerpts it cited.
//   made-up    the value moves by a realistic amount to a number that appears nowhere in the cited excerpts
//              ($90 -> $113): an invented or misremembered price.
//   wrong row  the value is swapped for a different price/percentage of the same kind from the same excerpts
//              ($90 -> $150 when the excerpt lists both): the answer read the wrong row of a pricing table.
//
// Read the output carefully (an independent review pointed this out): most of it follows from the guard's own rules.
// The guard flags a number exactly when it is absent from excerpts that are all complete, so:
//   - a made-up price is caught if and only if every cited excerpt is complete (by design),
//   - a wrong-row price is never caught, because it IS in the excerpt (by design).
// The measured, data-dependent fact is therefore the share of prices that sit behind complete excerpts.
// Scope: money and percentages only. Wrong counts, limits or versions ("10 GB", "v26") are not checked at all.
//
//   npx tsx eval/guard-recall.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { canon, checkNumbers, isTruncated, joinSplitDigits, numbersIn, type CitedSpan } from "../src/guard.ts";

type Case = { kind: "made-up" | "wrong-row"; complete: boolean; caught: boolean };
const cases: Case[] = [];
const FACTORS = [1.25, 0.8, 1.5, 0.6, 2, 1.1];
const kindOf = (v: string) => (/%|percent/i.test(v) ? "%" : (v.match(/[$€£₹¥]|USD|EUR|GBP|INR/)?.[0] ?? "?"));

/** Format `value` the way `original` was written: same currency symbol / suffix, same separators and decimals. */
function reformat(original: string, value: number): string {
  const m = original.match(/^([$€£₹¥]\s?)?([\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return String(value);
  const [, prefix = "", digits, suffix] = m;
  const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
  let body = value.toFixed(decimals);
  if (digits.includes(",")) body = Number(body).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${prefix}${body}${suffix}`;
}

function caughtAfterReplacing(span: CitedSpan, original: string, at: number, replacement: string): boolean {
  const text = span.text.slice(0, at) + replacement + span.text.slice(at + original.length);
  return checkNumbers([{ ...span, text }]).flagged.some((f) => canon(f.value) === canon(replacement));
}

let spans = 0;
let prices = 0;
let pricesComplete = 0;
for (const d of readdirSync("eval/results").filter((d) => existsSync(`eval/results/${d}/results.json`))) {
  const run = JSON.parse(readFileSync(`eval/results/${d}/results.json`, "utf8"));
  if (run.summary.rejudgeOf) continue; // re-gradings repeat the same answers
  for (const r of run.results)
    for (const t of r.turns ?? [])
      for (const e of t.evidence ?? []) {
        const span: CitedSpan = { text: e.text, citedTexts: e.citedTexts, sourceIds: [] };
        if (!span.citedTexts.length) continue;
        spans++;
        const complete = span.citedTexts.every((c) => !isTruncated(c));
        const excerptAll = new Set(span.citedTexts.flatMap((c) => [c, joinSplitDigits(c)]).flatMap((c) => [...c.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((x) => canon(x[0]))));
        // Prices/percentages in the excerpts, as written, for realistic wrong-row swaps.
        const excerptPrices = span.citedTexts.flatMap((c) => numbersIn(joinSplitDigits(c)));
        let from = 0;
        for (const original of numbersIn(span.text)) {
          const at = span.text.indexOf(original, from);
          from = at + original.length;
          const value = Number(canon(original));
          if (!Number.isFinite(value) || value === 0) continue;
          prices++;
          if (complete) pricesComplete++;

          for (const f of FACTORS) {
            const wrong = reformat(original, value * f);
            if (canon(wrong) !== canon(original) && !excerptAll.has(canon(wrong))) {
              cases.push({ kind: "made-up", complete, caught: caughtAfterReplacing(span, original, at, wrong) });
              break;
            }
          }
          const other = excerptPrices.find((p) => kindOf(p) === kindOf(original) && canon(p) !== canon(original));
          if (other) cases.push({ kind: "wrong-row", complete, caught: caughtAfterReplacing(span, original, at, other) });
        }
      }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const caught = (xs: Case[]) => `${xs.filter((x) => x.caught).length} / ${xs.length} (${pct(xs.filter((x) => x.caught).length, xs.length)})`;
const made = cases.filter((c) => c.kind === "made-up");
const row = cases.filter((c) => c.kind === "wrong-row");
console.log(`Cited sentences scanned: ${spans}; prices and percentages in them: ${prices}\n`);
console.log(`MEASURED  share of prices whose cited excerpts are all complete: ${pricesComplete} / ${prices} (${pct(pricesComplete, prices)})`);
console.log(`          = the guard's expected recall on a made-up price in answers like these.\n`);
console.log(`Checks (by design, confirm the code does what the rules say):`);
console.log(`  made-up price, excerpts complete      caught ${caught(made.filter((c) => c.complete))}   (expected 100%)`);
console.log(`  made-up price, an excerpt cut off     caught ${caught(made.filter((c) => !c.complete))}   (expected 0%)`);
console.log(`  made-up price, all                    caught ${caught(made)}`);
console.log(`  wrong row (same-kind price, same page) caught ${caught(row)}   (expected 0%: the check is "is it in the excerpt", not "which row")`);
