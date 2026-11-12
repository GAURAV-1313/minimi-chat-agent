// Step 4: a deterministic check, no LLM. Every price or percentage in a cited sentence is compared with the exact
// source text that sentence cites (the API's `cited_text`). Our past research agents' LLM judges missed every wrong
// number; plain string matching does not.
//
// v2 (see DECISIONS.md #7): `cited_text` is capped at ~150 characters, and 55% of excerpts in our eval runs were
// truncated ("...$90 per seat for Profe..."). v1 flagged every number it could not see, so most warnings were false
// alarms. v2 flags a number only when every excerpt it cites is complete and the number is not in any of them.
// Numbers behind a truncated excerpt are counted as "unverifiable": tracked in metrics, not shown as a warning.

export type CitedSpan = { text: string; citedTexts: string[]; sourceIds: number[] };
export type Unverified = { value: string; sentence: string; sourceIds: number[] };
export type GuardResult = { flagged: Unverified[]; verified: number; unverifiable: number };

// Money ($15, €1,200, ₹999, $15.50, $1.5M), "15 USD", and percentages (12%, 12.5 %).
const NUMBER_RE = /(?:[$€£₹¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB]\b)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|USD\b|EUR\b|GBP\b|INR\b))/g;
// Cut off at either end: "…$90 per seat for Profe..." or "...$10 per seat". Either way, part of the source is missing.
const TRUNCATED_RE = /(?:^\s*(?:\.\.\.|…))|(?:(?:\.\.\.|…)\s*$)/;

/** Canonical digits for a match: "$1,200.00" -> "1200", "12.5 %" -> "12.5". */
export function canon(v: string): string {
  const n = v.replace(/[^\d.]/g, "").replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return n.replace(/\.$/, "");
}

export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => m[0].trim());
}

export const isTruncated = (excerpt: string) => TRUNCATED_RE.test(excerpt);

/**
 * Some pricing pages render each digit in its own element, so the excerpt reads "$2 9.9 0/mo." for $29.90.
 * Join digits split by whitespace before matching (10 of the 16 v2 flags in our runs were this, all on one page).
 */
export const joinSplitDigits = (t: string) => t.replace(/(?<=[\d.])[ \t]+(?=[\d.])/g, "");

export function checkNumbers(spans: CitedSpan[]): GuardResult {
  const out: GuardResult = { flagged: [], verified: 0, unverifiable: 0 };
  for (const s of spans) {
    if (!s.citedTexts.length) continue;
    const seen = new Set(
      s.citedTexts.flatMap((t) => [t, joinSplitDigits(t)]).flatMap((t) => [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => canon(m[0]))),
    );
    const allComplete = s.citedTexts.every((t) => !isTruncated(t));
    for (const v of numbersIn(s.text)) {
      if (seen.has(canon(v))) out.verified++;
      else if (allComplete) out.flagged.push({ value: v, sentence: s.text.trim().slice(0, 200), sourceIds: s.sourceIds });
      else out.unverifiable++;
    }
  }
  return out;
}
