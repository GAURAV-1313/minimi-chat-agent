import { test } from "node:test";
import assert from "node:assert/strict";
import { canon, checkNumbers, numbersIn } from "./guard.ts";

test("finds money and percentages, not years or plain counts", () => {
  assert.deepEqual(numbersIn("As of 11 Nov 2026, Pro is $1,200/yr for 20 seats, up 12.5% and €15."), ["$1,200", "12.5%", "€15"]);
});
test("canonical form ignores separators and trailing zeros", () => {
  assert.equal(canon("$1,200.00"), "1200");
  assert.equal(canon("12.50 %"), "12.5");
});
test("number present in a complete excerpt is verified; missing one is flagged", () => {
  const r = checkNumbers([
    { text: "Pipedrive Advanced is $34 per seat.", citedTexts: ["Advanced $34 per seat/month billed annually"], sourceIds: [1] },
    { text: "HubSpot Starter is $20 per seat.", citedTexts: ["Starter Customer Platform starts at $15/mo/seat"], sourceIds: [2] },
  ]);
  assert.equal(r.verified, 1);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].value, "$20");
});
test("a number hidden behind a truncated excerpt is unverifiable, not flagged", () => {
  // Real excerpt shape from the eval: the API cuts cited_text at ~150 chars.
  const r = checkNumbers([
    { text: "Professional is $90 per seat (list $100).", citedTexts: ["Paid plans start at **$7 per seat per month for Starter**, **$90 per seat for Profe..."], sourceIds: [1] },
  ]);
  assert.equal(r.verified, 1); // $90 is visible
  assert.equal(r.flagged.length, 0);
  assert.equal(r.unverifiable, 1); // $100 might be past the cut
});
test("uncited sentences are not checked here", () => {
  assert.equal(checkNumbers([{ text: "It costs $99.", citedTexts: [], sourceIds: [] }]).flagged.length, 0);
});

test("prices rendered digit by digit still match (real Mercury excerpt)", () => {
  const excerpt = "*Treasury is unlocked with $250K Mercury balance\n\n# Mercury Plus\n$\n\n2 3\n\n9 5\n\n$2 9.9 0/mo.";
  const r = checkNumbers([{ text: "Plus is $29.90/mo.", citedTexts: [excerpt], sourceIds: [1] }]);
  assert.equal(r.flagged.length, 0);
  assert.equal(r.verified, 1);
});
